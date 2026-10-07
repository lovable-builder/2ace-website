import { Link, useNavigate } from 'react-router-dom';
import { useLang, type T } from '../../i18n';
import { useAccount } from '../../state/account';
import { useWarehouse, type WhData } from '../../state/warehouse';
import { planM2 } from '../../lib/pricing';
import { dateLong, fmt, m2fmt, num } from '../../lib/format';

// The journey of the customer's goods, from what is already loaded. Nothing is a number until it has loaded.
export type Journey = { booked: number; arriving: number; shelf: number; ordered: number; held: number; picking: number; packed: number; shipped: number };
export function journeyOf(w: Pick<WhData, 'loaded' | 'err' | 'book' | 'inv' | 'orders'>, now = Date.now()): Journey | null {
  if (!w.loaded || w.err) return null;
  const n = <X extends { status: string }>(arr: X[], st: string) => arr.filter((x) => x.status === st).length;
  const weekAgo = now - 7 * 864e5;
  return {
    booked: n(w.book, 'booked'), arriving: n(w.book, 'receiving'), shelf: w.inv.reduce((t, p) => t + (Number(p.available) || 0), 0),
    ordered: n(w.orders, 'allocated'), held: n(w.orders, 'held'), picking: n(w.orders, 'picking'), packed: n(w.orders, 'packed'),
    shipped: w.orders.filter((o) => o.status === 'shipped' && o.shipped_at && new Date(o.shipped_at).getTime() >= weekAgo).length,
  };
}
// i18n
const STEPS: { k: keyof Journey; icon: string; title: string; hint: string; tab: string }[] = [
  { k: 'booked', icon: '📋', title: 'Booked', hint: 'You announced a delivery', tab: 'inbound' },
  { k: 'arriving', icon: '🚚', title: 'Arriving', hint: 'We are scanning it in', tab: 'inbound' },
  { k: 'shelf', icon: '🗄️', title: 'On your shelf', hint: 'Units ready to sell', tab: 'inventory' },
  { k: 'ordered', icon: '🛒', title: 'Ordered', hint: 'Stock reserved for your orders', tab: 'orders' },
  { k: 'picking', icon: '🎯', title: 'Picking', hint: 'Being collected from the shelves', tab: 'orders' },
  { k: 'packed', icon: '📦', title: 'Packed', hint: 'Boxed, waiting for the courier', tab: 'orders' },
  { k: 'shipped', icon: '🚀', title: 'Shipped', hint: 'On its way (last 7 days)', tab: 'orders' },
];

export function journeyNote(j: Journey | null, w: Pick<WhData, 'inv' | 'book'>, t: T) {
  if (!j) return '';
  if (!w.inv.length) return t('Start by adding your products, then book your first delivery. Your goods appear on this journey as they move.');
  if (!w.book.length && !j.shelf) return t('Book your first inbound delivery to start the journey.');
  if (j.held > 0) return j.held === 1 ? t('1 order is on hold because some stock is missing. It reserves itself when your next delivery arrives.') : t('{n} orders are on hold because some stock is missing. They reserve themselves when your next delivery arrives.', { n: j.held });
  return '';
}

