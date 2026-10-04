// Shared by login.html and account.html. Same list and tax-ID labels as platform.html.
window.COUNTRIES = [
  ['PL', 'Poland', 'NIP', '1234567890'], ['DE', 'Germany', 'USt-IdNr. (VAT)', 'DE123456789'], ['CZ', 'Czechia', 'DIČ (VAT)', 'CZ12345678'],
  ['SK', 'Slovakia', 'IČ DPH (VAT)', 'SK1234567890'], ['LT', 'Lithuania', 'PVM code (VAT)', 'LT123456789'], ['NL', 'Netherlands', 'BTW-id (VAT)', 'NL123456789B01'],
  ['FR', 'France', 'TVA intracom (VAT)', 'FR12345678901'], ['IT', 'Italy', 'Partita IVA', 'IT12345678901'], ['ES', 'Spain', 'NIF-IVA (VAT)', 'ESX1234567X'],
  ['UA', 'Ukraine', 'EDRPOU code', '12345678'], ['TR', 'Türkiye', 'Vergi No (tax ID)', '1234567890'], ['GB', 'United Kingdom', 'VAT / Company No.', 'GB123456789'],
  ['US', 'United States', 'EIN', '12-3456789'], ['CN', 'China', 'Unified Social Credit Code', '91310000MA1FL0000X'], ['AE', 'United Arab Emirates', 'TRN (tax ID)', '100123456700003'],
  ['OTHER', 'Other country', 'Business registration number', 'Registration number']
].map(([code, name, label, ph]) => ({ code, name, label, ph }));

window.fillCountrySelect = function (sel, taxLabelEl, taxInput) {
  sel.innerHTML = '<option value="">Select country</option>' + window.COUNTRIES.map((c) => '<option value="' + c.code + '">' + c.name + '</option>').join('');
  const sync = () => {
    const c = window.COUNTRIES.find((x) => x.code === sel.value);
    taxLabelEl.firstChild.nodeValue = (c ? c.label : 'Tax / VAT number') + ' ';
    taxInput.placeholder = c ? c.ph : '';
  };
  sel.addEventListener('change', sync); sync();
};
