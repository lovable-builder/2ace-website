import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useT, type T } from '../i18n';
import { useAccount } from '../state/account';
import { usePlan, type DomainStatus, type PlanState } from '../state/plan';
import { usePrefill } from '../state/prefill';
import { estimateM2, mkRange, planM2, pricing, STORAGE, STOREFRONT, type EstSize } from '../lib/pricing';
import { COUNTRIES, countryOf } from '../lib/countries';
import { fmt, m2fmt } from '../lib/format';
import { errText, fn } from '../lib/api';
import { MSG } from '../lib/messages';
import { loginUrl } from '../lib/session';
import { tariffText, useTariff } from '../lib/tariff';
import { ErrLine, Field, scrollTop, useToast } from '../ui';
import { leave } from '../lib/nav';

const SLUGS = ['', 'services', 'sell', 'review'];
// i18n
const STEP_NAMES = ['Space', 'Services', 'Sell', 'Review'];
// i18n
const NEXT_LABEL = ['Continue to services', 'Continue to sell', 'Continue to review'];
// i18n
const LANG_NAMES = ['Polish', 'English', 'German', 'Czech'];
// i18n
const IMPORT_POINTS = ['Air, sea and road freight booked for you', 'Customs clearance, duty and import VAT handled', 'CE and EU labelling checks before goods ship', 'Every milestone tracked in your dashboard'];
const emailOk = (e: string) => /.+@.+\..+/.test(e);
export const companyOk = (p: PlanState) => !!p.company.trim() && p.vat.trim().length >= 5 && emailOk(p.email);

type Preview = { kind: 'upgrade' | 'downgrade' | 'same'; delta: number; newMonthly: number; todayEstimate: number; onceToCharge?: number; configChange?: boolean };

