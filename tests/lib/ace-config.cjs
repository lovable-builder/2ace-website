// The site's own config.js, evaluated as a page on localhost would, for tests that fake `window` instead of loading a page.
const fs = require('fs'), path = require('path'), vm = require('vm');
const sandbox = { window: {}, location: { hostname: 'localhost' } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', '..', 'config.js'), 'utf8'), sandbox);
module.exports = sandbox.window.ACE_CONFIG;
