// News articles. Add one entry, run `node scripts/build-news.mjs`, commit the generated files.
// `image`: set to '/assets/news/<file>.jpg' once a photo exists; until then the on-brand drawn cover is used.
export const articles = [
  {
    slug: 'eu-3-euro-customs-duty-small-parcels',
    title: 'The €3 customs duty on small parcels is here: what it means for sellers shipping from China',
    summary: 'Since 1 July 2026 the EU charges a flat €3 duty on every item in parcels worth up to €150. Here is how it is counted and how to keep your cost per order under control.',
    date: '2026-10-04', minutes: 4, tag: 'Customs', cover: 'customs', image: null,
    body: `
<p>Since <strong>1 July 2026</strong>, goods bought online from outside the EU in consignments worth <strong>up to €150</strong> carry a flat customs duty of <strong>€3</strong>. The measure ends the long-standing situation in which many small parcels entered the EU with no duty at all. According to the European Commission, the seller or importer is responsible for declaring and paying the duty.</p>
<h2>How the €3 is counted</h2>
<p>The duty is applied <strong>per item based on tariff classification, not quantity</strong>. In practice that means the number of different customs (HS) codes in the parcel decides the bill:</p>
<ul>
<li>Five identical T-shirts share one code: <strong>€3</strong> in total.</li>
<li>A T-shirt and a toy have two codes: <strong>€6</strong> in total.</li>
<li>A mixed parcel with four different product types: <strong>€12</strong>, however small each item is.</li>
</ul>
<p>The €3 applies on top of import VAT, which is unchanged. The EU has described the duty as an <strong>interim measure that runs until 1 July 2028</strong>, while a permanent customs regime is prepared under which standard tariff rates would apply to all imports whatever their value. Law firms cite Council Regulation (EU) 2026/382 as the legal basis.</p>
<h2>A handling fee may follow</h2>
<p>Several advisers also report a separate customs handling fee of about €2 per item, expected from November 2026. Treat that figure as <strong>not yet final</strong>: check the current status before you put it into your pricing.</p>
<h2>Why low-priced, many-code orders suffer most</h2>
<p>A flat €3 hurts most where the product price is small. On a €12 accessory it is a quarter of the price. Orders that mix several product types in one parcel are hit repeatedly, because every extra tariff line adds another €3.</p>
<h2>What sellers can do</h2>
<ol>
<li><strong>Know your codes.</strong> List the HS code of every SKU and count how many distinct codes a typical order contains.</li>
<li><strong>Model the landed cost per order.</strong> Add €3 per distinct code to your product price, shipping and VAT, and check your margin on your cheapest and most mixed baskets.</li>
<li><strong>Consider stocking in the EU.</strong> The flat duty targets low-value consignments sent one by one. Goods imported in bulk are cleared once at the normal tariff for their code, then shipped to customers from inside the EU, which removes the per-parcel charge. Compare both routes for your product mix.</li>
<li><strong>Keep your declarations accurate.</strong> Authorities are targeting undervaluation and split shipments. Wrong codes or values now cost more than the duty itself.</li>
</ol>
<p>Importing in bulk to a hub in the middle of the EU and shipping locally is exactly the situation 2ACE is set up for: import and customs are quoted per shipment, and stock is picked and sent from Poland.</p>
<p class="note">This article is general information, not legal or customs advice. Rules and fees can change, so confirm the details with your customs broker or the national customs authority.</p>`,
    sources: [
      ['European Commission: €3 customs duty for low-value parcels', 'https://commission.europa.eu/news-and-media/news/ensuring-fairness-and-safety-eur3-customs-duty-low-value-parcels-2026-06-29_en'],
      ['Lexology: EU introduces EUR 3 customs duty on low-value imports', 'https://www.lexology.com/library/detail.aspx?g=070f59c7-84e1-4d86-9aff-66963aba1f46'],
      ['Switzerland Global Enterprise: EU flat-rate customs duty for small parcels', 'https://www.s-ge.com/export/en/articles/export-knowhow/eu-flat-rate-customs-duty-small-parcels-new-july-2026'],
      ['VATcalc: EU €3 duty on low-value e-commerce parcels', 'https://www.vatcalc.com/eu/eu-e3-levy-low-value-e-commerce-import-package-july-2026/'],
    ],
  },
  {
    slug: 'eu-packaging-regulation-ppwr-epr-online-sellers',
    title: 'EU packaging rules now apply: what online sellers must do about EPR registration',
    summary: 'The Packaging and Packaging Waste Regulation applies from 12 August 2026. If you ship packaged goods into an EU country, you may need to register there, with a local representative if you are not established.',
    date: '2026-10-03', minutes: 4, tag: 'Packaging', cover: 'packaging', image: null,
    body: `
<p>Regulation (EU) 2025/40, the <strong>Packaging and Packaging Waste Regulation (PPWR)</strong>, has applied since <strong>12 August 2026</strong>. It covers the whole life of packaging: design, substances, labelling, reuse, collection, recycling and the producer's responsibility for the packaging it puts on the market.</p>
<h2>EPR: who counts as the producer</h2>
<p>Under <strong>extended producer responsibility (EPR)</strong>, whoever makes packaging, or packaged products, available in an EU country for the first time carries the end-of-life obligation. That includes online sellers shipping to consumers, not only manufacturers. Producers must be <strong>registered in each Member State's producer register</strong>, country by country.</p>
<p>If your company is <strong>not established</strong> in a country you sell to, you must appoint an <strong>authorised representative</strong> there by written mandate. Online marketplaces must also obtain producers' registration information before they let them sell.</p>
<h2>Poland in practice</h2>
<p>In Poland, producers register in the <strong>BDO</strong> database and receive a BDO number before placing packaging on the market. Advisers note that there is no minimum volume: registration applies from the first item. A seller without a seat or branch in Poland needs a Polish authorised representative to register and report for it. A new Polish packaging act is being drafted, with a per-kilogram fee system under NFOŚiGW, so check the final text when it is adopted.</p>
<h2>Other requirements to know about</h2>
<ul>
<li><strong>Substances (Article 5):</strong> lead, cadmium, mercury and hexavalent chromium are limited to 100 mg/kg combined, and PFAS limits apply to food-contact packaging.</li>
<li><strong>Minimisation (Article 10):</strong> excess weight, volume and empty space must be avoided. The Commission is to set limits for common formats, which matters for e-commerce boxes.</li>
<li><strong>Labelling (Article 12):</strong> material pictograms, the producer's details and a QR code for disposal information, with detail set by implementing acts.</li>
<li><strong>Recycled content (Article 7):</strong> from 1 January 2030, plastic packaging must contain a minimum share of recycled content, 10% to 35% depending on type.</li>
</ul>
<h2>A practical checklist</h2>
<ol>
<li>List every country you ship to and where you are established.</li>
<li>For each country without an establishment, appoint a representative and register.</li>
<li>Record the weight of packaging by material for each country, because reporting and fees follow from it.</li>
<li>Right-size your boxes and fillers: less empty space lowers both fees and shipping cost.</li>
<li>Ask your packaging suppliers for declarations on substances and recyclability.</li>
</ol>
<p>Where your stock sits matters for these records. Keeping goods in a single EU hub and shipping domestically from there means fewer countries and fewer flows to track.</p>
<p class="note">This article is general information, not legal advice. National rules are still being finalised in several countries, so confirm your obligations with a compliance adviser.</p>`,
    sources: [
      ['EUR-Lex: Regulation (EU) 2025/40 (PPWR)', 'https://eur-lex.europa.eu/eli/reg/2025/40/oj/eng'],
      ['Gleiss Lutz: The new EU Packaging Regulation, key requirements from August 2026', 'https://www.gleisslutz.com/en/know-how/new-eu-packaging-regulation-key-requirements-august-2026'],
      ['Bird & Bird: PPWR, new obligations for all those who place products in packaging', 'https://www.twobirds.com/en/insights/2026/belgium/ppwr--packaging-and-packaging-waste-regulation-new-obligations-for-all-those-who-place-products-in-p'],
      ['Gramta: EPR in Poland, BDO registration and fees', 'https://gramta.com/articles/epr-poland'],
      ['Lappa: Poland EPR guide', 'https://lappa.org/guides/epr/poland-epr/'],
    ],
  },
  {
    slug: 'selling-electronics-in-the-eu-ce-rohs-weee-checklist',
    title: 'Selling electronics in the EU: the CE, RoHS and WEEE checklist',
    summary: 'Electronic products need more than a supplier\'s promise. Here are the steps, from the CE mark and declaration of conformity to WEEE registration in each country you sell to.',
    date: '2026-10-02', minutes: 5, tag: 'Compliance', cover: 'electronics', image: null,
    body: `
<p>Electronics are among the most regulated products you can sell in the EU, and the checks happen at the border, on marketplaces and at customer complaints. This is a plain-language checklist of what is usually required before a consumer electronic product goes on sale.</p>
<h2>1. CE marking and the declaration of conformity</h2>
<p>To sell electronics legally you must sign a <strong>Declaration of Conformity</strong> and affix the <strong>CE mark</strong>, which states that the product meets EU safety, health and environmental requirements. The steps are:</p>
<ol>
<li><strong>Identify the directives that apply.</strong> Most devices fall under the <strong>EMC Directive</strong> (electromagnetic interference) and the <strong>Low Voltage Directive</strong> (electrical equipment within certain voltage ranges). Anything with Bluetooth or Wi-Fi also falls under the <strong>Radio Equipment Directive</strong>.</li>
<li><strong>Test the product</strong> against the relevant standards.</li>
<li><strong>Prepare the technical documentation</strong> file that shows how the product complies.</li>
<li><strong>Verify RoHS compliance:</strong> the <strong>RoHS Directive</strong> restricts hazardous substances such as lead, mercury and cadmium in electronic equipment.</li>
<li><strong>Sign the Declaration of Conformity</strong>, affix the CE mark and place the product on the market.</li>
</ol>
<p>If the manufacturer is outside the EU, an <strong>EU authorised representative</strong> is normally needed to handle the documentation and contact with authorities.</p>
<h2>2. A responsible person in the EU</h2>
<p>Under the <strong>General Product Safety Regulation (GPSR)</strong>, almost every consumer product sold in the EU needs an <strong>EU-based responsible economic operator</strong>, even when you sell through a marketplace. Their name and address must appear on the product or its packaging.</p>
<h2>3. WEEE registration, country by country</h2>
<p>Electrical and electronic equipment falls under <strong>producer responsibility for waste (WEEE)</strong>. Registration is required <strong>before you sell</strong> an electronic product in an EU country, and each country has its own number, reporting schedule and fees. Selling in four countries can mean four registrations.</p>
<p>In Poland, registration is done in the <strong>BDO</strong> database. A foreign seller without a Polish seat appoints a Polish authorised representative to register and report on its behalf.</p>
<h2>4. Batteries and packaging</h2>
<ul>
<li><strong>Batteries:</strong> products containing batteries have their own EPR registration. Enforcement of the battery rules began on 18 August 2025, and large marketplaces ask for country-specific registration numbers.</li>
<li><strong>Packaging:</strong> the packaging your product ships in brings its own producer registration under the new EU packaging regulation. See our article on the PPWR.</li>
</ul>
<h2>Finished products and loose components</h2>
<p>The checklist above describes <strong>finished consumer products</strong>. If you sell loose electronic components to other manufacturers, the rules are different, because the finished device carries the CE mark. Confirm with a testing laboratory which category your product falls into before you decide what you need.</p>
<h2>The short version</h2>
<ol>
<li>Directives identified, tests done, technical file ready.</li>
<li>Declaration of Conformity signed and CE mark on the product.</li>
<li>EU authorised representative and GPSR responsible person named.</li>
<li>WEEE (and battery) registration in every country you sell to.</li>
<li>Packaging registration for the same countries.</li>
</ol>
<p>Check each item with your supplier before you pay for a shipment. Stock that cannot be sold legally is expensive to store, return or destroy.</p>
<p class="note">This article is general information, not legal or technical advice. Requirements depend on the exact product, so confirm them with a notified body, test laboratory or compliance adviser.</p>`,
    sources: [
      ['EcoComply: Selling electronics in the EU, compliance guide', 'https://ecocomply.ai/blog/selling-electronics-in-the-eu'],
      ['EcoComply: EPR registration for sellers in the EU, WEEE, batteries and packaging', 'https://ecocomply.ai/blog/epr-registration-for-amazon-sellers'],
      ['FLEX. Logistics: EU electronics compliance guide', 'https://flexlogistics.eu/eu-electronics-compliance-guide/'],
      ['Lappa: EPR compliance in Europe 2026 for marketplaces and online sellers', 'https://lappa.org/blog/epr/epr-compliance-in-europe-2026-for-marketplaces-and-online-sellers-2/'],
      ['Gramta: EPR in Poland, BDO registration and fees', 'https://gramta.com/articles/epr-poland'],
    ],
  },
];
