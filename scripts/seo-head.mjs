// Shared head tags for every public page: icons, link previews (Open Graph, Twitter) and the canonical address.
export const SITE = 'https://2ace.pl';
export const DEFAULT_OG = '/assets/og/default.jpg';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
export const iconTags = () =>
  '<link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" type="image/png" sizes="192x192" href="/assets/icons/icon-192.png"><link rel="apple-touch-icon" href="/assets/icons/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest"><meta name="theme-color" content="#0B0C0E">';
export const socialTags = ({ title, desc, url, image = DEFAULT_OG, type = 'website', alt = '' }) => {
  const abs = image.startsWith('http') ? image : SITE + image;
  const a = esc(alt || title);
  return `<link rel="canonical" href="${SITE}${url}"><meta property="og:site_name" content="2ACE"><meta property="og:locale" content="en_GB"><meta property="og:type" content="${type}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${SITE}${url}"><meta property="og:image" content="${abs}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${a}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${abs}"><meta name="twitter:image:alt" content="${a}">`;
};
