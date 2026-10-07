import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { baseRoutes, callsTo, mockFetch, ORG, renderApp, signIn, status, text, until, where } from './harness';

const PENDING_ORG = { ...ORG, organizations: { ...ORG.organizations, status: 'pending' } };
const save = (plan: object) => localStorage.setItem('ace_plan', JSON.stringify({ v: 2, t: Date.now(), plan: { qty: 10, pkgs: {}, storeOn: false, domain: '', company: 'Acme sp. z o.o.', country: 'PL', vat: '1234567890', ...plan } }));

describe('checkout', () => {
  it('a visitor is asked to log in, and comes back to checkout', async () => {
    mockFetch(baseRoutes());
    save({});
    const { user, left } = renderApp('/checkout');
    expect(text()).toContain('Create your account');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(text()).toContain('Log in or create an account to continue.');
    await user.click(screen.getByRole('button', { name: 'Log in or create account' }));
    expect(left.to).toHaveBeenCalledWith('/login?next=%2Fapp%2Fcheckout');
    expect(JSON.parse(localStorage.getItem('ace_plan')!).plan.qty).toBe(10);
  });

  it('signs, then sends the plan, company and signature to Stripe checkout', async () => {
    signIn();
    save({ pkgs: { imp: true } });
    const calls = mockFetch({ ...baseRoutes({ org: PENDING_ORG, plan: null }), 'POST /functions/v1/create-checkout': () => ({ url: 'https://checkout.stripe.com/c/pay/x' }) });
    const { user, left } = renderApp('/checkout/agreement');
    expect(text()).toContain('Sign the agreement');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(text()).toContain('Accept the agreement and type your full name to sign.');
    expect(where).toBe('/checkout/agreement');
    await user.click(screen.getByRole('checkbox'));
    await user.type(screen.getByRole('textbox', { name: 'Type your full name to sign' }), 'Ola Nowak');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(where).toBe('/checkout/payment');
    const order = screen.getByRole('complementary', { name: 'Your order' });
    expect(within(order).getByText('VAT 23%')).toBeInTheDocument();
    expect(text()).toContain('3 690 zł');   // 3 000 net + 23% VAT
    await user.click(screen.getByRole('button', { name: 'Continue to secure payment' }));
    await until(() => expect(left.to).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/x'));
    const body = callsTo(calls, 'POST /functions/v1/create-checkout')[0].body;
    expect(body).toEqual({ config: { m2: 10, pkgs: { imp: true }, storeOn: false, domain: '', tt: 'off', meta: 'off', marketOn: false }, company: 'Acme sp. z o.o.', country: 'PL', vatId: '1234567890', signName: 'Ola Nowak' });
  });

  it('opening the payment step directly still requires signing first', async () => {
    signIn();
    save({});
    const calls = mockFetch({ ...baseRoutes({ org: PENDING_ORG, plan: null }) });
    const { user } = renderApp('/checkout/payment');
    await user.click(screen.getByRole('button', { name: 'Continue to secure payment' }));
    expect(where).toBe('/checkout/agreement');
    expect(text()).toContain('Accept the agreement');
    expect(callsTo(calls, 'POST /functions/v1/create-checkout')).toHaveLength(0);
  });

  it('a company that already pays is sent to Billing, not charged twice', async () => {
    signIn();
    save({});
    mockFetch({ ...baseRoutes(), 'POST /functions/v1/create-checkout': () => status(409, { error: 'already subscribed' }) });
    const { user } = renderApp('/checkout/agreement');
    await until(() => expect(text()).toContain('You already have an active plan.'));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(text()).toContain('You already have an active plan. Manage it from Account > Billing.');
  });

  it('a 409 from Stripe checkout explains it', async () => {
    signIn();
    save({});
    mockFetch({ ...baseRoutes({ org: PENDING_ORG, plan: null }), 'POST /functions/v1/create-checkout': () => status(409, { error: 'already subscribed' }) });
    const { user } = renderApp('/checkout/agreement');
    await user.click(screen.getByRole('checkbox'));
    await user.type(screen.getByRole('textbox', { name: 'Type your full name to sign' }), 'Ola Nowak');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Continue to secure payment' }));
    await until(() => expect(text()).toContain('You already have an active plan. Manage it from Account > Billing.'));
  });

  it('VAT: reverse charge for an EU company, none outside the EU', async () => {
    signIn();
    save({ country: 'DE' });
    mockFetch(baseRoutes({ org: null, plan: null }));
    const first = renderApp('/checkout/payment');
    expect(text()).toContain('Reverse charge, 0% VAT');
    expect(text()).toContain('you account for the VAT in Germany');
    first.unmount();
    save({ country: 'CN' });
    renderApp('/checkout/payment');
    expect(text()).toContain('0% VAT, outside the EU');
  });

  it('coming back from a cancelled payment says nothing was charged', async () => {
    signIn();
    save({});
    mockFetch(baseRoutes({ org: PENDING_ORG, plan: null }));
    renderApp('/?checkout=cancelled');
    await until(() => expect(where).toBe('/checkout/payment?cancelled=1'));
    expect(text()).toContain('Payment was cancelled, nothing was charged.');
  });
});

describe('links from the old /platform page', () => {
  it('?checkout=success forgets the saved plan and waits on the dashboard until the plan is live', async () => {
    signIn();
    save({});
    let n = 0;
    mockFetch({ ...baseRoutes(), 'GET /rest/v1/members': () => [{ ...ORG, organizations: { ...ORG.organizations, status: ++n > 2 ? 'active' : 'pending' } }] });
    renderApp('/?checkout=success');
    await until(() => expect(where.startsWith('/dashboard')).toBe(true));
    expect(text()).toContain('Confirming your payment…');
    expect(localStorage.getItem('ace_plan')).toBeNull();
    await until(() => expect(text()).not.toContain('Confirming your payment…'), 8000);
    expect(text()).toContain('Your plan is live.');
  }, 12000);

  it('?view=dash and ?tab=domain open the dashboard; signed out they go to login', async () => {
    mockFetch(baseRoutes());
    const { left, unmount } = renderApp('/?view=dash');
    expect(left.to).toHaveBeenCalledWith('/login?next=%2Fapp%2Fdashboard');
    unmount();
    signIn();
    renderApp('/?tab=domain');
    await until(() => expect(where).toBe('/dashboard/domain'));
  });

  it('the bare address opens the builder', async () => {
    mockFetch(baseRoutes());
    renderApp('/');
    await until(() => expect(where).toBe('/plan'));
  });
});
