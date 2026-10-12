// Search and sharing metadata for the hand-written pages: title, description, canonical, link previews, icons, noindex for private pages,
// and the structured data on the homepage. Also writes llms.txt (a plain summary for AI assistants) and site.webmanifest.
// Idempotent: the generated head block sits between SEO markers. Run: node scripts/build-seo.mjs
import fs from 'node:fs';
import { SITE, iconTags, socialTags } from './seo-head.mjs';
const file = (f) => new URL('../' + f, import.meta.url);
const read = (f) => fs.readFileSync(file(f), 'utf8');
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

import { MARKET_ENABLED } from './features.mjs';
const pages = [
  { f: 'index.html', url: '/', title: '2ACE | Warehousing and fulfillment in Poland', preload: '/assets/seq/b000.webp', desc: 'Warehousing in Poland at or below market prices: pallets and shelf space from 35 zł a month, packing from 2.89 zł, no monthly minimum. Import, customs and a .pl storefront.', ld: true },
  ...(MARKET_ENABLED ? [{ f: 'market.html', url: '/market', title: '2ACE Market | Sell in Europe without building a website', desc: 'Sell on the 2ACE marketplace with no setup and no monthly fee. You pay a commission of 3.6% to 9.2% by category, only when something sells.' }] : []),
  { f: 'about.html', url: '/about', title: 'About 2ACE | Warehousing run by operators', desc: 'A Chinese and Egyptian partnership with a long history in manufacturing, sales and operations, based in China and Poland to run your storage and fulfillment smoothly.' },
  { f: 'book.html', url: '/book', title: 'Book a call | 2ACE', desc: 'Book a call with 2ACE in English, Chinese or Arabic. Pick a time that suits you, no account needed. We confirm by email with a calendar invitation and a meeting link.' },
  { f: 'terms.html', url: '/terms', title: 'Terms of service | 2ACE', desc: 'The terms of the 2ACE service: plans, billing, service levels, insurance, customs and domains.' },
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
    { '@type': 'WebSite', '@id': SITE + '/#website', url: SITE, name: '2ACE', inLanguage: 'en', publisher: { '@id': SITE + '/#org' } },
    {
      '@type': 'Service', '@id': SITE + '/#service', name: 'Warehousing and fulfillment in Poland', serviceType: 'Warehousing, e-commerce fulfillment, returns handling, import and customs',
      provider: { '@id': SITE + '/#org' }, areaServed: [{ '@type': 'Country', name: 'Poland' }, { '@type': 'Place', name: 'European Union' }],
      description: 'Pallet and shelf storage in a warehouse in Poland at or below market prices, with fulfillment, returns, import and customs help, company set-up in Poland and a hosted .pl storefront. No monthly minimum, no minimum term, priced online.',
      hasOfferCatalog: {
        '@type': 'OfferCatalog', name: '2ACE services and prices (net of VAT)',
        itemListElement: [
          offer('Pallet storage', 'A pallet place (120 × 80 cm) for your goods, resized month to month.', unit(35, 'per pallet place per month')),
          offer('Shelf storage', 'Shelf space for small items picked one by one, sold by the m³.', unit(35, 'per m³ per month')),
          offer('E-commerce fulfillment', 'Pick, pack and same-day dispatch, by parcel size.', unit(2.89, 'per order, from')),
          offer('.pl storefront', 'A designed and hosted .pl online shop, domain included.', [unit(199, 'per month'), unit(2950, 'one-time setup')]),
          ...(MARKET_ENABLED ? [{ '@type': 'Offer', itemOffered: { '@type': 'Service', name: '2ACE Market', description: 'Sell on the 2ACE marketplace with no setup or monthly fee. A commission of 3.6% to 9.2% applies by category, only when something sells.' } }] : []),
          { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Import and customs', description: 'Freight and customs clearance into Poland, quoted per shipment.' } },
        ],
      },
    },
  ],
});
const GRAPH = graph('en');

