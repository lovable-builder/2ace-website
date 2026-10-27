// The customer guide is written once for both models. Regions between <!--SELF-SERVE--> and <!--/SELF-SERVE--> only appear while self-service plans are on
// (SELF_SERVE_PRICING in features.mjs); regions between <!--ON-REQUEST--> and <!--/ON-REQUEST--> only appear while pricing is on request. The section numbers are
// renumbered after the cut, so the guide never skips a number.
import { SELF_SERVE_PRICING } from './features.mjs';

export function variant(html) {
  const on = SELF_SERVE_PRICING;
  html = html.replace(/<!--SELF-SERVE-->([\s\S]*?)<!--\/SELF-SERVE-->/g, on ? '$1' : '');
  html = html.replace(/<!--ON-REQUEST-->([\s\S]*?)<!--\/ON-REQUEST-->/g, on ? '' : '$1');
  let n = 0;
  return html.replace(/<h2>\d+\.\s/g, () => `<h2>${++n}. `);
}
