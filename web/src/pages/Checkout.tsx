import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useLang } from '../i18n';
import { customerName, useAccount } from '../state/account';
import { usePlan } from '../state/plan';
import { usePrefill } from '../state/prefill';
import { pricing, vatFor } from '../lib/pricing';
import { countryOf } from '../lib/countries';
import { fmt } from '../lib/format';
import { callFn, errText } from '../lib/api';
import { freshSession, loginUrl } from '../lib/session';
import { savePlan } from '../lib/planStore';
import { ErrLine, Field, Tick, scrollTop } from '../ui';
import { OwnedNotice } from './Builder';
import { leave } from '../lib/nav';

const SLUGS = ['', 'agreement', 'payment'];
// i18n
const STEPS = ['Account', 'Agreement', 'Payment'];

// Activate a new plan: account, agreement, payment on Stripe's own page.
export function Checkout() {
  const { t, lang } = useLang();
  const nav = useNavigate();
  const a = useAccount();
  const { draft: p } = usePlan();
  const { step: slug } = useParams();
  const [sp] = useSearchParams();
  const step = Math.max(0, SLUGS.indexOf(slug ?? ''));
  const [accept, setAccept] = useState(false);
  const [signName, setSignName] = useState('');
  const [tried, setTried] = useState(false);
  const [paying, setPaying] = useState(false);
  const [payErr, setPayErr] = useState('');
  const [notice, setNotice] = useState(sp.get('cancelled') === '1' ? t('Payment was cancelled, nothing was charged. Your plan is saved, so you can try again whenever you are ready.') : '');
  usePrefill();

  const signedIn = !!a.session;
  const P = pricing(p);
  const cc = countryOf(p.country);
  const company = p.company.trim() || customerName('', a);
  const net = P.monthly + P.once;
  const v = vatFor(p.country, net);
  const vatLabel = v.kind === 'pl' ? t('VAT 23%') : v.kind === 'eu' ? t('Reverse charge, 0% VAT') : t('0% VAT, outside the EU');
  const vatNote = v.kind === 'pl' ? t('Polish company, so 23% VAT is added to the invoice.')
    : v.kind === 'eu' ? t('EU company with a VAT number: you account for the VAT in {country}. We check your number in VIES.', { country: t(cc.name) })
      : t('Invoiced without Polish VAT. Import VAT on your goods is handled per shipment.');
  const signed = accept && signName.trim().length > 2;
  const errs = [signedIn ? '' : t('Log in or create an account to continue.'), signed ? '' : t('Accept the agreement and type your full name to sign.'), ''];
  const go = (i: number) => { setTried(false); nav('/checkout' + (SLUGS[i] ? '/' + SLUGS[i] : '')); scrollTop(); };
  const toLogin = () => { savePlan({ qty: p.qty, pkgs: p.pkgs, storeOn: p.storeOn, domain: p.domain, tt: 'off', meta: 'off', marketOn: p.marketOn, company: p.company, country: p.country, vat: p.vat }); leave.to(loginUrl('/app/checkout')); };

  const pay = async () => {
    if (paying) return;
    const s = await freshSession();
    if (!s) return toLogin();
    setPaying(true); setPayErr('');
    try {
      const r = await callFn<{ url?: string }>('create-checkout', {
        config: { m2: p.qty, pkgs: p.pkgs, storeOn: p.storeOn, domain: p.domain, tt: 'off', meta: 'off', marketOn: p.marketOn },
        company, country: p.country, vatId: p.vat, signName: signName.trim(),
      });
      if (!r.ok || !r.data.url) throw new Error(r.status === 401 ? t('Your session expired. Please log in again.') : r.status === 409 ? t('You already have an active plan. Manage it from Account > Billing.') : (r.data.error || t('Could not start the payment')));
      leave.to(r.data.url);
    } catch (e) { setPaying(false); setPayErr(errText(e)); }
  };

  const next = () => {
    if (notice) setNotice('');
    if (a.activated) return setPayErr(t('You already have an active plan. Manage it from Account > Billing.'));
    if (errs[step]) return setTried(true);
    if (step < 2) return go(step + 1);
    // Paying needs the earlier steps done, also when this page was opened directly.
    if (!signedIn) return go(0);
    if (!signed) { go(1); setTried(true); return; }
    if (!company) { nav('/plan/review'); return; }
    void pay();
  };
  const back = () => { if (step === 0 || (step === 1 && signedIn)) nav('/plan/review'); else go(step - 1); scrollTop(); };

  const title = [signedIn ? t('Review your account') : t('Create your account'), t('Sign the agreement'), t('Pay and go live')][step];
  const errMsg = payErr || notice || (tried ? errs[step] : '');
  // i18n
  const terms = [
    ['Provider', '2ACE sp. z o.o., ul. Ostrobramska 101A lok. 301, 04-041 Warszawa. NIP 1133212948. Tel. +48 608 180 946.'],
    ['Term', 'Monthly, rolling. Cancel or resize with 30 days notice.'],
    ['Billing', 'Space billed on reserved m² in advance on the 1st. Add-ons from the day they start.'],
    ['Service levels', 'Orders before 15:00 ship the same day. Returns graded within 48 h. 99.5% stock accuracy.'],
    ['Insurance', 'Goods on our floor insured at declared purchase value.'],
    ['Customs', 'We act as your indirect customs representative for imports into Poland.'],
    ['Law', 'Polish law. Disputes settled in Warsaw.'],
    ...(p.storeOn ? [['Domain', 'Registered through Hostinger in your company name. You accept its registration agreement.']] : []),
  ];

  return (
    <main className="page">
      {a.activated ? <OwnedNotice /> : null}
      <p className="eyebrow">{t('Activate your plan')}</p>
      <h1 className="display">{title}</h1>
      <nav className="steps" aria-label={t('Steps')}>
        {STEPS.map((label, i) => (
          <button key={label} className={i === step ? 'here' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined} disabled={i > step} onClick={() => go(i)}>
            <span className="n">0{i + 1}</span><span className="t">{t(label)}</span>
          </button>
        ))}
      </nav>
      <div className="with-aside">
        <div className="body">
          {step === 0 ? (
            <div className="card stack-sm">
              {signedIn ? (
                <>
                  <span className="label">{t('Signed in')}</span>
                  <p style={{ fontSize: 18, fontWeight: 600 }}>{a.email}</p>
                  <p className="sub">{t('This account becomes the owner of your plan. Invite operations, finance and marketing colleagues from the dashboard.')}</p>
                </>
              ) : (
                <>
                  <p className="sub">{t('Log in or create your account to continue. Your plan choices are saved and will be waiting for you.')}</p>
                  <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={toLogin}>{t('Log in or create account')}</button>
                </>
              )}
            </div>
          ) : null}
          {step === 1 ? (
            <div className="stack">
              <div className="card stack-sm">
                <div className="spread"><span className="h3">{t('2ACE service agreement')}</span><span className="mono small">v1.0 · draft</span></div>
                {lang !== 'en' ? <p className="small">{t('This translation is for convenience. The English agreement is the one you sign.')}</p> : null}
                {terms.map(([k, v]) => <div className="kv" key={k}><span>{t(k)}</span><span style={{ fontFamily: 'var(--sans)', maxWidth: '60ch' }}>{t(v)}</span></div>)}
                <a className="linkbtn" href="/terms" target="_blank" rel="noopener">{t('Read the full terms →')}</a>
              </div>
              <div className="card stack-sm">
                <Tick on={accept} bad={tried && !accept} onToggle={() => setAccept(!accept)}>{t('I accept the 2ACE service agreement and confirm I can sign for {company}.', { company })}</Tick>
                {p.storeOn ? <p className="small">{t('Your .pl store domain is registered through Hostinger, in your company\'s name. By signing you also accept')} <a className="linkbtn" href="https://www.hostinger.com/legal/domain-name-registration-agreement" target="_blank" rel="noopener">{t('Hostinger\'s Domain Name Registration Agreement')}</a>.</p> : null}
                <Field label={t('Type your full name to sign')} bad={tried && signName.trim().length <= 2} value={signName} placeholder={t('First and last name')} onChange={(e) => setSignName(e.target.value)} autoComplete="name" />
                <span className="mono small">{t('Signing for {company} · {country} · {vat}', { company, country: t(cc.name), vat: p.vat || '—' })}</span>
              </div>
            </div>
          ) : null}
          {step === 2 ? (
            <div className="stack">
              <div className="choice on" role="radio" aria-checked="true">
                <strong style={{ display: 'block' }}>{t('Pay online')}</strong>
                <span className="small" style={{ color: 'rgba(245,244,241,0.72)' }}>{t('Cards, Apple Pay, Przelewy24 and SEPA. Goes live as soon as the payment clears.')}</span>
              </div>
              <div className="card stack-sm">
                <strong>{t('Secure payment on Stripe')}</strong>
                <span className="small">{t('You enter your payment details on Stripe\'s own page, so your card number never touches 2ACE. Charged today for the first month and setup, then monthly.')}</span>
              </div>
              <div className="small"><strong>{vatLabel}.</strong> {vatNote}</div>
            </div>
          ) : null}
          <ErrLine text={errMsg} />
          <div className="actions">
            <button className="btn ghost" onClick={back}>{t('Back')}</button>
            <button className="btn" onClick={next} disabled={paying}>{step < 2 ? t('Continue') : paying ? t('Opening secure payment…') : t('Continue to secure payment')}</button>
          </div>
        </div>
        <aside className="summary" aria-label={t('Your order')}>
          <span className="eyebrow">{t('Your order')}</span>
          <span className="meta">{company || '—'} · {t(cc.name)}</span>
          <div>
            {P.lines.filter((l) => l.monthly || l.once || l.quote).map((l) => (
              <div className="sline" key={l.key}><span>{t(l.label, l.vars)}</span><span>{l.quote ? t('On quote') : fmt(l.monthly + l.once)}</span></div>
            ))}
            <div className="sline"><span>{t('Net')}</span><span>{fmt(net)}</span></div>
            <div className="sline"><span>{vatLabel}</span><span>{fmt(v.vat)}</span></div>
          </div>
          <div><span className="meta">{t('DUE TODAY')}</span><span className="big">{fmt(net + v.vat)}</span></div>
          <span className="meta">{t('Then {price} net / month', { price: fmt(P.monthly) })}</span>
        </aside>
      </div>
    </main>
  );
}