const START = '<!-- SEO:START (generated by scripts/build-seo.mjs, do not edit by hand) -->', END = '<!-- SEO:END -->';
for (const p of pages) {
  let html = read(p.f);
  const i = html.indexOf('</head>'); if (i < 0) throw new Error(p.f + ': no </head>');
  let head = html.slice(0, i), rest = html.slice(i);
  head = head.replace(new RegExp(START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n?'), '');
  head = head.replace(/<title>[\s\S]*?<\/title>\s*/, '').replace(/<meta name="description"[^>]*>\s*/, '');
  const desc = p.desc; if (!desc) throw new Error(p.f + ': no description');
  const block = START + '\n' + (p.preload ? '<link rel="preload" as="image" href="' + p.preload + '" type="image/webp">' : '') + '<title>' + attr(p.title).replace(/&amp;/g, '&amp;') + '</title><meta name="description" content="' + attr(desc.replace(/&amp;/g, '&')) + '">' + (p.noindex && !/name="robots"/.test(head) ? '<meta name="robots" content="noindex, nofollow">' : '') + iconTags() +
    (p.noindex ? '' : socialTags({ title: p.title, desc: desc.replace(/&amp;/g, '&'), url: p.url, image: p.image })) +
    (p.ld ? '<script type="application/ld+json">' + JSON.stringify(GRAPH) + '</script>' : '') + '\n' + END + '\n';
  const m = head.match(/<meta name="viewport"[^>]*>\s*/); if (!m) throw new Error(p.f + ': no viewport meta');
  const at = m.index + m[0].length;
  fs.writeFileSync(file(p.f), head.slice(0, at) + block + head.slice(at) + rest);
}

// llms.txt: a short, plain-language profile for AI assistants (https://llmstxt.org).
fs.writeFileSync(file('llms.txt'), `# 2ACE

> 2ACE is a warehousing and fulfillment company in Warsaw, Poland. Brands (especially overseas sellers) store goods on pallets and shelves at or below Polish market prices, import goods into the EU, and have orders picked, packed, shipped and returned from one hub. Everything is priced online as a monthly plan with no minimum term, and run from one customer dashboard.

## What 2ACE offers (prices in PLN, net of VAT)
- Storage: 35 zł per pallet place per month and 35 zł per m³ of shelf space per month, at or below the Polish market. No monthly minimum.
- E-commerce fulfillment: pay as you go, no monthly fee. From 2.89 zł per order (2.89 / 3.49 / 4.90 / 7.50 / 11.50 zł by parcel size). Same-day dispatch for orders before 15:00. Shipping labels at the carrier price plus 20%.
- Returns: pay as you go, no monthly fee. From 3.90 zł per return (3.90 / 4.70 / 6.60 / 10.10 / 15.50 zł by parcel size). The customer issues the return label in their dashboard. Items graded within 48 hours.
- Import and customs: freight and customs clearance into Poland, quoted per shipment.
- .pl storefront: 199 zł per month plus 2,950 zł one-time setup, domain included.
- Company set-up and compliance in Poland (company, VAT, EORI, packaging EPR, KSeF e-invoicing): quoted per case.
- Included: support in Chinese, Polish and English, photo reports on damaged goods, one monthly invoice.
${MARKET_ENABLED ? '- 2ACE Market: sell on the 2ACE marketplace with no setup or monthly fee. Commission 3.6% to 9.2% by category, only when something sells.\n' : ''}- Plans are monthly, billed in advance, cancel or resize with 30 days notice. VAT: 23% for Polish companies, reverse charge for EU companies with a VAT number.

## Pages
- [Home](${SITE}/): overview of the services and prices.
- [Build your plan](${SITE}/app/plan): choose pallet places, shelf space and services, see the monthly price, sign and pay online.
${MARKET_ENABLED ? `- [2ACE Market](${SITE}/market): the marketplace and its commission by category.\n` : ''}- [Help and user guide](${SITE}/help): step-by-step guide to the customer account with examples (PDF: ${SITE}/assets/2ACE-Customer-Guide.pdf).
- [News](${SITE}/news): plain-language articles on EU customs, packaging law, product compliance and opening a company in Poland.
- [Book a call](${SITE}/book): book a call in English, Chinese or Arabic, no account needed.
- [About 2ACE](${SITE}/about): who runs the company (a Chinese and Egyptian partnership based in China and Poland) and why.
- [Terms of service](${SITE}/terms) and [Privacy policy](${SITE}/privacy).

## Company
2ACE spółka z ograniczoną odpowiedzialnością, ul. Ostrobramska 101A lok. 301, 04-041 Warszawa, Poland. NIP 1133212948, REGON 545746743, KRS 0001267111.
Email: hello@2ace.pl. Telephone: +48 608 180 946. Languages: English and Polish.

## Notes for assistants
- Quote prices as net of VAT and point to ${SITE}/app/plan for the current figures.
- Customer accounts, billing and the admin panel are private and are not part of this site's public content.
`);

fs.writeFileSync(file('site.webmanifest'), JSON.stringify({
  name: '2ACE', short_name: '2ACE', description: 'Warehousing and fulfillment in Poland', start_url: '/', display: 'standalone', background_color: '#0B0C0E', theme_color: '#0B0C0E',
  icons: [{ src: '/assets/icons/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/assets/icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
}, null, 2) + '\n');
console.log('SEO block written to', pages.map((p) => p.f).join(', '));
