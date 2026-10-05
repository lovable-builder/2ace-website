"""
Furgonetka.pl REST API client for 2ACE sp. z o.o.

Environments (from the official docs):
    production : https://api.furgonetka.pl
    sandbox    : https://api.sandbox.furgonetka.pl

Auth: OAuth2 "password" grant (Furgonetka's recommendation for custom
integrations). Client ID/Secret go in HTTP Basic; the account login and
password go in the body. Access token lives 30 days, refresh token 3 months.

Config comes from environment variables / .env -- never hardcode secrets:
    FURGONETKA_ENV            production | sandbox   (default: sandbox)
    FURGONETKA_CLIENT_ID
    FURGONETKA_CLIENT_SECRET
    FURGONETKA_USERNAME
    FURGONETKA_PASSWORD
"""
from __future__ import annotations

import json
import os
import pathlib
import time
from typing import Any

import requests

BASE = {
    "production": "https://api.furgonetka.pl",
    "sandbox": "https://api.sandbox.furgonetka.pl",
}

TOKEN_CACHE = pathlib.Path(
    os.getenv("FURGONETKA_TOKEN_CACHE", "~/.furgonetka-token.json")
).expanduser()

# The API is versioned through the media type, not the URL.
ACCEPT_V1 = "application/vnd.furgonetka.v1+json"
ACCEPT_V2 = "application/vnd.furgonetka.v2+json"


class FurgonetkaError(RuntimeError):
    def __init__(self, status: int, payload: Any):
        self.status = status
        self.payload = payload
        super().__init__(f"HTTP {status}: {json.dumps(payload, ensure_ascii=False)[:800]}")


def _load_dotenv(path: str = ".env") -> None:
    p = pathlib.Path(path)
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