// Build a plan: Space, Services, Sell, Review. With ?change=1 the same steps change the customer's active plan instead.
export function Builder() {
  const t = useT();
  const nav = useNavigate();
  const toast = useToast();
  const a = useAccount();
  const plan = usePlan();
  const { active: p, update, change, startChange, endChange, checkDomain, forget } = plan;
  const { step: slug } = useParams();
  const [sp] = useSearchParams();
  const step = Math.max(0, SLUGS.indexOf(slug ?? ''));
  const wantChange = sp.get('change') === '1';
  const changeMode = wantChange && !!change;
  const [loadErr, setLoadErr] = useState('');
  usePrefill();

  // Enter change mode from the URL once the current plan is known; leave it when the URL no longer asks for it.
  useEffect(() => {
    if (wantChange && !change && a.loaded) {
      if (a.curPlan) { setLoadErr(''); startChange(a.curPlan.config); }
      else setLoadErr(t('We could not load your current plan. Please reload the page.'));
    }
    if (!wantChange && change) endChange();
  }, [wantChange, change, a.loaded, a.curPlan, startChange, endChange, t]);

  const to = (i: number) => '/plan' + (SLUGS[i] ? '/' + SLUGS[i] : '') + (wantChange ? '?change=1' : '');
  const go = (i: number) => { nav(to(i)); scrollTop(); };

  const P = pricing(p);
  const cur = a.curPlan;
  const addingStore = p.storeOn && !cur?.config?.storeOn;
  const needDomain = changeMode ? addingStore && !a.hasDomain : p.storeOn;
  const haveDomain = changeMode && p.storeOn && a.hasDomain && !cur?.config?.storeOn;

  // ---- changing an active plan: the server prices the change on the Review step ----
  const [chPrev, setChPrev] = useState<Preview | null>(null);
  const [chBusy, setChBusy] = useState(false);
  const [chErr, setChErr] = useState('');
  const snap = JSON.stringify([p.qty, p.pkgs, p.storeOn, p.domain, p.marketOn]);
  const snapRef = useRef(snap); snapRef.current = snap;
  const lastSnap = useRef(snap);
  useEffect(() => {   // any change to the plan makes the old price stale
    if (snap === lastSnap.current) return;
    lastSnap.current = snap;
    setChPrev(null); setChErr('');
  }, [snap]);
  const chConfig = () => ({ m2: p.qty, pkgs: p.pkgs, storeOn: p.storeOn, domain: addingStore && !a.hasDomain ? p.domain : '', tt: 'off', meta: 'off', marketOn: p.marketOn });
  const chCall = async (preview: boolean) => {
    if (!a.session) { leave.to(loginUrl('/app/dashboard')); throw new Error(MSG.signedOut); }
    return fn<Preview>('change-plan', { config: chConfig(), preview });
  };
  useEffect(() => {
    if (!changeMode || step !== 3 || chPrev || chBusy || chErr) return;
    const at = snap;
    setChBusy(true);
    chCall(true)
      .then((out) => { if (snapRef.current === at) setChPrev(out); })
      .catch((e) => setChErr(errText(e)))
      .finally(() => setChBusy(false));
  }, [changeMode, step, chPrev, chBusy, chErr, snap]); // chCall reads the current plan; `snap` stands for it

  const chApply = async () => {
    if (chBusy) return;
    if (!chPrev) { if (chErr) setChErr(''); return; }   // after an error, clearing it makes the Review step price the change again
    setChBusy(true); setChErr('');
    try {
      const out = await chCall(false);
      await a.reload().catch(() => a);                    // the dashboard must never flash the old price
      const price = fmt(out.newMonthly);
      const done = out.kind === 'same' ? t('Your plan was updated. Your monthly price stays {price}.', { price })
        : out.kind === 'upgrade' ? t('Your plan was upgraded. Your new price is {price} per month.', { price })
          : out.kind === 'downgrade' ? t('Your plan was downgraded. Your new price is {price} per month.', { price })
            : t('Your plan was updated. Your new price is {price} per month.', { price });
      // Leave the builder first: ending change mode while still on ?change=1 would start it again.
      forget(); nav('/dashboard', { state: { chDone: done } }); endChange(); scrollTop();
    } catch (e) { setChErr(errText(e)); setChBusy(false); }
  };

  const next = () => {
    if (step === 2 && needDomain && p.domainStatus !== 'free' && p.domainStatus !== 'unknown') {
      const s: DomainStatus = p.domain.length < 2 ? 'empty' : p.domainStatus === 'taken' || p.domainStatus === 'checking' || p.domainStatus === 'invalid' ? p.domainStatus : 'unchecked';
      update({ domainStatus: s });
      return;
    }
    if (step < 3) return go(step + 1);
    if (changeMode) return void chApply();
    if (!companyOk(p)) return update({ tried: true });
    nav(a.session ? '/checkout/agreement' : '/checkout'); scrollTop();
  };

  const cta = step === 3 && changeMode
    ? (chBusy ? t('Please wait…') : chErr && !chPrev ? t('Try again') : chPrev ? (chPrev.kind === 'upgrade' ? t('Confirm upgrade') : chPrev.kind === 'downgrade' ? t('Confirm downgrade') : t('Confirm change')) : t('Calculating…'))
    : step === 3 ? (a.session ? t('Continue to agreement and payment') : t('Continue to sign-up')) : t(NEXT_LABEL[step]);

  // the live comparison with the current plan, before the server has priced it
  const liveDelta = cur ? P.monthly - cur.monthly : 0;
  const liveKind = liveDelta > 0 ? 'upgrade' : liveDelta < 0 ? 'downgrade' : 'same';
  const cc0 = cur?.config ?? {};
  const cfgDiff = !!cur && (Number(p.qty) !== planM2(cc0) || !!p.pkgs.imp !== !!cc0.pkgs?.imp || !!p.storeOn !== !!cc0.storeOn || !!p.marketOn !== !!cc0.marketOn);
  const liveBadge = liveKind === 'upgrade' ? t('Upgrade +{price}', { price: fmt(Math.abs(liveDelta)) }) : liveKind === 'downgrade' ? t('Downgrade −{price}', { price: fmt(Math.abs(liveDelta)) }) : cfgDiff ? t('No price change') : t('No change');
  const badgeBg = liveKind === 'upgrade' ? '#2F7D55' : liveKind === 'downgrade' ? '#8A5A12' : '#6B6E73';
  const monthly = a.activated && cur && !changeMode ? cur.monthly : P.monthly;

  return (
    <main className="page">
      {wantChange && loadErr ? <div className="warnbox" style={{ marginBottom: 20 }}>{loadErr}</div> : null}
      {changeMode && cur ? (
        <div className="card strong spread" style={{ marginBottom: 20, padding: '14px 18px' }}>
          <span style={{ fontSize: 15 }}><strong>{t('Changing your plan.')}</strong> {t('Current: {cur} / month. New: {next} / month.', { cur: fmt(cur.monthly), next: fmt(P.monthly) })}</span>
          <span className="row">
            <span className="pill" style={{ background: badgeBg, color: '#FFFFFF' }}>{liveBadge}</span>
            <button className="btn ghost small" onClick={() => { endChange(); nav('/dashboard'); scrollTop(); }}>{t('Cancel change')}</button>
          </span>
        </div>
      ) : null}
      {a.activated && !wantChange ? <OwnedNotice /> : null}
      <p className="eyebrow">{t('Build your 2ACE plan')}</p>
      <h1 className="display">{t('Space, service, storefront and sales. Priced in front of you.')}</h1>
      <p className="lead">{t('No quote calls. Every choice updates your price live, and you can change anything later from the dashboard.')}</p>

      <nav className="steps" aria-label={t('Steps')}>
        {STEP_NAMES.map((n, i) => (
          <Link key={n} to={to(i)} className={i === step ? 'here' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}>
            <span className="n">0{i + 1}</span><span className="t">{t(n)}</span>
          </Link>
        ))}
      </nav>

      <div className="with-aside">
        <div className="body">
          {step === 0 ? <SpaceStep p={p} update={update} t={t} onEstimate={(n) => toast(t('Set to {n} m².', { n }))} /> : null}
          {step === 1 ? <ServicesStep p={p} update={update} t={t} /> : null}
          {step === 2 ? <SellStep p={p} update={update} t={t} checkDomain={checkDomain} needDomain={!changeMode || needDomain} haveDomain={haveDomain} /> : null}
          {step === 3 ? (
            <div className="stack">
              <div>
                <h2 className="h2">{changeMode ? t('Review your change.') : t('Review and activate.')}</h2>
                <p className="sub">{changeMode ? t('Check the difference below. You confirm once and the new plan starts straight away.') : t('Monthly, no minimum term. Your account manager calls within one working day to book your first inbound.')}</p>
              </div>
              <ReviewLines p={p} t={t} />
              {changeMode && cur ? (
                <div className="card stack-sm">
                  <div className="spread"><span className="h3">{t('Your change')}</span><span className="pill" style={{ background: badgeBg, color: '#FFFFFF' }}>{(chPrev ? chPrev.kind : liveKind) === 'upgrade' ? t('Upgrade') : (chPrev ? chPrev.kind : liveKind) === 'downgrade' ? t('Downgrade') : (chPrev ? chPrev.configChange : cfgDiff) ? t('No price change') : t('No change')}</span></div>
                  {chBusy && !chPrev ? <span className="small">{t('Calculating…')}</span> : null}
                  {chPrev ? (
                    <>
                      <div className="kv"><span>{t('Current plan')}</span><span>{t('{price} / month', { price: fmt(cur.monthly) })}</span></div>
                      <div className="kv"><span>{t('New plan')}</span><span>{t('{price} / month', { price: fmt(chPrev.newMonthly) })}</span></div>
                      <div className="kv"><span>{t('Difference')}</span><span>{t('{price} / month', { price: (chPrev.delta > 0 ? '+' : chPrev.delta < 0 ? '−' : '') + fmt(Math.abs(chPrev.delta)) })}</span></div>
                      <p style={{ fontSize: 15 }}>{todayText(chPrev, t)}</p>
                      <p className="small">{t('The change applies immediately and uses the payment method on your account. Prices exclude VAT. There is no minimum term.')}</p>
                    </>
                  ) : null}
                  <ErrLine text={chErr} />
                </div>
              ) : null}
              {!wantChange ? <CompanyForm p={p} update={update} t={t} /> : null}
            </div>
          ) : null}
          <div className="actions">
            <button className="btn ghost" style={{ visibility: step === 0 ? 'hidden' : 'visible' }} onClick={() => go(Math.max(0, step - 1))}>{t('Back')}</button>
            <button className="btn" onClick={next} disabled={wantChange && !changeMode}>{cta}</button>
          </div>
        </div>
        <aside className="summary" aria-label={t('Your plan')}>
          <span className="eyebrow">{t('Your plan')}</span>
          <div>
            {P.lines.map((l, i) => (
              <div className="sline" key={l.key}>
                <span>{(i ? '+ ' : '') + t(l.label, l.vars)}</span>
                <span>{l.commission ? t('{range} / sale', { range: mkRange() }) : l.quote ? t('On quote') : l.monthly ? fmt(l.monthly) : t('{price} once', { price: fmt(l.once) })}</span>
              </div>
            ))}
          </div>
          <div><span className="meta">{t('MONTHLY')}</span><span className="big">{fmt(monthly)}</span></div>
          <span className="meta">{t('One-time setup · {price}', { price: fmt(P.once) })}</span>
          <button className="btn" onClick={next} disabled={wantChange && !changeMode}>{cta}</button>
        </aside>
      </div>
    </main>
  );
}

