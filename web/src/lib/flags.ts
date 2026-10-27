// Self-service plans (the plan builder, checkout, public prices) are off: 2ACE sells fulfilment and warehouse software with pricing on request,
// and customers are created in the admin panel. The screens and code stay in the app, hidden. Switch them back on with `selfServe: true` in /config.js.
export const selfServe = () => window.ACE_CONFIG?.selfServe === true;