class Furgonetka:
    def __init__(self, env: str | None = None, accept: str = ACCEPT_V1, language: str = "pl_PL"):
        _load_dotenv()
        self.env = env or os.getenv("FURGONETKA_ENV", "sandbox")
        if self.env not in BASE:
            raise ValueError(f"env must be one of {list(BASE)}")
        self.base = BASE[self.env]
        self.accept = accept
        self.language = language
        self.client_id = os.environ["FURGONETKA_CLIENT_ID"]
        self.client_secret = os.environ["FURGONETKA_CLIENT_SECRET"]
        self.username = os.environ["FURGONETKA_USERNAME"]
        self.password = os.environ["FURGONETKA_PASSWORD"]
        self.session = requests.Session()
        self._token: dict | None = None

    # ---------------------------------------------------------------- auth
    def _cache_key(self) -> str:
        return f"{self.env}:{self.client_id}"

    def _read_cache(self) -> dict | None:
        if not TOKEN_CACHE.exists():
            return None
        try:
            data = json.loads(TOKEN_CACHE.read_text())
        except json.JSONDecodeError:
            return None
        tok = data.get(self._cache_key())
        if tok and tok.get("expires_at", 0) > time.time() + 60:
            return tok
        return None

    def _write_cache(self, token: dict) -> None:
        data = {}
        if TOKEN_CACHE.exists():
            try:
                data = json.loads(TOKEN_CACHE.read_text())
            except json.JSONDecodeError:
                data = {}
        data[self._cache_key()] = token
        TOKEN_CACHE.write_text(json.dumps(data, indent=2))
        TOKEN_CACHE.chmod(0o600)

    def _request_token(self, refresh_token: str | None = None) -> dict:
        body = {"scope": "api"}
        if refresh_token:
            body |= {"grant_type": "refresh_token", "refresh_token": refresh_token}
        else:
            body |= {
                "grant_type": "password",
                "username": self.username,
                "password": self.password,
            }
        r = self.session.post(
            f"{self.base}/oauth/token",
            auth=(self.client_id, self.client_secret),
            data=body,
            timeout=30,
        )
        if r.status_code != 200:
            payload = _safe_json(r)
            # 2FA is off on this account, but handle it rather than fail blind.
            if isinstance(payload, dict) and payload.get("error") == "2fa_required":
                raise FurgonetkaError(
                    r.status_code,
                    {**payload, "hint": "Two-step login is on; finish it via POST /oauth/2fa"},
                )
            raise FurgonetkaError(r.status_code, payload)
        tok = r.json()
        tok["expires_at"] = time.time() + int(tok.get("expires_in", 0))
        self._write_cache(tok)
        return tok

    def token(self) -> str:
        if self._token is None:
            self._token = self._read_cache()
        if self._token is None:
            self._token = self._request_token()
        return self._token["access_token"]

    # ------------------------------------------------------------- plumbing
    def call(self, method: str, path: str, *, json_body: Any = None, params: dict | None = None,
             accept: str | None = None, raw: bool = False):
        url = f"{self.base}{path}"
        headers = {
            "Authorization": f"Bearer {self.token()}",
            "Accept": accept or self.accept,
            "X-Language": self.language,
        }
        if json_body is not None:
            headers["Content-Type"] = accept or self.accept
        r = self.session.request(method, url, headers=headers, json=json_body,
                                 params=params, timeout=60)
        if r.status_code == 401 and self._token:
            # token expired or revoked -> one clean retry
            refresh = self._token.get("refresh_token")
            self._token = self._request_token(refresh) if refresh else self._request_token()
            headers["Authorization"] = f"Bearer {self.token()}"
            r = self.session.request(method, url, headers=headers, json=json_body,
                                     params=params, timeout=60)
        if not r.ok:
            raise FurgonetkaError(r.status_code, _safe_json(r))
        return r if raw else _safe_json(r)

    # ------------------------------------------------------------ endpoints
    def balance(self):
        """Prepaid balance. Labels are charged per shipment, so check this first."""
        return self.call("GET", "/account/balance")

    def services(self):
        """Carrier services available to this account (service_id values live here)."""
        return self.call("GET", "/account/services")

    def calculate_price(self, package: dict, services: list[int] | None = None):
        """POST /packages/calculate-price -- quote. Costs nothing."""
        body = {"package": package}
        if services:
            body["services"] = services
        return self.call("POST", "/packages/calculate-price", json_body=body)

    def validate(self, params: dict):
        """POST /packages/validate -- dry run. Use before every create."""
        return self.call("POST", "/packages/validate", json_body=params)

    def create(self, params: dict):
        """POST /packages -- creates and CHARGES the shipment. Required keys:
        pickup, receiver, service_id, parcels."""
        return self.call("POST", "/packages", json_body=params)

    def label(self, package_id: int, out_path: str | None = None) -> bytes:
        """GET /packages/{id}/label -- PDF (or ZPL/EPL for label printers)."""
        r = self.call("GET", f"/packages/{package_id}/label", raw=True)
        data = r.content
        if out_path:
            pathlib.Path(out_path).write_bytes(data)
        return data

    def points_map(self, **params):
        """GET /points/map -- parcel lockers / pickup points."""
        return self.call("GET", "/points/map", params=params or None)

    def packages(self, **filters):
        return self.call("GET", "/packages", params=filters or None)

    def cancel(self, package_ids: list[int]):
        return self.call("POST", "/packages/mark-as-cancelled",
                         json_body={"packages": package_ids})


def _safe_json(r: requests.Response):
    try:
        return r.json()
    except ValueError:
        return {"_raw": r.text[:2000], "_content_type": r.headers.get("Content-Type")}


if __name__ == "__main__":
    import sys

    api = Furgonetka()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "whoami"
    if cmd == "whoami":
        print(f"env={api.env} base={api.base}")
        print("token OK, length", len(api.token()))
        print(json.dumps(api.balance(), indent=2, ensure_ascii=False))
    elif cmd == "services":
        print(json.dumps(api.services(), indent=2, ensure_ascii=False))
    elif cmd == "quote":
        pkg = json.load(open(sys.argv[2]))
        print(json.dumps(api.calculate_price(pkg["package"], pkg.get("services")),
                         indent=2, ensure_ascii=False))
    elif cmd == "validate":
        print(json.dumps(api.validate(json.load(open(sys.argv[2]))),
                         indent=2, ensure_ascii=False))
    elif cmd == "create":
        print(json.dumps(api.create(json.load(open(sys.argv[2]))),
                         indent=2, ensure_ascii=False))
    elif cmd == "label":
        pid = int(sys.argv[2])
        out = sys.argv[3] if len(sys.argv) > 3 else f"label-{pid}.pdf"
        api.label(pid, out)
        print("saved", out)
    else:
        print(__doc__)
