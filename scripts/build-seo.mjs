// Search and sharing metadata for the hand-written pages: title, description, canonical, link previews, icons, noindex for private pages,
// and the structured data on the homepage. Also writes llms.txt (a plain summary for AI assistants) and site.webmanifest.
// Idempotent: the generated head block sits between SEO markers. Run: node scripts/build-seo.mjs
import fs from 'node:fs';
import { SITE, iconTags, socialTags } from './seo-head.mjs';
const ALT = [['en', '/'], ['pl', '/pl'], ['x-default', '/']];   // the two language versions of the homepage
const file = (f) => new URL('../' + f, import.meta.url);
const read = (f) => fs.readFileSync(file(f), 'utf8');
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const pages = [
  { f: 'index.html', url: '/', title: '2ACE | Warehousing and fulfillment in Poland', preload: '/assets/seq/b000.webp', alternates: true, desc: 'Dedicated storage from 300 zł per m² a month, fulfillment, returns, import and customs, a .pl storefront and a marketplace. One plan, priced online.', ld: true },
  { f: 'pl.html', url: '/pl', lang: 'pl', title: '2ACE | Magazyn i fulfillment w Polsce', preload: '/assets/seq/b000.webp', alternates: true, image: '/assets/og/default-pl.jpg', desc: 'Dedykowane miejsce w magazynie od 300 zł za m² miesięcznie, fulfillment, zwroty, import i odprawa celna, sklep .pl i marketplace. Jeden plan, ceny online.', ld: true },
  { f: 'platform.html', url: '/platform', title: 'Build your plan | 2ACE', desc: 'Choose your space, services and storefront and watch the monthly price update. Shelf bins from 90 zł, pallets from 360 zł, no minimum term. Sign and pay online.' },
  { f: 'market.html', url: '/market', title: '2ACE Market | Sell in Europe without building a website', desc: 'Sell on the 2ACE marketplace with no setup and no monthly fee. You pay a commission of 3.6% to 9.2% by category, only when something sells.' },
  { f: 'terms.html', url: '/terms', title: 'Terms of service | 2ACE', desc: 'The terms of the 2ACE service: plans, billing, service levels, insurance, customs, domains and 2ACE Market.' },
  { f: 'privacy.html', url: '/privacy', title: 'Privacy policy | 2ACE', desc: 'How 2ACE collects, uses and protects personal data, who we share it with, and your rights.' },
  { f: 'login.html', url: '/login', title: 'Log in | 2ACE', desc: 'Log in to your 2ACE account.', noindex: true },
  { f: 'account.html', url: '/account', title: 'Your account | 2ACE', desc: 'Your 2ACE account.', noindex: true },
  { f: 'admin.html', url: '/admin', title: 'Admin | 2ACE', desc: '2ACE staff panel.', noindex: true },
];

