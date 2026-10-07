import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useT } from '../../i18n';
import { useAccount } from '../../state/account';
import { callFn, errText, fn } from '../../lib/api';
import { ErrLine, Tick } from '../../ui';
import { leave } from '../../lib/nav';

type Info = { eligible: boolean; reason?: string; free?: boolean; fee?: number; domains?: { domain: string; status: string }[] };
type Status = null | 'checking' | 'free' | 'taken' | 'invalid' | 'empty' | 'unchecked' | 'accept' | 'unknown' | 'limited' | 'busy' | 'error';

// i18n
const MSG: Record<string, string> = {
  null: 'Pick a name, then click Check. We check it against the .pl registry.', checking: 'Checking {name}.pl…', free: '{name}.pl looks available.',
  taken: '{name}.pl is already registered. Try another name.', takenAlts: '{name}.pl is already registered. Try:',
  invalid: 'Use 2 to 63 letters, numbers or hyphens, with no hyphen at the start or end.', empty: 'Enter a name first.',
  unchecked: 'Click Check first to make sure {name}.pl is available.', accept: 'Please tick the box to accept Hostinger\'s agreement.',
  unknown: 'We could not reach the registry. Please try again.', limited: 'Too many checks. Please wait a minute.', busy: 'Working on it…', error: 'Something went wrong.',
};

// A .pl domain for customers with an active plan, registered in their company's name. Paid through Stripe unless the plan includes it.
export function Domain() {
  const t = useT();
  const a = useAccount();
  const [sp] = useSearchParams();
  const back = sp.get('domain');
  const [info, setInfo] = useState<Info | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [note, setNote] = useState(back === 'success' ? t('Payment received. We are registering your domain and will email you within one working day.') : back === 'cancelled' ? t('Payment cancelled. Nothing was charged.') : '');
  const [name, setName] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const [alts, setAlts] = useState<string[]>([]);
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const token = useRef(0);

  const load = () => fn<Info>('domain-checkout', { action: 'info' });
  useEffect(() => {
    let stop = false, timer: ReturnType<typeof setTimeout> | undefined;
    if (back === 'success') {
      // Back from Stripe: the webhook records the order within seconds. Ask until it shows.
      let tries = 0;
      const tick = async () => {
        tries += 1;
        try { const i = await load(); if (stop) return; setInfo(i); setLoadErr(''); if (!i.eligible && i.reason === 'has_domain') { void a.reload(); return; } } catch { /* keep waiting */ }
        if (tries < 12 && !stop) timer = setTimeout(tick, 3000);
      };
      timer = setTimeout(tick, 1500);
    } else load().then((i) => { if (!stop) setInfo(i); }).catch((e) => { if (!stop) setLoadErr(errText(e)); });
    return () => { stop = true; clearTimeout(timer); };
  }, [back]); // once per visit

  const check = async (n: string) => {
    n = n.trim();
    if (n.length < 2) { setStatus('empty'); setAlts([]); return; }
    setStatus('checking'); setAlts([]);
    const my = ++token.current;
    try {
      const r = await callFn<{ status?: Status; alternatives?: string[] }>('domain-check', { name: n }, { auth: false });
      if (my !== token.current) return;
      if (r.status === 429) return setStatus('limited');
      if (!r.ok) return setStatus('unknown');
      setStatus(r.data.status || 'unknown'); setAlts(r.data.alternatives || []);
    } catch { if (my === token.current) setStatus('unknown'); }
  };
  const go = async () => {
    if (busy) return;
    if (status !== 'free') return setStatus(name.length < 2 ? 'empty' : 'unchecked');
    if (!accept) return setStatus('accept');
    setBusy(true);
    try {
      const out = await fn<{ url?: string }>('domain-checkout', { name, accept: true });
      if (out.url) { leave.to(out.url); return; }
      setNote(t('Request sent. We register {name}.pl for you and email you within one working day.', { name }));
      setName(''); setStatus(null); setBusy(false);
      void a.reload(); load().then(setInfo).catch(() => {});
    } catch (e) { setBusy(false); setStatus('error'); setErr(errText(e)); }
  };

  const key = status === 'taken' && alts.length ? 'takenAlts' : String(status);
  const msg = status === 'error' ? err || t(MSG.error) : t(MSG[key] ?? MSG.null, { name });
  const color = status === 'free' ? '#2F7D55' : ['taken', 'invalid', 'empty', 'unchecked', 'accept', 'error'].includes(String(status)) ? '#B4442E' : 'rgba(11,12,14,0.6)';
  const intro = !info ? '' : info.eligible ? (info.free ? t('Your plan includes a .pl domain. Pick a name and we register it in your company name.') : t('Get a .pl domain for {fee} zł one-time (excl. VAT), first year included. We register it in your company name.', { fee: info.fee ?? 99 }))
    : info.reason === 'has_domain' ? t('Your domain and its status.') : t('Domains can be added once your plan is active.');

  return (
    <div className="stack narrow">
      <div><h1 className="h1">{t('Your .pl domain')}</h1>{intro ? <p className="sub" style={{ marginTop: 8 }}>{intro}</p> : null}</div>
      {note ? <div role="status" className="note">{note}</div> : null}
      {!info && !loadErr ? <p className="small">{t('Loading…')}</p> : null}
      <ErrLine text={loadErr} />
      {info && !info.eligible && info.reason === 'has_domain' ? (
        <div className="list">{(info.domains || []).map((d) => (
          <div className="item" key={d.domain}><strong>{d.domain}</strong><span className="meta">{d.status === 'registered' ? t('Registered') : t('We are registering it. You will get an email within one working day.')}</span></div>
        ))}</div>
      ) : null}
      {info?.eligible ? (
        <div className="card stack-sm">
          <span className="h3">{t('Choose a name')}</span>
          <div className="domainrow">
            <span className="suffix"><input aria-label={t('Domain')} value={name} maxLength={63} placeholder="yourbrand" onChange={(e) => { setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')); setStatus(null); setAlts([]); }} /><span>.pl</span></span>
            <button className="btn dark" onClick={() => check(name)}>{t('Check')}</button>
          </div>
          <p className="small" style={{ color }} role="status">{msg}</p>
          {alts.length ? <div className="row">{alts.map((n) => <button key={n} className="chip" onClick={() => { setName(n); void check(n); }}>{n}.pl</button>)}</div> : null}
          <Tick on={accept} onToggle={() => { setAccept(!accept); if (status === 'accept') setStatus('free'); }}>{t('Your domain is registered through Hostinger, in your company\'s name. I accept Hostinger\'s Domain Name Registration Agreement.')}</Tick>
          <a className="linkbtn" href="https://www.hostinger.com/legal/domain-name-registration-agreement" target="_blank" rel="noopener">{t('Read Hostinger\'s agreement →')}</a>
          <button className="btn" style={{ alignSelf: 'flex-start', opacity: status === 'free' && accept && !busy ? 1 : 0.5 }} onClick={go}>
            {busy ? t('Please wait…') : info.free ? t('Request my included domain') : t('Pay {fee} zł and request', { fee: info.fee ?? 99 })}
          </button>
        </div>
      ) : null}
    </div>
  );
}
