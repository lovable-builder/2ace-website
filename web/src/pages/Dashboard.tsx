import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useT } from '../i18n';
import { customerName, useAccount } from '../state/account';
import { usePlan } from '../state/plan';
import { WarehouseProvider, useWarehouse } from '../state/warehouse';
import { scrollTop } from '../ui';
import { Overview } from './dash/Overview';
import { Inventory } from './dash/Inventory';
import { Products } from './dash/Products';
import { Inbound } from './dash/Inbound';
import { Orders } from './dash/Orders';
import { Returns } from './dash/Returns';
import { Domain } from './dash/Domain';
import { Contact, type Topic } from './dash/Contact';

// i18n
export const TABS = [
  ['', 'Overview'], ['imports', 'Imports'], ['tracking', 'Shipment tracking'], ['inbound', 'Inbound'], ['products', 'Products'], ['inventory', 'Inventory'],
  ['orders', 'Orders'], ['returns', 'Returns'], ['storefront', 'Storefront'], ['domain', 'Domain'], ['team', 'Team'],
] as const;
export type Tab = (typeof TABS)[number][0];
const WAREHOUSE_TABS = ['inbound', 'products', 'inventory'];

export function Dashboard() {
  return <WarehouseProvider><DashboardInner /></WarehouseProvider>;
}

function DashboardInner() {
  const t = useT();
  const a = useAccount();
  const wh = useWarehouse();
  const { draft } = usePlan();
  const nav = useNavigate();
  const loc = useLocation();
  const [sp, setSp] = useSearchParams();
  const { tab: tabParam } = useParams();
  const tab = (TABS.some(([k]) => k === (tabParam ?? '')) ? tabParam ?? '' : '') as Tab;
  const [menu, setMenu] = useState(false);
  const [contact, setContact] = useState<Topic | null>(null);
  const [chDone] = useState<string>(() => (loc.state as { chDone?: string } | null)?.chDone ?? '');
  const [pay, setPay] = useState<'' | 'confirming' | 'slow'>(sp.get('paid') === '1' ? 'confirming' : '');
  const customer = customerName(draft.company, a);

  // Opening Inbound, Products or Inventory always shows fresh numbers.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (WAREHOUSE_TABS.includes(tab)) void wh.reload();
  }, [tab]); // only a change of tab reloads

  // Back from Stripe: the payment webhook makes the plan live, usually within seconds. Ask again until it has.
  useEffect(() => {
    if (pay !== 'confirming') return;
    let tries = 0, stop = false, timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      tries += 1;
      const next = await a.reload().catch(() => null);
      if (stop) return;
      if (next?.activated) { setPay(''); setSp({}, { replace: true }); return; }
      if (tries < 20) timer = setTimeout(tick, 2000); else setPay('slow');
    };
    timer = setTimeout(tick, 1500);
    return () => { stop = true; clearTimeout(timer); };
  }, [pay]); // one polling loop per payment

  const go = (k: string) => { setMenu(false); nav('/dashboard' + (k ? '/' + k : '')); scrollTop(); };
  const pc = a.curPlan?.config;

  const EMPTY: Partial<Record<Tab, { title: string; text: string; cta: string; go: () => void }>> = {
    imports: { title: t('No imports yet'), text: t('Your shipments appear here after you book an inbound delivery: milestones, customs documents and landed cost, live.'), cta: t('Book your first inbound'), go: () => go('inbound') },
    tracking: { title: t('No shipments to track'), text: t('Live tracking starts as soon as a shipment is booked with us.'), cta: t('Book inbound'), go: () => go('inbound') },
    storefront: pc?.storeOn
      ? { title: a.domainName ? t('Your store at {domain}', { domain: a.domainName }) : t('Your .pl storefront'), text: t('We are preparing your store. We email you when the first draft is ready to review.'), cta: t('Back to overview'), go: () => go('') }
      : { title: t('No storefront in your plan'), text: t('Add a designed and hosted .pl store to your plan: 199 zł a month plus 2 950 zł setup.'), cta: t('Change plan'), go: () => nav('/plan?change=1') },
    team: { title: t('Your team'), text: t('You are the account owner ({email}). Inviting colleagues with their own roles for operations, finance and marketing is opening soon.', { email: a.email || t('your email') }), cta: t('Ask for team access'), go: () => setContact('team') },
  };
  const em = EMPTY[tab];

  return (
    <div className="dash">
      <nav className={'dashnav' + (menu ? ' open' : '')} aria-label={t('Dashboard')}>
        <button className="dashclose" onClick={() => setMenu(false)} aria-label={t('Close menu')}>×</button>
        <span className="who-co">{customer}</span>
        {TABS.map(([k, label]) => (
          <Link key={k} to={'/dashboard' + (k ? '/' + k : '')} className={tab === k ? 'on' : ''} aria-current={tab === k ? 'page' : undefined} onClick={() => { setMenu(false); scrollTop(); }}>
            <span>{t(label)}</span>{k === 'domain' && a.domainOffer ? <span className="badge">{t('New')}</span> : null}
          </Link>
        ))}
        <button className="navbtn outline first" onClick={() => { setMenu(false); setContact('other'); }}>{t('Contact us')}</button>
        <a className="outline" href="/help" target="_blank" rel="noopener">{t('Help and user guide')}</a>
      </nav>
      <div className={'dashscrim' + (menu ? ' open' : '')} onClick={() => setMenu(false)} />
      <main className="dashmain">
        <button className="dashtoggle" onClick={() => setMenu(!menu)} aria-label={t('Open menu')}><span aria-hidden="true">☰</span> {t('Menu')}</button>
        {chDone ? <div role="status" className="note"><strong>{t('Plan updated.')}</strong> {chDone}</div> : null}
        {pay === 'confirming' ? <div role="status" className="note"><strong>{t('Confirming your payment…')}</strong> {t('This usually takes a few seconds. You can keep this page open.')}</div> : null}
        {pay === 'slow' ? <div role="status" className="warnbox"><strong>{t('Still confirming your payment.')}</strong> {t('Some payment methods take longer. Your plan goes live as soon as the payment clears, and we will email you.')}</div> : null}

        {tab === '' ? <Overview customer={customer} go={go} /> : null}
        {tab === 'inventory' ? <Inventory go={go} /> : null}
        {tab === 'products' ? <Products /> : null}
        {tab === 'inbound' ? <Inbound /> : null}
        {tab === 'orders' ? <Orders /> : null}
        {tab === 'returns' ? <Returns /> : null}
        {tab === 'domain' ? <Domain /> : null}
        {em ? (
          <div className="stack narrow">
            <h1 className="h1">{t(TABS.find(([k]) => k === tab)![1])}</h1>
            <div className="card stack-sm">
              <span className="h3">{em.title}</span>
              <p className="sub">{em.text}</p>
              <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={em.go}>{em.cta}</button>
            </div>
          </div>
        ) : null}
      </main>
      {contact ? <Contact topic={contact} onClose={() => setContact(null)} /> : null}
    </div>
  );
}