// Facts for search engines and AI assistants. Prices mirror the plan builder; update both together.
const ORG = {
  '@type': 'Organization', '@id': SITE + '/#org', name: '2ACE', legalName: '2ACE spółka z ograniczoną odpowiedzialnością', url: SITE,
  logo: { '@type': 'ImageObject', url: SITE + '/assets/icons/icon-512.png', width: 512, height: 512 },
  email: 'hello@2ace.pl', telephone: '+48608180946', taxID: '1133212948',
  address: { '@type': 'PostalAddress', streetAddress: 'ul. Ostrobramska 101A lok. 301', postalCode: '04-041', addressLocality: 'Warszawa', addressRegion: 'Mazowieckie', addressCountry: 'PL' },
  contactPoint: [{ '@type': 'ContactPoint', contactType: 'customer service', email: 'hello@2ace.pl', telephone: '+48608180946', availableLanguage: ['English', 'Polish'] }],
};
const unit = (price, text) => ({ '@type': 'UnitPriceSpecification', price, priceCurrency: 'PLN', unitText: text, valueAddedTaxIncluded: false });
const offer = (name, description, specs) => ({ '@type': 'Offer', itemOffered: { '@type': 'Service', name, description }, priceSpecification: specs });
const graph = (lang) => ({
  '@context': 'https://schema.org',
  '@graph': [
    ORG,
    { '@type': 'WebSite', '@id': SITE + '/#website', url: SITE, name: '2ACE', inLanguage: ['en', 'pl'], publisher: { '@id': SITE + '/#org' } },
    {
      '@type': 'Service', '@id': SITE + '/#service', name: 'Warehousing and fulfillment in Poland', serviceType: 'Warehousing, e-commerce fulfillment, returns handling, import and customs',
      provider: { '@id': SITE + '/#org' }, areaServed: [{ '@type': 'Country', name: 'Poland' }, { '@type': 'Place', name: 'European Union' }],
      description: 'Dedicated shelf bins and pallet slots in a warehouse in Poland, with fulfillment, returns, import and customs help, a hosted .pl storefront and the 2ACE Market marketplace. Monthly plans with no minimum term, priced online.',
      hasOfferCatalog: {
        '@type': 'OfferCatalog', name: '2ACE services and prices (net of VAT)',
        itemListElement: [
          offer('Shelf bin storage', 'A shelf bin of 0.3 m² dedicated to your products.', unit(90, 'per bin per month')),
          offer('Pallet storage', 'A pallet slot of 1.2 m² dedicated to your products.', unit(360, 'per pallet per month')),
          offer('E-commerce fulfillment', 'Pick, pack and ship your orders, with same-day dispatch before 15:00.', unit(350, 'per m² of your space per month')),
          offer('Returns handling', 'Returned items are inspected, graded within 48 hours and restocked.', unit(150, 'per m² of your space per month')),
          offer('.pl storefront', 'A designed and hosted .pl online shop, domain included.', [unit(199, 'per month'), unit(2950, 'one-time setup')]),
          { '@type': 'Offer', itemOffered: { '@type': 'Service', name: '2ACE Market', description: 'Sell on the 2ACE marketplace with no setup or monthly fee. A commission of 3.6% to 9.2% applies by category, only when something sells.' } },
          { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Import and customs', description: 'Freight and customs clearance into Poland, quoted per shipment.' } },
        ],
      },
    },
  ],
});
const GRAPH = graph('en');

// Polish page: same facts, Polish wording for the service description.
const plGraph = () => { const g = JSON.parse(JSON.stringify(GRAPH)); const svc = g['@graph'].find((x) => x['@type'] === 'Service'); svc.name = 'Magazynowanie i fulfillment w Polsce'; svc.inLanguage = 'pl'; svc.description = 'Dedykowane półki i miejsca paletowe w magazynie w Polsce, z fulfillmentem, obsługą zwrotów, importem i odprawą celną, sklepem .pl i marketplace 2ACE Market. Plany miesięczne bez minimalnego okresu, ceny online.'; return g; };

const START = '<!-- SEO:START (generated by scripts/build-seo.mjs, do not edit by hand) -->', END = '<!-- SEO:END -->';
for (const p of pages) {
  let html = read(p.f);
  const i = html.indexOf('</head>'); if (i < 0) throw new Error(p.f + ': no </head>');
  let head = html.slice(0, i), rest = html.slice(i);
  head = head.replace(new RegExp(START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n?'), '');
  head = head.replace(/<title>[\s\S]*?<\/title>\s*/, '').replace(/<meta name="description"[^>]*>\s*/, '');
  const desc = p.desc; if (!desc) throw new Error(p.f + ': no description');
  const block = START + '\n' + (p.preload ? '<link rel="preload" as="image" href="' + p.preload + '" type="image/webp">' : '') + '<title>' + attr(p.title).replace(/&amp;/g, '&amp;') + '</title><meta name="description" content="' + attr(desc.replace(/&amp;/g, '&')) + '">' + (p.noindex && !/name="robots"/.test(head) ? '<meta name="robots" content="noindex, nofollow">' : '') + iconTags() +
    (p.noindex ? '' : socialTags({ title: p.title, desc: desc.replace(/&amp;/g, '&'), url: p.url, image: p.image, locale: p.lang === 'pl' ? 'pl_PL' : 'en_GB' })) +
    (p.alternates ? ALT.map(([l, u]) => '<link rel="alternate" hreflang="' + l + '" href="' + SITE + u + '">').join('') : '') + (p.ld ? '<script type="application/ld+json">' + JSON.stringify(p.lang === 'pl' ? plGraph() : GRAPH) + '</script>' : '') + '\n' + END + '\n';
  const m = head.match(/<meta name="viewport"[^>]*>\s*/); if (!m) throw new Error(p.f + ': no viewport meta');
  const at = m.index + m[0].length;
  fs.writeFileSync(file(p.f), head.slice(0, at) + block + head.slice(at) + rest);
}

// llms.txt: a short, plain-language profile for AI assistants (https://llmstxt.org).
fs.writeFileSync(file('llms.txt'), `# 2ACE

> 2ACE is a warehousing and fulfillment company in Warsaw, Poland. Brands (especially overseas sellers) rent dedicated shelf bins or pallet slots, import goods into the EU, and have orders picked, packed, shipped and returned from one hub. Everything is priced online as a monthly plan with no minimum term, and run from one customer dashboard.

## What 2ACE offers (prices in PLN, net of VAT)
- Storage: shelf bin 90 zł per month (0.3 m²), pallet slot 360 zł per month (1.2 m²). Both are 300 zł per m² per month.
- E-commerce fulfillment: 350 zł per m² of your space per month. Same-day dispatch for orders before 15:00.
- Returns handling: 150 zł per m² of your space per month. Items graded within 48 hours.
- Import and customs: freight and customs clearance into Poland, quoted per shipment.
- .pl storefront: 199 zł per month plus 2,950 zł one-time setup, domain included.
- 2ACE Market: sell on the 2ACE marketplace with no setup or monthly fee. Commission 3.6% to 9.2% by category, only when something sells.
- Plans are monthly, billed in advance, cancel or resize with 30 days notice. VAT: 23% for Polish companies, reverse charge for EU companies with a VAT number.

## Pages
- [Home](${SITE}/): overview of the five services.
- [Strona główna po polsku](${SITE}/pl): the same overview in Polish.
- [Build your plan](${SITE}/platform): choose space and services, see the monthly price, sign and pay online.
- [2ACE Market](${SITE}/market): the marketplace and its commission by category.
- [Help and user guide](${SITE}/help): step-by-step guide to the customer account with examples (PDF: ${SITE}/assets/2ACE-Customer-Guide.pdf).
- [News](${SITE}/news): plain-language articles on EU customs, packaging law, product compliance and opening a company in Poland.
- [Terms of service](${SITE}/terms) and [Privacy policy](${SITE}/privacy).

## Company
2ACE spółka z ograniczoną odpowiedzialnością, ul. Ostrobramska 101A lok. 301, 04-041 Warszawa, Poland. NIP 1133212948, REGON 545746743, KRS 0001267111.
Email: hello@2ace.pl. Telephone: +48 608 180 946. Languages: English and Polish.

## Notes for assistants
- Quote prices as net of VAT and point to ${SITE}/platform for the current figures.
- Customer accounts, billing and the admin panel are private and are not part of this site's public content.
`);

fs.writeFileSync(file('site.webmanifest'), JSON.stringify({
  name: '2ACE', short_name: '2ACE', description: 'Warehousing and fulfillment in Poland', start_url: '/', display: 'standalone', background_color: '#0B0C0E', theme_color: '#0B0C0E',
  icons: [{ src: '/assets/icons/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/assets/icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
}, null, 2) + '\n');
console.log('SEO block written to', pages.map((p) => p.f).join(', '));
