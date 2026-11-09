/* Optional static server — the app also runs by opening index.html directly.
   Usage:  node server.js  [port]                                        */
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = Number(process.argv[2] || 5123);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const server = http.createServer(function (req, res) {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const file = path.join(root, rel);
  if (!file.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

/* if the port is busy, move to the next one instead of failing */
let attempt = 0;
server.on('error', function (err) {
  if (err.code === 'EADDRINUSE' && attempt < 10) {
    attempt++;
    const next = port + attempt;
    setTimeout(function () { server.listen(next); }, 60);
    return;
  }
  throw err;
});
server.on('listening', function () {
  const p = server.address().port;
  console.log('Weather station DQ running at http://127.0.0.1:' + p);
});
server.listen(port);

