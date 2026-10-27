import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { baseRoutes, callsTo, mockFetch, ORG, renderApp, signIn, text, until, where } from './harness';

// Self-service plans are off in production: no plan builder, no checkout, no prices. (Every other test file runs with them on, as config.js can switch them back on.)
const ON = window.ACE_CONFIG!;
beforeEach(() => { window.ACE_CONFIG = Object.freeze({ ...ON, selfServe: false }); });
afterEach(() => { window.ACE_CONFIG = ON; });

const MANAGED = { config: { service: 'managed', note: 'Pick and pack with a 24 h cut-off' }, monthly_pln: 0, once_pln: 0 };

describe('self-service plans switched off', () => {
  it('the header has no Build plan link and no plan price', async () => {
    signIn();
    mockFetch(baseRoutes({ plan: MANAGED }));
    renderApp('/dashboard');
    await until(() => expect(screen.getAllByRole('link', { name: /Dashboard/ })[0]).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Build plan' })).toBeNull();
    expect(text()).not.toMatch(/Plan · /);
    expect(text()).not.toMatch(/\d\s?zł/);
  });

  it('the plan builder and checkout send a signed-in person to their dashboard', async () => {
    signIn();
    mockFetch(baseRoutes({ plan: MANAGED }));
    renderApp('/plan');
    await until(() => expect(where).toBe('/dashboard'));
    renderApp('/checkout/payment');
    await until(() => expect(where).toBe('/dashboard'));
  });

  it('a visitor without a login is sent to the pricing request on the home page, not to a builder', async () => {
    mockFetch(baseRoutes());
    const { left } = renderApp('/plan');
    await until(() => expect(left.to).toHaveBeenCalledWith('/#talk'));
  });

  it('opening the app with no parameters goes to the dashboard', async () => {
    signIn();
    mockFetch(baseRoutes({ plan: MANAGED }));
    renderApp('/');
    await until(() => expect(where).toBe('/dashboard'));
  });

  it('the overview says "service", shows what was agreed in words, and has no price, no Change plan and no domain offer', async () => {
    signIn();
    mockFetch(baseRoutes({ plan: MANAGED, org: { ...ORG, organizations: { ...ORG.organizations, domain_orders: [] } } }));
    renderApp('/dashboard');
    await until(() => expect(text()).toContain('Your service is live.'));
    expect(text()).toContain('Charged per use, as agreed');
    expect(text()).toContain('Pick and pack with a 24 h cut-off');
    expect(text()).not.toContain('Change plan');
    expect(text()).not.toMatch(/\d\s?zł|pallet places|m³|Monthly, excl\. VAT|Your plan is/);
    expect(screen.queryByRole('link', { name: 'Domain' })).toBeNull();
  });

  it('the storefront tab offers to talk to us, with no price', async () => {
    signIn();
    mockFetch(baseRoutes({ plan: MANAGED }));
    renderApp('/dashboard/storefront');
    await until(() => expect(text()).toContain('A .pl storefront'));
    expect(text()).not.toMatch(/\d\s?zł/);
    expect(screen.getAllByRole('button', { name: 'Contact us' }).length).toBeGreaterThan(1);   // the menu one and the storefront one
  });

  it('a link to the domain tab shows the overview instead', async () => {
    signIn();
    mockFetch(baseRoutes({ plan: MANAGED }));
    renderApp('/dashboard/domain');
    await until(() => expect(text()).toContain('Your service is live.'));
  });

  it('nothing in the app asks the plan or checkout functions for anything', async () => {
    signIn();
    const calls = mockFetch(baseRoutes({ plan: MANAGED }));
    renderApp('/dashboard');
    await until(() => expect(text()).toContain('Your service is live.'));
    expect(callsTo(calls, 'POST /functions/v1/change-plan')).toHaveLength(0);
    expect(callsTo(calls, 'POST /functions/v1/create-checkout')).toHaveLength(0);
  });
});
