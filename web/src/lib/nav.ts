// Leaving the app (to /login, to Stripe, to a label file) goes through here, so it is one place to follow and to test.
export const leave = {
  to(url: string) { window.location.href = url; },
  open(url: string) { window.open(url, '_blank', 'noopener'); },
};
