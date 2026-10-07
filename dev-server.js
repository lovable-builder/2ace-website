// Local test server that mimics the .htaccess rules (clean URLs). Run: node dev-server.js [port]
const http = require('http'), fs = require('fs'), path = require('path');
const root = __dirname, port = Number(process.argv[2]) || 8000;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = decodeURIComponent(u.pathname);
  if (/\/\.(?!well-known)/.test(p) || /^\/(supabase|node_modules|content|scripts|tests|web)(\/|$)/.test(p) || p === '/skills-lock.json') { res.writeHead(404); return res.end('Not found'); }
  if (/^\/market(\.html)?\/?$/.test(p)) { res.writeHead(302, { Location: '/' }); return res.end(); }   // 2ACE Market is switched off for now (see .htaccess)
  if (/^\/platform(\.html)?\/?$/.test(p)) { res.writeHead(302, { Location: '/app/' + u.search }); return res.end(); }   // the old plan builder: the customer app replaced it (see .htaccess)
  if (/^\/index(\.html)?$/.test(p)) { res.writeHead(301, { Location: '/' + u.search }); return res.end(); }
  if (/^\/news\/index(\.html)?$/.test(p)) { res.writeHead(301, { Location: '/news/' }); return res.end(); }
  if (/\.html$/.test(p)) { res.writeHead(301, { Location: p.slice(0, -5) + u.search }); return res.end(); }
  let f = path.join(root, p);
  if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (/^\/app(\/|$)/.test(p) && !(fs.existsSync(f) && fs.statSync(f).isFile())) f = path.join(root, 'app', 'index.html');   // the customer app: one page for every /app/... address (see .htaccess)
  else if (p === '/') f = path.join(root, 'index.html');
  else if (fs.existsSync(f) && fs.statSync(f).isDirectory()) {
    if (!p.endsWith('/')) { res.writeHead(301, { Location: p + '/' + u.search }); return res.end(); }
    f = path.join(f, 'index.html');
  }
  else if (!path.extname(f) && fs.existsSync(f + '.html')) f += '.html';
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(port, '0.0.0.0', () => console.log('http://localhost:' + port));
