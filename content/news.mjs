// News articles. Add one entry, run `node scripts/build-news.mjs`, commit the generated files.
// `image`: set to '/assets/news/<file>.jpg' once a photo exists; until then the on-brand drawn cover is used.
export const articles = [
  {
    slug: 'open-a-company-in-poland-pesel-trusted-profile',
    title: 'Opening a company in Poland as a foreigner: PESEL, trusted profile and the steps that follow',
    summary: 'A plain-language route from nothing to a registered Polish company: which form to choose, how to get a PESEL and a Profil Zaufany, how the registration works, and what to sort out afterwards.',
    date: '2026-10-04', minutes: 6, tag: 'Company setup', cover: 'company', image: null,
    cta: { title: 'Want help with all of this?', text: 'We can walk you through every step, from your PESEL appointment and trusted profile to registering the company and setting up your first import. Tell us where you are in the process and we will reply within one working day.', href: '/#talk', label: 'Talk to us' },
    body: `
<p>Selling into the EU is easier with a company inside it: you can register for VAT, import goods in your own name and hold stock in a hub such as Poland. Foreigners can do this, and much of it can be done online. This guide explains the order of the steps and the two things people most often get stuck on: the <strong>PESEL</strong> number and the <strong>Profil Zaufany</strong> (trusted profile).</p>
<h2>1. Choose the form</h2>
<ul>
<li><strong>Sole proprietorship (JDG):</strong> registered with CEIDG, free, no minimum capital. Whether you may register one depends on your residence status, so check that first. From <strong>1 November 2026</strong>, applications for new sole proprietorships are accepted only online, through Biznes.gov.pl or the mObywatel app.</li>
<li><strong>Limited liability company (sp. z o.o.):</strong> minimum share capital of <strong>PLN 5,000</strong>, which stays in the company as working money. It can be registered online through the S24 system. Foreign founders can be shareholders and board members.</li>
</ul>
<p>Most overseas sellers who want to import and hold stock choose the sp. z o.o., because it separates the business from you personally.</p>
<h2>2. PESEL: your Polish identification number</h2>
<p><strong>PESEL</strong> is the 11-digit national identification number. It is free. You do <strong>not</strong> need to live in Poland to get one: you need a legal reason that requires it. For example, a member of the management board of a Polish company can obtain a PESEL even without residing in Poland.</p>
<ul>
<li><strong>Where:</strong> at any municipal office (<em>urząd gminy</em>, or <em>urząd dzielnicy</em> in Warsaw).</li>
<li><strong>How:</strong> from 1 January 2026, most non-EU nationals must apply <strong>in person</strong>. Bring your passport and a hand-signed application, and state the legal basis for needing the number.</li>
<li><strong>Cost:</strong> free of charge. The office issues the decision at the same place.</li>
</ul>
<p>Strictly, you do not need a PESEL to be a shareholder or board member. But without one you cannot get the trusted profile described next, and that is the most convenient way to sign everything online.</p>
<h2>3. Profil Zaufany: your online identity for the state</h2>
<p>The <strong>Profil Zaufany</strong> is a free electronic identity that lets you log in to government services and sign documents electronically. You can have one once you have a PESEL and can prove who you are. There are three ways to confirm it:</p>
<ol>
<li><strong>Through your Polish online bank</strong>, if the bank supports it. This is the fastest route.</li>
<li><strong>By video call</strong> with an operator, using a smartphone and your identity document. The profile is usually active within 24 hours.</li>
<li><strong>In person</strong> at a confirmation point, within 14 days of applying on the official site, pz.gov.pl.</li>
</ol>
<p>With the profile you can authenticate on Biznes.gov.pl and sign your company application. The mObywatel app can then be used to log in, but it normally relies on a trusted profile you already have.</p>
<h2>4. Registering the company</h2>
<p><strong>For an sp. z o.o. through S24:</strong> create an account, authenticate and sign with either a trusted profile (which needs a PESEL) or a <strong>qualified electronic signature</strong> (which does not). Choose the standard articles template, enter the company name, seat, share capital, board members and activity codes, and pay the court fee, quoted by advisers at about <strong>PLN 350</strong>. Check the current fee on the official site. Registration commonly takes about a day.</p>
<p><strong>For a JDG:</strong> file the CEIDG application on Biznes.gov.pl with your trusted profile, electronic ID or qualified signature.</p>
<h2>5. What to do after registration</h2>
<ul>
<li><strong>Tax and statistical numbers:</strong> the company receives its NIP (tax ID), REGON and KRS number.</li>
<li><strong>VAT registration:</strong> file the VAT-R form to become an active VAT payer. Sellers who import will want this.</li>
<li><strong>Bank account:</strong> a Polish business account is usually opened with a visit by a board member, while some fintechs onboard remotely.</li>
<li><strong>KSeF e-invoicing:</strong> the national e-invoice system has applied to most VAT payers since 1 April 2026, and the smallest businesses follow later. Check which phase applies to you.</li>
<li><strong>EORI number:</strong> importers normally need one before customs will clear goods in the company's name.</li>
<li><strong>Product rules:</strong> if you ship packaged goods or electronics, see our articles on <a href="/news/eu-packaging-regulation-ppwr-epr-online-sellers">packaging registration (EPR)</a> and on <a href="/news/selling-electronics-in-the-eu-ce-rohs-weee-checklist">CE, RoHS and WEEE</a>. Also read how the new <a href="/news/eu-3-euro-customs-duty-small-parcels">€3 customs duty</a> affects small parcels.</li>
</ul>
<h2>The order, in short</h2>
<ol>
<li>Choose JDG or sp. z o.o.</li>
<li>Get your PESEL at a municipal office.</li>
<li>Activate your Profil Zaufany through your bank or by video.</li>
<li>Register the company online.</li>
<li>Register for VAT, open a bank account, set up KSeF and apply for an EORI number.</li>
</ol>
<h2>We can help you do all of this</h2>
<p>None of these steps is difficult, but together they take many appointments, forms and portals, in Polish. 2ACE can help you through the whole route, from the first office visit to a registered company and your first shipment into our warehouse in Poland, so you can start selling instead of chasing paperwork.</p>
<p class="note">This article is general information, not legal or tax advice. Rules, fees and deadlines change, and your own case depends on your nationality and residence, so confirm the details with the offices concerned or a Polish lawyer or accountant.</p>`,
    sources: [
      ['Gov.pl: Get a PESEL ID, a service for foreigners', 'https://www.gov.pl/web/gov/uzyskaj-numer-pesel--usluga-dla-cudzoziemcow-en'],
      ['Lexology: Poland, new PESEL requirements for foreign nationals', 'https://www.lexology.com/library/detail.aspx?g=ae9b7d48-323e-440a-b750-3088ae61482d'],
      ['Legalsol: how to get a PESEL number as a foreigner in 2026', 'https://www.legalsol.pl/blog/pesel-guide-en'],
      ['Careers in Poland: Trusted Profile, what it is and how to get one', 'https://www.careersinpoland.com/article/arrival-and-stay/trusted-profile-in-poland-what-is-it-and-how-go-you-get-one'],
      ['Izibiz: Profil Zaufany for foreigners', 'https://izibiz.pl/en/profil-zaufany-trusted-profile/'],
      ['Zunapro: forming an sp. z o.o. in Poland as a foreigner (S24)', 'https://www.zunapro.com/poland/en/blog/form-sp-z-oo-poland-complete-guide'],
      ['CEO.com.pl: Poland moves business registration fully online from November 2026', 'https://ceo.com.pl/en/poland-ceidg-business-registration-online-november-2026/'],
      ['Dudkowiak: e-invoicing in Poland (KSeF) 2026 to 2027', 'https://www.dudkowiak.com/tax-law-in-poland/e-invoicing-in-poland-ksef/'],
    ],
  },
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