function todayText(c: Preview, t: T) {
  if (c.kind === 'same') return t('Your monthly price stays {price}. Nothing is charged today. Market is a commission on each sale and Import & customs is quoted per shipment, so they do not change the monthly price.', { price: fmt(c.newMonthly) });
  if (c.todayEstimate >= 0) {
    return c.onceToCharge
      ? t('Charged today: about {today} (the price difference for the rest of this billing period, plus {once} one-time setup). From your next invoice you pay {price} a month.', { today: fmt(c.todayEstimate), once: fmt(c.onceToCharge), price: fmt(c.newMonthly) })
      : t('Charged today: about {today} (the price difference for the rest of this billing period). From your next invoice you pay {price} a month.', { today: fmt(c.todayEstimate), price: fmt(c.newMonthly) });
  }
  return t('You get a credit of about {credit} on your next invoice for the unused part of this period. From then on you pay {price} a month.', { credit: fmt(Math.abs(c.todayEstimate)), price: fmt(c.newMonthly) });
}

export function OwnedNotice() {
  const t = useT();
  return (
    <div className="spread" style={{ padding: '14px 18px', margin: '0 0 20px', background: '#0B0C0E', color: '#F5F4F1', borderRadius: 4 }}>
      <span style={{ fontSize: 15 }}><strong style={{ color: '#E39A2B' }}>{t('You already have an active plan.')}</strong> {t('Change it here, or manage payment and invoices in Billing.')}</span>
      <span className="row">
        <Link className="btn small" to="/plan?change=1">{t('Change plan')}</Link>
        <Link className="btn on-dark small" to="/dashboard">{t('Dashboard')}</Link>
        <a className="btn on-dark small" href="/account">{t('Billing')}</a>
      </span>
    </div>
  );
}

