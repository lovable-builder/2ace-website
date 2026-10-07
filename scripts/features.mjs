// Switches for parts of the site that are built but not offered right now. Flip a flag and rebuild (node scripts/build-seo.mjs && node scripts/build-news.mjs) to bring a feature back.
// 2ACE Market: the page (market.html), its landing section and the builder step are all kept in the repository, just hidden.
// To bring it back also: remove the `market` redirect in .htaccess, uncomment the MARKET-OFF blocks in index.html, and add Market to the customer app (web/): its plan-builder part lived in the old platform.html, which is gone (see git history).
export const MARKET_ENABLED = false;
