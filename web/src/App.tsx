import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { LangProvider, useT } from './i18n';
import { AccountProvider } from './state/account';
import { PlanProvider, usePlan } from './state/plan';
import { currentSession, loginUrl } from './lib/session';
import { ErrorBoundary, ToastProvider } from './ui';
import { Shell } from './Shell';
import { Builder } from './pages/Builder';
import { Checkout } from './pages/Checkout';
import { Dashboard } from './pages/Dashboard';
import { leave } from './lib/nav';
import { selfServe } from './lib/flags';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <LangProvider>
      <ToastProvider>
        <AccountProvider>
          <PlanProvider fresh={new URLSearchParams(location.search).get('checkout') === 'success'}>{children}</PlanProvider>
        </AccountProvider>
      </ToastProvider>
    </LangProvider>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Entry />} />
        <Route path="plan/:step?" element={<SelfServeOnly><Builder /></SelfServeOnly>} />
        <Route path="checkout/:step?" element={<SelfServeOnly><Checkout /></SelfServeOnly>} />
        <Route path="dashboard/:tab?" element={<SignedIn><Dashboard /></SignedIn>} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <Providers>
        <BrowserRouter basename="/app"><AppRoutes /></BrowserRouter>
      </Providers>
    </ErrorBoundary>
  );
}

// The plan builder and checkout only exist while self-service plans are on. Otherwise people go to their dashboard (or, without a login, to the pricing request on the home page).
function SelfServeOnly({ children }: { children: ReactNode }) {
  const nav = useNavigate();
  const on = selfServe();
  useEffect(() => { if (!on) { if (currentSession()) nav('/dashboard', { replace: true }); else leave.to('/#talk'); } }, [on, nav]);
  return on ? <>{children}</> : null;
}

// Sends someone without a session to /login, and back here afterwards.
function SignedIn({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const ok = !!currentSession();
  useEffect(() => { if (!ok) leave.to(loginUrl('/app' + loc.pathname)); }, [ok, loc.pathname]);
  return ok ? <>{children}</> : null;
}

// /app/ itself, and the links the old /platform page used (Stripe and the emails send people to them):
// ?checkout=success|cancelled, ?domain=success|cancelled, ?tab=domain, ?view=dash|checkout.
function Entry() {
  const nav = useNavigate();
  const { search } = useLocation();
  const { forget } = usePlan();
  useEffect(() => {
    const q = new URLSearchParams(search);
    const signed = !!currentSession();
    const need = (to: string) => { if (signed) nav(to, { replace: true }); else leave.to(loginUrl('/app' + to.replace(/\?.*$/, ''))); };
    const co = q.get('checkout'), dom = q.get('domain'), view = q.get('view');
    if (co === 'success') { forget(); need('/dashboard?paid=1'); }
    else if (co === 'cancelled') nav('/checkout/payment?cancelled=1', { replace: true });
    else if (dom === 'success' || dom === 'cancelled') need('/dashboard/domain?domain=' + dom);
    else if (q.get('tab') === 'domain') need('/dashboard/domain');
    else if (view === 'dash') need('/dashboard');
    else if (view === 'checkout') nav(signed ? '/checkout/agreement' : '/checkout', { replace: true });
    else nav(selfServe() ? '/plan' : '/dashboard', { replace: true });
  }, [nav, forget, search]);
  return null;
}

function NotFound() {
  const t = useT();
  return (
    <div className="center">
      <div className="stack-sm">
        <h1 className="h1">{t('This page does not exist.')}</h1>
        <p className="sub">{selfServe() ? <><a className="linkbtn" href="/app/plan">{t('Build your plan')}</a> · </> : null}<a className="linkbtn" href="/app/dashboard">{t('Dashboard')}</a></p>
      </div>
    </div>
  );
}

