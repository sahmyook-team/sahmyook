const http = require('http');
const fs = require('fs');
const path = require('path');
const port = process.env.PORT || 8080;
const pub = (...p) => fs.readFileSync(path.join(__dirname, 'public', ...p));

const HTML = 'text/html; charset=utf-8';
const routes = {
  '/': { type: HTML, body: pub('index.html') },
  '/index.html': { type: HTML, body: pub('index.html') },
  '/people/kyungcheol': { type: HTML, body: pub('people', 'kyungcheol.html') },
  '/people/gyuwan': { type: HTML, body: pub('people', 'gyuwan.html') },
  '/people/hongjin': { type: HTML, body: pub('people', 'hongjin.html') },
  '/people/juyeon': { type: HTML, body: pub('people', 'juyeon.html') },
  '/people/jeongmin': { type: HTML, body: pub('people', 'jeongmin.html') },
  '/people/youngsook': { type: HTML, body: pub('people', 'youngsook.html') },
  '/people/yongju': { type: HTML, body: pub('people', 'yongju.html') },
  '/people/seongwon': { type: HTML, body: pub('people', 'seongwon.html') },
  '/people/kyunghee': { type: HTML, body: pub('people', 'kyunghee.html') },
  '/people/areum': { type: HTML, body: pub('people', 'areum.html') },
  '/people/hyejin': { type: HTML, body: pub('people', 'hyejin.html') },
  '/style.css': { type: 'text/css; charset=utf-8', body: pub('style.css') },
};

http.createServer((req, res) => {
  let url = req.url.split('?')[0].split('#')[0];
  if (url.length > 1 && url.endsWith('/')) url = url.slice(0, -1);
  if (url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  const r = routes[url];
  if (!r) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('페이지를 찾을 수 없습니다. / Not found');
  }
  res.writeHead(200, { 'Content-Type': r.type });
  res.end(r.body);
}).listen(port, () => console.log(`sahmyook listening on ${port}`));
