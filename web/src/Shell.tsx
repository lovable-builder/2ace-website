import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { LANGS, useLang } from './i18n';
import { customerName, useAccount } from './state/account';
import { usePlan } from './state/plan';
import { pricing } from './lib/pricing';
import { fmt } from './lib/format';
import { loginUrl } from './lib/session';
import type { Lang } from './lib/format';
import { leave } from './lib/nav';

// Header (plan builder / dashboard switch, who is signed in, the plan price, language) and footer around every screen.
export function Shell() {
  const { t, lang, setLang } = useLang();
  const a = useAccount();
  const { active, change } = usePlan();
  const loc = useLocation();
  const nav = useNavigate();
  const onDash = loc.pathname.startsWith('/dashboard');
  const signedIn = !!a.session;
  const name = customerName(active.company, a);
  const monthly = a.activated && a.curPlan && !change ? a.curPlan.monthly : pricing(active).monthly;
  const initials = (name || a.email).split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  const goDash = (e: React.MouseEvent) => {
    if (signedIn) return;
    e.preventDefault();
    leave.to(loginUrl('/app/dashboard'));
  };
  const onAuth = () => {
    if (signedIn) { a.signOut(); nav('/plan'); }
    else leave.to(loginUrl('/app' + loc.pathname + loc.search));
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header className="top">
        <div className="brand"><a href="/">2ACE</a><span>PLATFORM</span></div>
        <nav className="vtabs" aria-label={t('Sections')}>
          <Link to="/plan" className={onDash ? '' : 'on'}>{t('Build plan')}</Link>
          <Link to="/dashboard" className={onDash ? 'on' : ''} onClick={goDash}>{t('Dashboard')}</Link>
        </nav>
        <div className="who">
          {signedIn ? <span className="welcome">{t('Welcome, {name}', { name: a.orgName || a.userName || a.email })}</span> : null}
          <span className="price">{t('Plan · {price} / mo', { price: fmt(monthly) })}</span>
          <label className="sr-only" htmlFor="lang">{t('Language')}</label>
          <select id="lang" value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
            {LANGS.map((l) => <option key={l.k} value={l.k}>{l.label}</option>)}
          </select>
          <button className="auth" onClick={onAuth} title={a.email || t('Not signed in')}>{signedIn ? t('Log out') : t('Log in')}</button>
          {signedIn ? (
            <a href="/account" title={t('Your account')} aria-label={t('Your account')}>
              <span className="avatar" style={a.logoUrl ? { backgroundColor: '#FFFFFF', backgroundImage: `url(${a.logoUrl})` } : undefined}>{a.logoUrl ? '' : initials}</span>
            </a>
          ) : null}
        </div>
      </header>
      <div style={{ flex: 1 }}><Outlet /></div>
      <Footer />
    </div>
  );
}

export function Footer() {
  const { t } = useLang();
  return (
    <footer className="foot">
      <span>2ACE · Poland</span>
      <a href="/help" target="_blank" rel="noopener">{t('Help')}</a>
      <a href="/terms" target="_blank" rel="noopener">{t('Terms')}</a>
      <a href="/privacy" target="_blank" rel="noopener">{t('Privacy')}</a>
      <a href="mailto:hello@2ace.pl">hello@2ace.pl</a>
      <span className="legal">2ACE sp. z o.o. · ul. Ostrobramska 101A lok. 301, 04-041 Warszawa · NIP 1133212948 · REGON 545746743 · KRS 0001267111 · tel. +48 608 180 946</span>
    </footer>
  );
}
