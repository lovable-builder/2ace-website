// Switches for parts of the site that are built but not offered right now. Flip a flag and rebuild (node scripts/build-seo.mjs && node scripts/build-news.mjs) to bring a feature back.
// 2ACE Market: the page (market.html), its landing section and the builder step are all kept in the repository, just hidden.
// To bring it back also: remove the `market` redirect in .htaccess, uncomment the MARKET-OFF blocks in index.html, and add Market to the customer app (web/): its plan-builder part lived in the old platform.html, which is gone (see git history).
export const MARKET_ENABLED = false;

// Self-service pricing: the pallet/shelf rental model, the public price list and estimator, and the "build your own plan" customer journey.
// Off because the warehouse is rented from a landlord and cannot be sub-let: 2ACE sells fulfilment and warehouse software, with pricing on request,
// and customers are created in the admin panel. Everything is kept in the repository, hidden (look for `data-self-serve` in the pages, `web/src/lib/flags.ts` in the app).
// To bring it back: set this to true, rebuild (node scripts/build-seo.mjs && node scripts/build-news.mjs && node scripts/build-help.mjs), remove the `hidden` attribute from the
// `data-self-serve` blocks (and hide the "Get pricing" replacements), and set `selfServe: true` in config.js.
export const SELF_SERVE_PRICING = false;
