// ESM twin of ace-config.cjs: the site's config.js as a page on localhost sees it.
import { createRequire } from 'node:module';
export const ACE_CONFIG = createRequire(import.meta.url)('./ace-config.cjs');
