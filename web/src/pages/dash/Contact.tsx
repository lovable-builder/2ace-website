import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { useAccount } from '../../state/account';
import { callFn, errText } from '../../lib/api';
import { loginUrl } from '../../lib/session';
import { ErrLine, Field } from '../../ui';
import { leave } from '../../lib/nav';

// A request to our team from inside the dashboard: a topic and a pre-filled message, sent to the request-help function.
// i18n
export const TOPICS = [
  { k: 'inbound', label: 'Book an inbound delivery', tpl: 'I would like to book an inbound delivery.\n\nWhat is arriving: \nNumber of pallets or cartons: \nSupplier or country of origin: \nCarrier and tracking number (if known): \nPreferred arrival date: ' },
  { k: 'products', label: 'Add my products', tpl: 'I would like to add my products.\n\nNumber of products (SKUs): \nI can send them as: CSV / Excel / other: \nProducts that still need dimensions or customs codes: ' },
  { k: 'imports', label: 'Import and customs quote', tpl: 'I would like a quote for importing goods.\n\nGoods and customs (HS) codes if known: \nValue of the shipment: \nOrigin country and port or airport: \nSea, air or road: \nExpected shipping date: ' },
  { k: 'team', label: 'Add team members', tpl: 'Please add these colleagues to my account.\n\nName, email and role (operations, finance or marketing): ' },
  { k: 'domain', label: 'Domain question', tpl: 'My question about my domain: ' },
  { k: 'plan', label: 'Change my plan', tpl: 'I would like to change my plan.\n\nWhat I want to change: ' },
  { k: 'billing', label: 'Billing and invoices', tpl: 'My question about billing or an invoice: ' },
  { k: 'other', label: 'Something else', tpl: '' },
] as const;
export type Topic = (typeof TOPICS)[number]['k'];

export function Contact({ topic, onClose }: { topic: Topic; onClose: () => void }) {
  const t = useT();
  const a = useAccount();
  const tpl = (k: string) => t(TOPICS.find((x) => x.k === k)?.tpl ?? '');
  const [subject, setSubject] = useState<string>(topic);
  const [msg, setMsg] = useState(tpl(topic));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    box.current?.querySelector<HTMLElement>('select, textarea, button')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const pick = (k: string) => {
    // Swap the template only while the customer has not written anything of their own.
    const untouched = !msg.trim() || msg === tpl(subject);
    setSubject(k); if (untouched) setMsg(tpl(k));
  };
  const send = async () => {
    if (busy) return;
    if (!a.session) { leave.to(loginUrl('/app/dashboard')); return; }
    const mine = msg.trim();
    if (mine.length < 5 || mine === tpl(subject).trim()) return setErr(t('Please fill in a few details so we can help you faster.'));
    setBusy(true); setErr('');
    try {
      const r = await callFn('request-help', { subject, message: mine });
      if (!r.ok) throw new Error(r.data.error || t('We could not send your request. Please try again.'));
      setDone(true); setMsg('');
    } catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  };
  const replyTo = a.email || t('your account email');

  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={t('Contact us')} ref={box} onClick={(e) => e.stopPropagation()}>
        <div className="spread"><span className="h3">{t('Contact us')}</span><button className="xbtn" onClick={onClose} aria-label={t('Close')}>×</button></div>
        {done ? (
          <div className="stack-sm">
            <strong>{t('Request sent.')}</strong>
            <p className="sub">{t('Thank you. We reply to {email} within one working day.', { email: replyTo })}</p>
            <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={onClose}>{t('Close')}</button>
          </div>
        ) : (
          <>
            <Field label={t('What do you need?')}>
              <select value={subject} onChange={(e) => pick(e.target.value)}>{TOPICS.map((x) => <option key={x.k} value={x.k}>{t(x.label)}</option>)}</select>
            </Field>
            <Field label={t('Your message')}><textarea rows={9} value={msg} onChange={(e) => { setMsg(e.target.value); setErr(''); }} /></Field>
            <span className="small">{t('We already have your company and plan. We reply to {email}.', { email: replyTo })}</span>
            <ErrLine text={err} />
            <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={send} disabled={busy}>{busy ? t('Sending…') : t('Send request')}</button>
          </>
        )}
      </div>
    </div>
  );
}
