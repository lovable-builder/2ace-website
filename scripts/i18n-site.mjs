// Every piece of English text on the public website that assets/i18n.js translates, and how complete the catalogues are.
// The keys come from running assets/i18n.js in "collect" mode over each page (so they are exactly what it looks up in the
// browser), plus DYNAMIC: the messages the pages' own scripts write later.
//
//   node scripts/i18n-site.mjs              summary: keys, missing and unused translations per language
//   node scripts/i18n-site.mjs --missing pl the keys Polish still lacks, as JSON (fill them in assets/i18n/pl.json)
//   node scripts/i18n-site.mjs --sort       rewrite the catalogues sorted by key, without unused entries
// Needs `npm install` once inside tests/ (for jsdom). After changing a page, run this and translate what is missing.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const root = new URL('../', import.meta.url);
const require = createRequire(new URL('tests/package.json', root));
const { JSDOM } = require('jsdom');

export const LANGS = ['pl', 'zh'];
export const PAGES = [
  'index.html', 'about.html', 'help.html', 'privacy.html', 'terms.html', 'login.html', 'account.html',
  ...fs.readdirSync(new URL('news/', root)).filter((f) => f.endsWith('.html')).sort().map((f) => 'news/' + f),
];

// Text the pages' scripts write after loading. {name} stands for a value filled in at runtime.
export const DYNAMIC = [
  // index.html: loader, signed-in greeting, contact form
  'LOADING {pct}%', 'READY', 'Dashboard', 'Welcome', 'Welcome, {name}',
  'Please add your name and a valid email.', 'Sending...', 'Sent', 'Sent. We reply from hello@2ace.pl within one working day.',
  'Could not send. Please try again or email hello@2ace.pl.',
  // login.html
  'Create your account', 'Welcome back', 'One account for your plan, stock, orders and billing.', 'Log in to see your plan, stock and orders.',
  'Wrong email or password.', 'Please confirm your email first. Check your inbox for the link.', 'That email already has an account. Try logging in.',
  'Too many attempts. Please wait a minute and try again.', 'Enter your email and password.', 'Logging in...', 'Enter your full name.',
  'Enter a valid email.', 'Use at least 8 characters for the password.', 'Enter your company name.', 'Select your country.',
  'Select your voivodeship.', 'Creating account...', 'Check your inbox. We sent a confirmation link to {email}.',
  'Type your email above first, then click Forgot password.', 'If that email has an account, a reset link is on its way.',
  'Use at least 8 characters.', 'Password updated. Taking you to your dashboard...',
  // countries.js (login and account): the country list and tax number labels
  'Select country', 'Select voivodeship', 'Tax / VAT number', 'Poland', 'Germany', 'Czechia', 'Slovakia', 'Lithuania', 'Netherlands',
  'France', 'Italy', 'Spain', 'Ukraine', 'Türkiye', 'United Kingdom', 'United States', 'China', 'United Arab Emirates', 'Other country',
  'PVM code (VAT)', 'EDRPOU code', 'Vergi No (tax ID)', 'VAT / Company No.', 'Unified Social Credit Code', 'TRN (tax ID)',
  'Business registration number', 'Registration number',
  // account.html
  'Signed in as {email}', 'Company created. You can now upload a logo.', 'Could not create company: {error}', 'Could not load invoices: {error}',
  'Could not process the image', 'Could not remove the logo.', 'Could not save: {error}', 'Could not upload: {error}', 'Enter the company name.',
  'Enter your name.', 'Loading invoices...', 'Logo removed.', 'Logo updated.',
  'No company is linked to this account yet. Fill in the details below and save to create it. You can then upload a logo.',
  'No invoices yet. They appear here after your first payment.', 'No subscription yet. Build a plan to get started.',
  'Not saved: you do not have permission to edit this company.', 'Only the account owner or finance role can edit company details.',
  'Opening billing portal...', 'Password changed.', 'Remove your logo?', 'Saved.', 'Saving...', 'Select a country.',
  'That file is not a valid image', 'That file is too large. Pick one under 4 MB.', 'Uploading...', 'Use a PNG, JPG or WebP image.',
  'Subscription: {status}', 'Subscription: {status} · renews {date}', 'Subscription: {status} · ends {date}',
  'active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'paid', 'open', 'void', 'View',
  // the language menu
  'Language',
];

const I18N_JS = fs.readFileSync(new URL('assets/i18n.js', root), 'utf8');

// The keys assets/i18n.js looks up on one page, before any of the page's own scripts run.
export function pageKeys(file) {
  const html = fs.readFileSync(new URL(file, root), 'utf8');
  const dom = new JSDOM(html, { url: 'https://2ace.pl/' + file, runScripts: 'outside-only' });
  const w = dom.window;
  w.eval('window.ACE_I18N_COLLECT = true;\n' + I18N_JS);
  w.aceI18n.collectHead();
  w.aceI18n.translate(w.document.body);
  const keys = w.aceI18n.keys();
  w.close();
  return keys;
}

export function allKeys() {
  const by = new Map();
  for (const f of PAGES) for (const k of pageKeys(f)) if (!by.has(k)) by.set(k, f);
  for (const k of DYNAMIC) if (!by.has(k)) by.set(k, 'script');
  return by;
}

export const catalogPath = (l) => new URL('assets/i18n/' + l + '.json', root);
export const readCatalog = (l) => (fs.existsSync(catalogPath(l)) ? JSON.parse(fs.readFileSync(catalogPath(l), 'utf8')) : {});

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  const keys = allKeys();
  const arg = process.argv[2];
  if (arg === '--missing') {
    const cat = readCatalog(process.argv[3]);
    const out = {};
    for (const [k, f] of keys) if (!cat[k]) (out[f] ??= []).push(k);
    console.log(JSON.stringify(out, null, 1));
  } else if (arg === '--keys') {
    console.log(JSON.stringify(Object.fromEntries(keys), null, 1));
  } else if (arg === '--sort') {
    for (const l of LANGS) {
      const cat = readCatalog(l), out = {};
      for (const k of [...keys.keys()].sort()) if (cat[k]) out[k] = cat[k];
      fs.writeFileSync(catalogPath(l), JSON.stringify(out, null, 1) + '\n');
    }
  } else {
    console.log(keys.size + ' keys on ' + PAGES.length + ' pages');
    for (const l of LANGS) {
      const cat = readCatalog(l);
      const missing = [...keys.keys()].filter((k) => !cat[k]), unused = Object.keys(cat).filter((k) => !keys.has(k));
      console.log(l + ': ' + missing.length + ' missing, ' + unused.length + ' unused');
    }
  }
}
