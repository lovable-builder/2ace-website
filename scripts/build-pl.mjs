// Builds the Polish homepage (pl.html, served at /pl) from index.html by swapping each visible English string for its Polish text.
// The layout, scroll story and scripts stay identical, so a change to index.html only needs this script re-run:
//   node scripts/build-news.mjs && node scripts/build-pl.mjs && node scripts/build-seo.mjs
// Anything on the page that has no translation here is listed at the end, so nothing is silently left in English by mistake.
import fs from 'node:fs';
const read = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');

// Visible text. Keys are the exact text as it appears in index.html (HTML entities included).
const T = {
  'Services': 'Usługi', 'Pricing': 'Cennik', 'Market': 'Market', 'Coverage': 'Zasięg', 'News': 'News', 'Log in': 'Zaloguj się', 'Log out': 'Wyloguj', 'Build your plan': 'Zbuduj plan',
  'Poland · European Union': 'Polska · Unia Europejska',
  'New products,': 'Nowe produkty,', 'delivered into Europe.': 'dostarczone do Europy.',
  'Space, fulfillment, storefront and sales in one plan. Priced online, run from one dashboard.': 'Magazyn, fulfillment, sklep i sprzedaż w jednym planie. Ceny online, wszystko z jednego panelu.',
  'Inside 2ACE': 'Wewnątrz 2ACE', 'A real floor.': 'Prawdziwy magazyn.', 'Not a middleman.': 'Nie pośrednik.',
  'Our own racks, our own team, one hub in the middle of the EU. Keep scrolling and walk the floor with us.': 'Własne regały, własny zespół, jeden hub w środku UE. Przewijaj dalej i przejdź się z nami po magazynie.',
  '01 — Space by the m²': '01 — Powierzchnia za m²', 'Pick your space.': 'Wybierz powierzchnię.', 'Pay by the m².': 'Płać za m².',
  'Shelf bins or pallets from 300 zł per m² a month. Scale up or down month to month, no yearly contract.': 'Półki lub palety od 300 zł za m² miesięcznie. Zwiększaj lub zmniejszaj powierzchnię z miesiąca na miesiąc, bez rocznej umowy.',
  '02 — Fulfillment &amp; returns': '02 — Fulfillment i zwroty', 'Order in. Parcel out.': 'Zamówienie wpada. Paczka wychodzi.', 'Returns back on sale.': 'Zwroty wracają do sprzedaży.',
  'Same-day dispatch on a 15:00 cut-off and 48-hour restocking. Add either one, priced on your space.': 'Wysyłka tego samego dnia przy zamówieniu do 15:00 i przywracanie zwrotów do sprzedaży w 48 godzin. Dodaj jedno lub drugie, cena zależy od Twojej powierzchni.',
  '03 — Import &amp; customs': '03 — Import i odprawa celna', 'Factory floor': 'Z fabryki', 'to our dock.': 'prosto na naszą rampę.',
  'Sea, air and road freight with customs cleared into Poland. Quoted per shipment and tracked live to the rack.': 'Transport morski, lotniczy i drogowy z odprawą celną do Polski. Wycena za każdą dostawę, śledzenie na żywo aż do regału.',
  '04 — Your .pl storefront': '04 — Twój sklep .pl', 'A Polish store,': 'Polski sklep,', 'wired to your stock.': 'połączony z Twoim stanem magazynowym.',
  'We build, host and connect your .pl shop. BLIK, Przelewy24 and InPost at checkout, stock synced live.': 'Budujemy, hostujemy i łączymy Twój sklep .pl. BLIK, Przelewy24 i InPost w koszyku, stany magazynowe na żywo.',
  '05 — One dashboard': '05 — Jeden panel', 'Every unit,': 'Każda sztuka,', 'on one screen.': 'na jednym ekranie.',
  'Imports, inventory, orders and returns, live. One login for your team, no emailed spreadsheets.': 'Importy, stany magazynowe, zamówienia i zwroty na żywo. Jedno logowanie dla zespołu, bez arkuszy w mailach.',
  'Five services · One plan': 'Pięć usług · Jeden plan', 'You build the brand.': 'Ty budujesz markę.', 'We hold the peace of mind.': 'My dbamy o spokój.', 'See pricing': 'Zobacz cennik',
  'SCROLL': 'PRZEWIJAJ', 'LOADING 0%': 'ŁADOWANIE 0%',
  'The platform': 'Platforma', 'Start with space. Add each service when you need it.': 'Zacznij od powierzchni. Dodawaj usługi, kiedy ich potrzebujesz.',
  'We sold online in the EU first, so we know where brands lose money. 2ACE puts the warehouse, the border, the storefront and the marketplace into one plan you build yourself and manage from one dashboard.': 'Sami najpierw sprzedawaliśmy online w UE, więc wiemy, gdzie marki tracą pieniądze. 2ACE łączy magazyn, granicę, sklep i marketplace w jednym planie, który budujesz sam i zarządzasz z jednego panelu.',
  'Space by the m²': 'Powierzchnia za m²', 'Shelf bins or pallets. Scanned on arrival, insured from that minute, resized month to month.': 'Półki lub palety. Skanowane przy przyjęciu, ubezpieczone od tej chwili, zmieniane z miesiąca na miesiąc.',
  '300 zł / m² / month': '300 zł / m² / mies.',
  'E-commerce fulfillment': 'Fulfillment e-commerce', 'Orders pulled straight from your store. Same-day dispatch on a 15:00 cut-off with InPost, DPD, DHL and GLS.': 'Zamówienia pobierane prosto z Twojego sklepu. Wysyłka tego samego dnia przy zamówieniu do 15:00, z InPost, DPD, DHL i GLS.',
  '+ 350 zł / m² / month': '+ 350 zł / m² / mies.',
  'Returns handling': 'Obsługa zwrotów', 'Inspected, graded and restocked within 48 hours, with a photo record on everything we reject.': 'Sprawdzone, ocenione i przywrócone do sprzedaży w 48 godzin, ze zdjęciami wszystkiego, co odrzucamy.',
  '+ 150 zł / m² / month': '+ 150 zł / m² / mies.',
  'Import &amp; customs': 'Import i odprawa celna', 'Freight booking, clearance, duty and VAT, CE and EU labelling. Every milestone tracked in your dashboard.': 'Rezerwacja transportu, odprawa, cło i VAT, oznakowanie CE i UE. Każdy etap widoczny w panelu.',
  'Quoted per shipment': 'Wycena za dostawę',
  '.pl storefront': 'Sklep .pl', 'A Polish web store designed, hosted and connected to your stock, with local payments and carriers at checkout.': 'Polski sklep internetowy zaprojektowany, hostowany i połączony z Twoim magazynem, z lokalnymi płatnościami i przewoźnikami w koszyku.',
  '2 950 zł setup · 199 zł / month': '2 950 zł wdrożenie · 199 zł / mies.',
  'One rate per m². Add only what you use.': 'Jedna stawka za m². Dodaj tylko to, z czego korzystasz.', 'Monthly, no minimum term. A pallet takes 1.2 m², a shelf bin 0.3 m².': 'Miesięcznie, bez minimalnego okresu. Paleta zajmuje 1,2 m², półka 0,3 m².',
  'Storage': 'Magazynowanie', 'Every plan starts here': 'Każdy plan zaczyna się tutaj', '+ Fulfillment': '+ Fulfillment', 'Pick, pack and same-day dispatch': 'Kompletacja, pakowanie i wysyłka tego samego dnia',
  '+ Returns handling': '+ Obsługa zwrotów', 'Graded and restocked in 48 h': 'Ocena i powrót do sprzedaży w 48 h', 'Full service': 'Pełna usługa', 'Per m², per month': 'Za m², miesięcznie',
  'Estimate your month': 'Oszacuj swój miesiąc', 'Floor space': 'Powierzchnia', 'Fulfillment': 'Fulfillment', 'Returns': 'Zwroty', 'PER MONTH': 'MIESIĘCZNIE', 'Build this plan': 'Zbuduj ten plan', 'Add-ons': 'Dodatki',
  'Cost depends on the value, origin and route, so we quote each shipment before it moves.': 'Koszt zależy od wartości, kraju pochodzenia i trasy, dlatego wyceniamy każdą dostawę, zanim ruszy.',
  'Designed, hosted and synced with your stock. Domain included.': 'Zaprojektowany, hostowany i zsynchronizowany z Twoim magazynem. Domena w cenie.', 'Prices in PLN, excl. VAT': 'Ceny w PLN, bez VAT',
  'New · 2ACE Market': 'Nowość · 2ACE Market', 'Skip the website. Skip the marketing bill.': 'Bez własnej strony. Bez budżetu na marketing.',
  'No website to build, no marketing to run. Your products go live on 2ACE Market, where we handle the store, the listings and the promotion. You pay a commission only when something sells, from 3.6% depending on your category.': 'Bez budowania strony, bez prowadzenia marketingu. Twoje produkty trafiają na 2ACE Market, a my zajmujemy się sklepem, ofertami i promocją. Płacisz prowizję tylko wtedy, gdy coś się sprzeda, od 3,6% w zależności od kategorii.',
  'Your own store': 'Własny sklep', '.pl storefront, designed and hosted': 'Sklep .pl, zaprojektowany i hostowany', '199 zł / mo': '199 zł / mies.', 'One-time setup': 'Jednorazowe wdrożenie', 'Fixed, before any sale': 'Stała opłata, przed pierwszą sprzedażą',
  '2ACE Market': '2ACE Market', 'Store and checkout': 'Sklep i płatności', 'Included': 'W cenie', 'Listings, photos and product copy': 'Oferty, zdjęcia i opisy produktów', 'Marketing and promotions': 'Marketing i promocje', 'Setup': 'Wdrożenie',
  'By category: Home &amp; kitchen 7.1% · Beauty &amp; health 6.4% · Fashion 9.2% · Tech accessories 3.6%. About 30% below typical marketplace rates, and payment fees are included.': 'Według kategorii: Dom i kuchnia 7,1% · Uroda i zdrowie 6,4% · Moda 9,2% · Akcesoria technologiczne 3,6%. Około 30% poniżej typowych stawek marketplace, opłaty za płatności wliczone.',
  'Only when you sell': 'Tylko gdy sprzedajesz', 'From 3.6% / sale': 'Od 3,6% / sprzedaż', 'See 2ACE Market': 'Zobacz 2ACE Market', 'Add it to your plan': 'Dodaj do planu',
  'Your plan, live in four steps.': 'Twój plan online w czterech krokach.', 'STEP 01': 'KROK 01', 'Choose your space': 'Wybierz powierzchnię',
  'Tell us how much you store, in bins, pallets or m², from 300 zł per m². The price shows before you commit, not after a sales call.': 'Powiedz, ile przechowujesz: w półkach, paletach lub m², od 300 zł za m². Cena pojawia się przed decyzją, a nie po rozmowie z handlowcem.',
  'STEP 02': 'KROK 02', 'Add the services you need': 'Dodaj potrzebne usługi', 'Fulfillment, returns and import. Tap to add each one and the price updates, and each one can come off again.': 'Fulfillment, zwroty i import. Dotknij, aby dodać każdą z nich, a cena się zaktualizuje. Każdą można też usunąć.',
  'STEP 03': 'KROK 03', 'Choose how you sell': 'Wybierz sposób sprzedaży', 'Open your own .pl store, or join 2ACE Market and pay a commission only when something sells. Add either one later.': 'Otwórz własny sklep .pl albo dołącz do 2ACE Market i płać prowizję tylko od sprzedaży. Każdą opcję możesz dodać później.',
  'STEP 04': 'KROK 04', 'Sign, pay and go live': 'Podpisz, zapłać i startuj', 'Review your plan, sign online and pay securely. Then track imports, stock and orders from one login.': 'Sprawdź plan, podpisz online i zapłać bezpiecznie. Potem śledź importy, stany i zamówienia z jednego konta.',
  'One hub in Poland reaches the whole market.': 'Jeden hub w Polsce obsługuje cały rynek.',
  'Sitting in the middle of Europe is the cheapest advantage in logistics. Road freight leaves daily and most of the continent is a two to four day promise.': 'Położenie w środku Europy to najtańsza przewaga w logistyce. Transport drogowy wyjeżdża codziennie, a większość kontynentu to dostawa w dwa do czterech dni.',
  'Poland': 'Polska', 'HUB · NEXT DAY': 'HUB · NASTĘPNY DZIEŃ', 'Germany · Czechia · Slovakia': 'Niemcy · Czechy · Słowacja', '1 — 2 DAYS': '1 — 2 DNI', 'Netherlands · Belgium · Austria': 'Holandia · Belgia · Austria',
  '2 DAYS': '2 DNI', 'France · Italy · Nordics': 'Francja · Włochy · Skandynawia', '2 — 3 DAYS': '2 — 3 DNI', 'Spain · Portugal · Greece': 'Hiszpania · Portugalia · Grecja', '3 — 4 DAYS': '3 — 4 DNI',
  'Rather talk it through first?': 'Wolisz najpierw porozmawiać?',
  'Send the product, the volume and the market. A person who runs the floor replies the same day, or go straight to building your plan.': 'Napisz, jaki masz produkt, jaki wolumen i jaki rynek. Odpowiada osoba, która prowadzi magazyn, tego samego dnia. Albo od razu zbuduj plan.',
  'Talk to sales': 'Napisz do nas', 'Sent. We reply from hello@2ace.pl within one working day.': 'Wysłano. Odpowiadamy z hello@2ace.pl w ciągu jednego dnia roboczego.',
  'What is changing for EU sellers.': 'Co zmienia się dla sprzedawców w UE.', 'All news': 'Wszystkie aktualności (EN)',
  'Space · Fulfillment · Returns · Import · Storefronts · 2ACE Market': 'Powierzchnia · Fulfillment · Zwroty · Import · Sklepy · 2ACE Market',
  'Contact': 'Kontakt', 'Help': 'Pomoc (EN)', 'Terms': 'Regulamin (EN)', 'Privacy': 'Prywatność (EN)',
};
// Text that is fine as it is: names, numbers, contact details, units, the English news article cards (those articles are English).
const KEEP = /^(2ACE|2ACE sp\. z o\.o\.|hello@2ace\.pl|\+48 608 180 946|ul\. Ostrobramska.*|NIP .*|2ACE sp\. z o\.o\. ·.*|000%|0 zł|[0-9 ]+|m²|Company setup|Customs|Packaging|Compliance|01|02|03|04|05|300 zł|350 zł|150 zł|800 zł|2 950 zł|Opening a company in Poland.*|The €3 customs duty.*|EU packaging rules.*|Selling electronics.*|[A-Z][a-z]+( [a-z]+)? [—·-] .*|Logo|Menu|PL)$/;
// Attributes
const A = {
  'aria-label="Menu"': 'aria-label="Menu"', 'alt="The 2ACE floor"': 'alt="Magazyn 2ACE"', 'alt="Inbound dock at the 2ACE facility"': 'alt="Rampa przyjęć w magazynie 2ACE"', 'alt="Pick and pack line"': 'alt="Linia kompletacji i pakowania"',
  'alt="An aisle on the 2ACE floor"': 'alt="Alejka w magazynie 2ACE"', 'alt="The floor from above"': 'alt="Magazyn z góry"',
  'placeholder="Name"': 'placeholder="Imię i nazwisko"', 'placeholder="Work email"': 'placeholder="Służbowy e-mail"', 'placeholder="What you sell, where it comes from and where it sells"': 'placeholder="Co sprzedajesz, skąd pochodzi i gdzie sprzedajesz"',
};
// Strings inside the page script (greeting, form messages, slider labels, loader).
const J = [
  ["link.textContent = 'Dashboard'", "link.textContent = 'Panel'"], ["hi.textContent = 'Welcome'", "hi.textContent = 'Witaj'"], ["hi.textContent = 'Welcome, ' + name", "hi.textContent = 'Witaj, ' + name"],
  ["'Please add your name and a valid email.'", "'Podaj imię i poprawny adres e-mail.'"], ["'Sending...'", "'Wysyłanie...'"], ["btn.textContent = 'Sent'", "btn.textContent = 'Wysłano'"],
  ["show('Sent. We reply from hello@2ace.pl within one working day.', true)", "show('Wysłano. Odpowiadamy z hello@2ace.pl w ciągu jednego dnia roboczego.', true)"],
  ["'Could not send. Please try again or email hello@2ace.pl.'", "'Nie udało się wysłać. Spróbuj ponownie lub napisz na hello@2ace.pl.'"],
  ["'LOADING '", "'ŁADOWANIE '"], ["'READY'", "'GOTOWE'"], ["'Not added'", "'Nie dodano'"],
];

