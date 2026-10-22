const http = require('http');
const fs = require('fs');
const path = require('path');
const port = process.env.PORT || 8080;
const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page);
}).listen(port, () => console.log(`sahmyook listening on ${port}`));
