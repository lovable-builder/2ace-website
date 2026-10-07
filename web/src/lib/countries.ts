// Countries a company can register from, with the name of their business number and an example.
export type Country = { code: string; name: string; label: string; ph: string };
// i18n
export const COUNTRIES: Country[] = ([
  ['DE', 'Germany', 'USt-IdNr. (VAT)', 'DE123456789'], ['PL', 'Poland', 'NIP', '1234567890'], ['CZ', 'Czechia', 'DIČ (VAT)', 'CZ12345678'],
  ['SK', 'Slovakia', 'IČ DPH (VAT)', 'SK1234567890'], ['LT', 'Lithuania', 'PVM code (VAT)', 'LT123456789'], ['NL', 'Netherlands', 'BTW-id (VAT)', 'NL123456789B01'],
  ['FR', 'France', 'TVA intracom (VAT)', 'FR12345678901'], ['IT', 'Italy', 'Partita IVA', 'IT12345678901'], ['ES', 'Spain', 'NIF-IVA (VAT)', 'ESX1234567X'],
  ['UA', 'Ukraine', 'EDRPOU code', '12345678'], ['TR', 'Türkiye', 'Vergi No (tax ID)', '1234567890'], ['GB', 'United Kingdom', 'VAT / Company No.', 'GB123456789'],
  ['US', 'United States', 'EIN', '12-3456789'], ['CN', 'China', 'Unified Social Credit Code', '91310000MA1FL0000X'], ['AE', 'United Arab Emirates', 'TRN (tax ID)', '100123456700003'],
  ['OTHER', 'Other country', 'Business registration number', 'Registration number'],
] as const).map(([code, name, label, ph]) => ({ code, name, label, ph }));

export const countryOf = (code: string) => COUNTRIES.find((c) => c.code === code) || COUNTRIES[0];