type StepProps = { p: PlanState; update: (x: Partial<PlanState>) => void; t: T };

function SpaceStep({ p, update, t, onEstimate }: StepProps & { onEstimate: (n: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const filled = Math.min(80, Math.max(1, Math.round(p.qty)));   // each square is 1 m²; the picture is full at 80 m²
  const est = estimateM2(Number(p.estUnits) || 0, p.estSize);
  const commit = () => {
    const v = Number(draft);
    const q = draft == null || draft === '' || !v ? p.qty : Math.min(STORAGE.max, Math.max(STORAGE.min, Math.round(v)));
    update({ qty: q }); setDraft(null);
  };
  return (
    <div className="stack">
      <div>
        <h2 className="h2">{t('How many square metres do you need?')}</h2>
        <p className="sub">{t('Pay 300 zł per m² for the space you use. Scale up or down month to month.')}</p>
      </div>
      <div className="card">
        <div className="qty">
          <label htmlFor="qty" className="label">{t('Square metres (m²)')}</label>
          <span className="row">
            <input id="qty" type="number" min={STORAGE.min} max={STORAGE.max} value={draft ?? String(p.qty)}
              onChange={(e) => { const raw = e.target.value, v = Number(raw); setDraft(raw); if (raw !== '' && v >= STORAGE.min && v <= STORAGE.max) update({ qty: Math.round(v) }); }}
              onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
            <span className="mono">m²</span>
          </span>
        </div>
        <input type="range" aria-label={t('Square metres (m²)')} min={STORAGE.min} max={STORAGE.max} step={STORAGE.step} value={p.qty} onChange={(e) => { setDraft(null); update({ qty: Number(e.target.value) }); }} />
        <div className="cells" aria-hidden="true">{Array.from({ length: 80 }, (_, i) => <span key={i} className={i < filled ? 'on' : ''} />)}</div>
        <div className="spread small">
          <span>{t('{m2} m² reserved · 300 zł / m² storage · each square is 1 m²', { m2: m2fmt(p.qty) })}</span>
          <strong className="mono" style={{ color: '#0B0C0E' }}>{t('{price} / month', { price: fmt(Math.round(p.qty * STORAGE.price)) })}</strong>
        </div>
      </div>
      <div className="card stack-sm">
        <span className="h3" style={{ fontSize: 17 }}>{t('Not sure? Estimate from your stock')}</span>
        <div className="row">
          <input className="input" style={{ width: 130 }} type="number" min={0} aria-label={t('Units')} value={p.estUnits} onChange={(e) => { const v = e.target.value; update({ estUnits: v === '' ? '' : Math.max(0, Number(v) || 0) }); }} />
          <span>{t('units, mostly')}</span>
          {(['small', 'medium', 'large'] as EstSize[]).map((z) => (
            <button key={z} className={'chip' + (p.estSize === z ? ' on' : '')} aria-pressed={p.estSize === z} onClick={() => update({ estSize: z })}>{t(z === 'small' ? 'Small' : z === 'medium' ? 'Shoebox' : 'Bulky')}</button>
          ))}
        </div>
        <div className="spread">
          <span>{t('That is roughly')} <strong>{est} m²</strong>.</span>
          <button className="btn ghost small" onClick={() => { update({ qty: est }); setDraft(null); onEstimate(est); }}>{t('Use {n} m²', { n: est })}</button>
        </div>
      </div>
    </div>
  );
}

function ServicesStep({ p, update, t }: StepProps) {
  const tariff = useTariff();
  const on = !!p.pkgs.imp;
  return (
    <div className="stack">
      <div>
        <p className="eyebrow">{t('Services')}</p>
        <h2 className="h2">{t('What should we handle for you?')}</h2>
        <p className="sub">{t('Storage is already in your plan. Add only what you need. You can change this any month.')}</p>
      </div>
      <div className="okbox stack-sm">
        <strong>{t('Fulfilment and returns are pay as you go')}</strong>
        <p className="small">{t('There is no monthly fee for them.')} {t('Each order we ship costs {order}. Each return costs {ret}. Shipping labels are the carrier price plus a small fee. It all goes on your monthly invoice, before VAT.', { order: tariffText(tariff, 'order', t), ret: tariffText(tariff, 'return', t) })}</p>
      </div>
      <div className={'svc' + (on ? ' on' : '')}>
        <div className="spread"><span className="h3">{t('Import & customs')}</span><span className="mono small">{t('Quoted per shipment')}</span></div>
        <p className="sub">{t('We book the freight and clear customs into Poland. Cost depends on the value, origin and route of each shipment, so we quote every one before it moves.')}</p>
        <div className="ticks">
          {IMPORT_POINTS.map((x) => <span key={x}>{t(x)}</span>)}
        </div>
        <button className={'btn' + (on ? ' dark' : '')} aria-pressed={on} onClick={() => update({ pkgs: { ...p.pkgs, imp: !on } })}>{on ? t('Added ✓  Tap to remove') : t('Add import & customs')}</button>
      </div>
    </div>
  );
}

// i18n
const DOMAIN_MSG: Record<string, string> = {
  null: 'Pick a name for your store. We check it against the .pl registry.',
  checking: 'Checking {name}.pl…',
  free: '{name}.pl looks available. We confirm and register it for you when you activate your plan.',
  taken: '{name}.pl is already registered. Try another name.',
  takenAlts: '{name}.pl is already registered. Try another name or one of these:',
  empty: 'Enter a name for your store, or turn the storefront off.',
  unchecked: 'Click Check to make sure {name}.pl is available before you continue.',
  invalid: 'Use 2 to 63 letters, numbers or hyphens, with no hyphen at the start or end.',
  unknown: 'We could not reach the registry just now. Please try again in a moment.',
  limited: 'Too many checks in a row. Please wait a minute and try again.',
};

function SellStep({ p, update, t, checkDomain, needDomain, haveDomain }: StepProps & { checkDomain: (n: string) => Promise<void>; needDomain: boolean; haveDomain: boolean }) {
  const key = p.domainStatus === 'taken' && p.domainAlts.length ? 'takenAlts' : String(p.domainStatus);
  const color = p.domainStatus === 'free' ? '#2F7D55' : ['taken', 'invalid', 'empty', 'unchecked'].includes(String(p.domainStatus)) ? '#B4442E' : 'rgba(11,12,14,0.6)';
  // i18n
  const THEMES = [
    { k: 'mono', name: 'Mono', desc: 'Quiet, product first', c: ['#E7E4DE', '#0B0C0E', '#BFB9AE'] },
    { k: 'market', name: 'Market', desc: 'Bold, promo ready', c: ['#E39A2B', '#0B0C0E', '#F4D9A8'] },
    { k: 'editorial', name: 'Editorial', desc: 'Story led, big imagery', c: ['#3F4A44', '#D9D2C3', '#8C7B62'] },
  ] as const;
  return (
    <div className="stack">
      <div>
        <p className="eyebrow">{t('Sell')}</p>
        <h2 className="h2">{t('How will you sell?')}</h2>
        <p className="sub">{t('Pick either option below, both, or neither and add it later. Nothing is charged until you review and pay.')}</p>
      </div>
      <div>
        <h3 className="h3" style={{ marginBottom: 6 }}>{t('A .pl storefront, wired to your stock.')}</h3>
        <p className="sub">{t('We design, build and host it. Orders drop straight into fulfillment, stock counts come straight back.')}</p>
      </div>
      <button className={'toggle' + (p.storeOn ? ' on' : '')} role="switch" aria-checked={p.storeOn} onClick={() => update({ storeOn: !p.storeOn })}>
        <span className="stack-sm" style={{ gap: 4 }}>
          <strong>{t('Build my storefront')}</strong>
          <span className="small">{t('{setup} setup incl. domain · {monthly} / month hosting and care', { setup: fmt(STOREFRONT.once), monthly: fmt(STOREFRONT.monthly) })}</span>
        </span>
        <span className="track" aria-hidden="true" />
      </button>
      {p.storeOn ? (
        <div className="card stack">
          {needDomain && !haveDomain ? (
            <div className="stack-sm">
              <span className="label">{t('Domain')}</span>
              <div className="domainrow">
                <span className="suffix"><input aria-label={t('Domain')} value={p.domain} placeholder="yourbrand" onChange={(e) => update({ domain: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''), domainStatus: null, domainAlts: [] })} /><span>.pl</span></span>
                <button className="btn dark" onClick={() => checkDomain(p.domain)}>{t('Check')}</button>
              </div>
              <p className="small" style={{ color }} role="status">{t(DOMAIN_MSG[key] ?? DOMAIN_MSG.null, { name: p.domain })}</p>
              {p.domainAlts.length ? (
                <div className="row">{p.domainAlts.map((n) => <button key={n} className="chip" onClick={() => { update({ domain: n, domainStatus: null, domainAlts: [] }); setTimeout(() => void checkDomain(n), 0); }}>{n}.pl</button>)}</div>
              ) : null}
            </div>
          ) : null}
          {haveDomain ? <p className="sub">{t('You already have a domain with us. The new storefront will use it.')}</p> : null}
          <div className="stack-sm">
            <span className="label">{t('Starting look')}</span>
            <div className="themes">
              {THEMES.map((th) => (
                <button key={th.k} className={'theme' + (p.theme === th.k ? ' on' : '')} aria-pressed={p.theme === th.k} onClick={() => update({ theme: th.k })}>
                  <span className="sw">{th.c.map((c) => <i key={c} style={{ background: c }} />)}</span>
                  <strong>{th.name}</strong><span className="small">{t(th.desc)}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="grid-2">
            <div className="stack-sm"><span className="label">{t('Languages')}</span>
              <div className="row">{LANG_NAMES.filter((k) => k in p.langs).map((k) => <button key={k} className={'chip' + (p.langs[k] ? ' on' : '')} aria-pressed={p.langs[k]} onClick={() => update({ langs: { ...p.langs, [k]: !p.langs[k] } })}>{t(k)}</button>)}</div>
            </div>
            <div className="stack-sm"><span className="label">{t('Payments')}</span>
              <div className="row">{Object.keys(p.pays).map((k) => <button key={k} className={'chip' + (p.pays[k] ? ' on' : '')} aria-pressed={p.pays[k]} onClick={() => update({ pays: { ...p.pays, [k]: !p.pays[k] } })}>{k}</button>)}</div>
            </div>
          </div>
          <p className="small">{t('Included: hosting and SSL · live stock sync · Polish VAT invoices · GDPR and cookie consent · InPost and DPD checkout')}</p>
        </div>
      ) : <p className="sub">{t('Already selling on Shopify, WooCommerce or Allegro? We connect it during onboarding and sync stock the same way.')}</p>}
    </div>
  );
}

function ReviewLines({ p, t }: { p: PlanState; t: T }) {
  const P = pricing(p);
  return (
    <div className="card" style={{ padding: '6px 20px' }}>
      <div className="lines">
        <div className="line head"><span>{t('Item')}</span><span>{t('Detail')}</span><span>{t('Monthly')}</span><span>{t('One-time')}</span></div>
        {P.lines.map((l) => (
          <div className="line" key={l.key}>
            <span>{t(l.label, l.vars)}</span>
            <span>{t(l.detail, { m2: m2fmt(p.qty), price: fmt(STORAGE.price), ...l.vars })}</span>
            <span>{l.commission ? t('{range} / sale', { range: mkRange() }) : l.quote ? t('On quote') : l.monthly ? fmt(l.monthly) : '—'}</span>
            <span>{l.once ? fmt(l.once) : '—'}</span>
          </div>
        ))}
        <div className="line total"><span>{t('Total')}</span><span /><span>{fmt(P.monthly)}</span><span>{fmt(P.once)}</span></div>
      </div>
    </div>
  );
}

function CompanyForm({ p, update, t }: StepProps) {
  const cc = countryOf(p.country);
  const bad = p.tried;
  return (
    <div className="card stack-sm">
      <span className="h3">{t('Your company')}</span>
      <Field label={t('Country of registration')}>
        <select value={p.country} onChange={(e) => update({ country: e.target.value, vat: '' })}>
          {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{t(c.name)}</option>)}
        </select>
      </Field>
      <Field label={t('Company name')} bad={bad && !p.company.trim()} value={p.company} placeholder={t('Registered company name')} onChange={(e) => update({ company: e.target.value })} />
      <Field label={t(cc.label)} bad={bad && p.vat.trim().length < 5} value={p.vat} placeholder={cc.ph} onChange={(e) => update({ vat: e.target.value.toUpperCase() })} />
      <Field label={t('Work email')} type="email" bad={bad && !emailOk(p.email)} value={p.email} placeholder="name@yourcompany.com" onChange={(e) => update({ email: e.target.value })} />
      {bad && !companyOk(p) ? <ErrLine text={t('Add your company name, business number and a valid email to activate.')} /> : null}
    </div>
  );
}

