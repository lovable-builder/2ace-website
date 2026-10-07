import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { baseRoutes, callsTo, mockFetch, renderApp, signIn, status, text, until, where } from './harness';

const priceBox = () => screen.getByRole('complementary', { name: 'Your plan' });
const monthly = () => priceBox().querySelector('.big')?.textContent;

describe('plan builder', () => {
  it('starts at 15 m² for 4 500 zł and updates the price as the area changes', async () => {
    mockFetch(baseRoutes());
    renderApp('/plan');
    expect(monthly()).toBe('4 500 zł');
    const box = screen.getByRole('spinbutton', { name: 'Square metres (m²)' });
    fireEvent.change(box, { target: { value: '12' } });
    expect(monthly()).toBe('3 600 zł');
    expect(text()).toContain('12 m² reserved');
    fireEvent.change(screen.getByRole('slider'), { target: { value: '100' } });
    expect(monthly()).toBe('30 000 zł');
  });

  it('a typed size out of range snaps back on leaving the box', async () => {
    mockFetch(baseRoutes());
    renderApp('/plan');
    const box = screen.getByRole('spinbutton', { name: 'Square metres (m²)' });
    fireEvent.change(box, { target: { value: '5000' } });
    fireEvent.blur(box);
    expect(monthly()).toBe('300 000 zł');
  });

  it('the estimator sets the area', async () => {
    mockFetch(baseRoutes());
    const { user } = renderApp('/plan');
    expect(text()).toContain('roughly 18 m²');
    await user.click(screen.getByRole('button', { name: 'Use 18 m²' }));
    expect(monthly()).toBe('5 400 zł');
    expect(text()).toContain('Set to 18 m².');
  });

  it('services: pay as you go with the real tariff; import & customs adds nothing monthly', async () => {
    mockFetch(baseRoutes());
    const { user } = renderApp('/plan/services');
    await until(() => expect(text()).toContain('6,00 zł to 15,00 zł per order'));
    expect(text()).toContain('9,00 zł to 22,50 zł per return');
    await user.click(screen.getByRole('button', { name: 'Add import & customs' }));
    expect(within(priceBox()).getByText('On quote')).toBeInTheDocument();
    expect(monthly()).toBe('4 500 zł');
  });

  it('without the tariff it still explains the fees, with no numbers invented', async () => {
    mockFetch({ ...baseRoutes(), 'POST /rest/v1/rpc/handling_tariff': () => status(500) });
    renderApp('/plan/services');
    await until(() => expect(text()).toContain('a fee per order, by the size of the parcel'));
  });

  it('a storefront needs a checked, free .pl name before Continue', async () => {
    const calls = mockFetch({ ...baseRoutes(), 'POST /functions/v1/domain-check': (c) => (c.body.name === 'taken' ? { status: 'taken', alternatives: ['taken-shop'] } : { status: 'free' }) });
    const { user } = renderApp('/plan/sell');
    await user.click(screen.getByRole('switch'));
    expect(within(priceBox()).getByText('+ Storefront yourbrand.pl')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Continue to review' })[0]);
    expect(text()).toContain('Enter a name for your store');
    await user.type(screen.getByRole('textbox', { name: 'Domain' }), 'taken');
    await user.click(screen.getAllByRole('button', { name: 'Continue to review' })[0]);
    expect(text()).toContain('Click Check to make sure taken.pl is available');
    await user.click(screen.getByRole('button', { name: 'Check' }));
    await until(() => expect(text()).toContain('taken.pl is already registered. Try another name or one of these:'));
    await user.click(screen.getByRole('button', { name: 'taken-shop.pl' }));
    await until(() => expect(text()).toContain('taken-shop.pl looks available'));
    expect(callsTo(calls, 'POST /functions/v1/domain-check').map((c) => c.body.name)).toEqual(['taken', 'taken-shop']);
    expect(callsTo(calls, 'POST /functions/v1/domain-check')[0].headers.Authorization).toBeUndefined();   // public: no sign-in needed
    await user.click(screen.getAllByRole('button', { name: 'Continue to review' })[0]);
    expect(where).toBe('/plan/review');
  });

  it('review: company details are required, then a visitor goes to sign-up', async () => {
    mockFetch(baseRoutes());
    const { user } = renderApp('/plan/review');
    await user.click(screen.getAllByRole('button', { name: 'Continue to sign-up' })[0]);
    expect(text()).toContain('Add your company name, business number and a valid email to activate.');
    expect(where).toBe('/plan/review');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Country of registration' }), 'PL');
    await user.type(screen.getByRole('textbox', { name: 'Company name' }), 'Acme');
    await user.type(screen.getByRole('textbox', { name: 'NIP' }), '1234567890');
    await user.type(screen.getByRole('textbox', { name: 'Work email' }), 'a@acme.pl');
    await user.click(screen.getAllByRole('button', { name: 'Continue to sign-up' })[0]);
    expect(where).toBe('/checkout');
  });

  it('keeps the plan in the browser, and restores it on the next visit', async () => {
    mockFetch(baseRoutes());
    const first = renderApp('/plan');
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Square metres (m²)' }), { target: { value: '22' } });
    await until(() => expect(JSON.parse(localStorage.getItem('ace_plan') || '{}').plan?.qty).toBe(22));
    first.unmount();
    renderApp('/plan');
    expect(monthly()).toBe('6 600 zł');
  });

  it('steps are links, so the browser Back button walks the wizard', async () => {
    mockFetch(baseRoutes());
    const { user } = renderApp('/plan');
    await user.click(screen.getByRole('link', { name: /02\s*Services/ }));
    expect(where).toBe('/plan/services');
    await user.click(screen.getAllByRole('button', { name: 'Continue to sell' })[0]);
    expect(where).toBe('/plan/sell');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(where).toBe('/plan/services');
  });
});

describe('changing an active plan', () => {
  it('starts from the current plan, prices the change once on Review, and applies it', async () => {
    signIn();
    let applied = false;
    const calls = mockFetch({
      ...baseRoutes(),
      'POST /functions/v1/change-plan': (c) => {
        if (!c.body.preview) { applied = true; return { kind: 'upgrade', newMonthly: 3600, delta: 600, todayEstimate: 300 }; }
        return c.body.config.m2 === 12 ? { kind: 'upgrade', newMonthly: 3600, delta: 600, todayEstimate: 300 } : { kind: 'downgrade', newMonthly: 2700, delta: -300, todayEstimate: -150 };
      },
      'GET /rest/v1/plans': () => [applied ? { ...{ config: { m2: 12 }, monthly_pln: 3600 } } : { config: { m2: 10, pkgs: {} }, monthly_pln: 3000 }],
    });
    const { user } = renderApp('/plan?change=1');
    await until(() => expect(text()).toContain('Changing your plan.'));
    expect(screen.getByRole('spinbutton', { name: 'Square metres (m²)' })).toHaveValue(10);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Square metres (m²)' }), { target: { value: '12' } });
    expect(text()).toContain('Upgrade +600 zł');
    await user.click(screen.getByRole('link', { name: /04\s*Review/ }));
    await until(() => expect(screen.getAllByRole('button', { name: 'Confirm upgrade' })[0]).toBeInTheDocument());
    const previews = () => callsTo(calls, 'POST /functions/v1/change-plan').filter((c) => c.body.preview);
    expect(previews()).toHaveLength(1);
    expect(previews()[0].body.config).toMatchObject({ m2: 12, tt: 'off', meta: 'off' });
    expect(text()).toContain('Charged today: about 300 zł');
    await new Promise((r) => setTimeout(r, 50));
    expect(previews()).toHaveLength(1);   // no request storm while idle
    await user.click(screen.getAllByRole('button', { name: 'Confirm upgrade' })[0]);
    await until(() => expect(text()).toContain('Your plan was upgraded. Your new price is 3 600 zł per month.'));
    expect(where).toBe('/dashboard');
    expect(text()).not.toContain('Changing your plan.');
    expect(localStorage.getItem('ace_plan')).toBeNull();
  });

  it('a server error says so and offers Try again, without a loop', async () => {
    signIn();
    const calls = mockFetch({ ...baseRoutes(), 'POST /functions/v1/change-plan': () => status(400, { error: 'Card declined' }) });
    renderApp('/plan/review?change=1');
    await until(() => expect(text()).toContain('Card declined'));
    expect(screen.getAllByRole('button', { name: 'Try again' })[0]).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(callsTo(calls, 'POST /functions/v1/change-plan')).toHaveLength(1);
  });

  it('a new customer\'s saved plan is not touched by a change', async () => {
    signIn();
    localStorage.setItem('ace_plan', JSON.stringify({ v: 2, t: Date.now(), plan: { qty: 40 } }));
    mockFetch({ ...baseRoutes(), 'POST /functions/v1/change-plan': () => ({ kind: 'same', newMonthly: 3000, delta: 0, todayEstimate: 0 }) });
    renderApp('/plan?change=1');
    await until(() => expect(text()).toContain('Changing your plan.'));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Square metres (m²)' }), { target: { value: '11' } });
    await act(() => new Promise((r) => setTimeout(r, 500)));
    expect(JSON.parse(localStorage.getItem('ace_plan')!).plan.qty).toBe(40);
  });
});