let html = read('index.html');
html = html.replace(/<!-- SEO:START[\s\S]*?<!-- SEO:END -->\n?/, '');            // the English head block; build-seo writes the Polish one
html = html.replace(/<html[^>]*>/, '<html lang="pl">');
html = html.split('href="/#talk"').join('href="#talk"');   // "Contact" in the footer should stay on this page
let missing = [];
// Leave <script> and <style> bodies alone while swapping visible text (their code contains < and > too).
const blocks = [];
html = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/g, (b) => { blocks.push(b); return '\u0000' + (blocks.length - 1) + '\u0000'; });
html = html.replace(/>([^<>]+)</g, (m, raw) => {
  const t = raw.replace(/\s+/g, ' ').trim(); if (!t || t.includes('\u0000')) return m;
  if (T[t] !== undefined) return '>' + raw.replace(t, T[t]) + '<';
  if (!KEEP.test(t)) missing.push(t);
  return m;
});
html = html.replace(/\u0000(\d+)\u0000/g, (m, i) => blocks[Number(i)]);
// the language link and the two "Zaloguj" style anchors live inside tags that the pattern above already handled; swap the language switch last
html = html.replace(/<a class="navlink" href="\/pl"[^>]*>PL<\/a>/, (a) => a.replace('href="/pl"', 'href="/"').replace('lang="pl"', 'lang="en"').replace('hreflang="pl"', 'hreflang="en"').replace('title="Polski"', 'title="English"').replace('>PL<', '>EN<'));
for (const [k, v] of Object.entries(A)) { if (!html.includes(k)) missing.push('attribute ' + k); html = html.split(k).join(v); }
for (const [k, v] of J) { if (!html.includes(k)) missing.push('script ' + k); html = html.split(k).join(v); }
html = html.replace(/<footer[^>]*>[\s\S]*?<\/footer>/, (f) => f.replace('<a href="/news"', '<a href="/news"'));   // footer links keep their targets
fs.writeFileSync(new URL('../pl.html', import.meta.url), html);
console.log('pl.html written (' + html.length + ' bytes).');
if (missing.length) { console.log('NOT TRANSLATED (' + missing.length + '):'); [...new Set(missing)].forEach((x) => console.log('  - ' + x.slice(0, 120))); } else console.log('Every visible string is translated or deliberately kept.');