export function Overview({ customer, go }: { customer: string; go: (tab: string) => void }) {
  const { t, lang } = useLang();
  const a = useAccount();
  const w = useWarehouse();
  const nav = useNavigate();
  const pc = a.curPlan?.config;
  const now = new Date(), hr = now.getHours();
  const j = journeyOf(w);
  const note = journeyNote(j, w, t);
  const showJourney = a.activated || w.book.length > 0 || w.inv.length > 0;

  const steps: { title: string; sub: string; done: boolean; cta: string; to: () => void }[] = [
    { title: t('Your plan is active'), sub: a.activated ? t('Billed monthly, no minimum term.') : t('Finish checkout to activate it.'), done: a.activated, cta: t('Build plan'), to: () => nav('/plan') },
  ];
  if (a.hasDomain || a.domainOffer || pc?.storeOn) {
    steps.push({ title: t('Your .pl domain'), sub: a.hasDomain ? t('Requested. We confirm by email.') : pc?.storeOn ? t('Included in your plan. Choose a name.') : t('Optional: 99 zł one-time, first year included.'), done: a.hasDomain, cta: t('Choose'), to: () => go('domain') });
  }
  steps.push({ title: t('Add your products'), sub: t('Add the products you will store with us.'), done: w.inv.length > 0, cta: t('Open'), to: () => go('products') });
  steps.push({ title: t('Book your first inbound delivery'), sub: t('Tell us what is arriving and when.'), done: w.book.length > 0, cta: t('Open'), to: () => go('inbound') });
  steps.push({ title: t('Invite your team'), sub: t('Give colleagues their own access.'), done: false, cta: t('Open'), to: () => go('team') });

  const onOff = (v: unknown, yes?: string) => (v ? yes || t('Included') : t('Not in plan'));
  const planRows = pc ? [
    [t('Space'), m2fmt(planM2(pc)) + ' m²'],
    [t('Fulfilment and returns'), t('Pay as you go')],
    [t('Import & customs'), onOff(pc.pkgs?.imp, t('Quoted per shipment'))],
    [t('.pl storefront'), onOff(pc.storeOn)],
  ] : [];

  return (
    <div className="stack">
      {a.domainOffer ? (
        <div className="warnbox spread">
          <span><strong>{t('Get your own .pl domain.')}</strong> {t('We register it in your company name. 99 zł one-time, first year included.')}</span>
          <button className="btn small" onClick={() => go('domain')}>{t('Choose a domain')}</button>
        </div>
      ) : null}
      <div className="spread">
        <div>
          <p className="eyebrow" style={{ marginBottom: 6 }}>{dateLong(now, lang)}</p>
          <h1 className="h1">{customer
            ? t(hr < 12 ? 'Good morning, {name}' : hr < 18 ? 'Good afternoon, {name}' : 'Good evening, {name}', { name: customer })
            : t(hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening')}</h1>
        </div>
        {a.activated ? <Link className="btn ghost" to="/plan?change=1">{t('Change plan')}</Link> : null}
      </div>
      {a.activated ? (
        <div className="okbox spread">
          <span><strong>{t('Your plan is live.')}</strong> {t('Work through the steps below to get your first delivery moving.')}</span>
          <span className="mono">{t('{price} / month', { price: fmt(a.curPlan?.monthly ?? 0) })}</span>
        </div>
      ) : null}
      {showJourney ? (
        <div className="card">
          <span className="h3">{t('Where your goods are')}</span>
          <span className="small" style={{ display: 'block', marginTop: 4 }}>{t('The journey of your stock and orders, live. Tap a step to open it.')}</span>
          <div className="jy-lane">
            <span className="jy-parcel" aria-hidden="true">📦</span>
            <div className="jy-track">
              {STEPS.map((s, i) => {
                const n = j ? j[s.k] : null;
                const badge = s.k === 'ordered' && j && j.held > 0 ? t('{n} on hold', { n: j.held }) : '';
                return (
                  <button key={s.k} className={'jy-st' + (n && n > 0 ? ' on' : '')} onClick={() => go(s.tab)}
                    aria-label={t(s.title) + ': ' + (n === null ? t('loading') : n) + '. ' + t(s.hint)}>
                    <span className="jy-ico">{s.icon}{badge ? <em className="jy-badge">{badge}</em> : null}</span>
                    <b className="jy-n">{n === null ? '–' : num(n)}</b>
                    <span className="jy-t">{t(s.title)}</span>
                    <small>{t(s.hint)}</small>
                    {i < STEPS.length - 1 ? <i className="jy-hop" /> : null}
                  </button>
                );
              })}
            </div>
          </div>
          {note ? <p className="small" style={{ marginTop: 14 }}>{note}</p> : null}
        </div>
      ) : null}
      <div className="with-aside" style={{ gap: 20 }}>
        <div className="card checklist" style={{ flex: '1 1 420px' }}>
          <span className="h3">{t('Getting started')}</span>
          {steps.map((s, i) => (
            <div className={'step' + (s.done ? ' done' : '')} key={s.title}>
              <span className="dot">{s.done ? '✓' : i + 1}</span>
              <span className="what"><span>{s.title}</span><span>{s.sub}</span></span>
              {s.done ? null : <button className="btn ghost small" onClick={s.to}>{s.cta}</button>}
            </div>
          ))}
        </div>
        {planRows.length ? (
          <div className="card" style={{ flex: '1 1 280px' }}>
            <span className="h3">{t('Your plan')}</span>
            {planRows.map(([k, v]) => <div className="kv" key={k}><span>{k}</span><span>{v}</span></div>)}
            <div className="kv" style={{ borderBottom: 0, fontWeight: 600 }}><span>{t('Monthly, excl. VAT')}</span><span>{fmt(a.curPlan?.monthly ?? 0)}</span></div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
