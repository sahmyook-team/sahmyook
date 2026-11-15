const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const port = process.env.PORT || 8080;
const pub = (...p) => fs.readFileSync(path.join(__dirname, 'public', ...p));
const HTML = 'text/html; charset=utf-8';

// ── 사람 페이지 (메인페이지 "사람" 메뉴의 순서) ─────────────────────────
const PEOPLE = [
  ['kyungcheol', '전경철'], ['gyuwan', '임규완'], ['hongjin', '오홍진'],
  ['juyeon', '김주연'], ['jeongmin', '이정민'], ['youngsook', '김영숙'],
  ['yongju', '김용주'], ['seongwon', '왕성원'], ['kyunghee', '김경희'],
  ['areum', '박아름'], ['hyejin', '김혜진'], ['dongseok', '최동석'],
  ['hyunju', '이현주'],
].map(([slug, name]) => ({ slug, name }));
const bySlug = Object.fromEntries(PEOPLE.map((p) => [p.slug, p]));
const byName = Object.fromEntries(PEOPLE.map((p) => [p.name, p]));

const routes = {
  '/': { type: HTML, body: pub('index.html') },
  '/index.html': { type: HTML, body: pub('index.html') },
  '/login': { type: HTML, body: pub('login.html') },
  '/style.css': { type: 'text/css; charset=utf-8', body: pub('style.css') },
  '/app.js': { type: 'text/javascript; charset=utf-8', body: pub('app.js') },
};
for (const p of PEOPLE) routes[`/people/${p.slug}`] = { type: HTML, body: pub('people', `${p.slug}.html`) };

// ── 설정 (Cloud Run 환경 변수) ──────────────────────────────────────────
// SAHM_PINS      : {"전경철":"1234", ...}  사람별 4자리 PIN (저장소에 넣지 않음)
// SESSION_SECRET : 로그인 쿠키 서명용 임의 문자열
// GITHUB_TOKEN   : sahmyook-team/sahmyook Contents 읽기·쓰기 권한 토큰 (sahm.txt 저장용)
// ROUTINE_TOKEN  : 예약 작업(sahm_all 자동 반영)의 API 트리거 토큰 (실행 버튼용)
const ON_CLOUD_RUN = !!process.env.K_SERVICE;
const REPO = process.env.GITHUB_REPO || 'sahmyook-team/sahmyook';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const ROUTINE_ID = process.env.ROUTINE_ID || 'trig_01P9zA8BMadXpTpabwJjtNTy';
const ROUTINE_FIRE_URL = process.env.ROUTINE_FIRE_URL ||
  `https://api.anthropic.com/v1/claude_code/routines/${ROUTINE_ID}/fire`;
const ROUTINE_BETA = process.env.ROUTINE_BETA || 'experimental-cc-routine-2026-04-01';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
let PINS = {};
try { PINS = JSON.parse(process.env.SAHM_PINS || '{}'); } catch { console.error('SAHM_PINS is not valid JSON'); }

// ── 공통 도우미 ─────────────────────────────────────────────────────────
const kst = (d = new Date()) => {
  const t = new Date(d.getTime() + 9 * 3600e3).toISOString();
  return `${t.slice(0, 10)} ${t.slice(11, 16)}`;
};
const send = (res, code, obj, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > 20000) { reject(new Error('too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('bad json')); } });
});
const clean = (s, max) => String(s || '').replace(/[\r\n|]+/g, ' ').trim().slice(0, max);

// ── 로그인 (이름 + 4자리 PIN, 서명된 쿠키) ──────────────────────────────
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function makeSession(name) {
  const v = `${Buffer.from(name).toString('base64url')}.${Date.now() + 30 * 864e5}`;
  return `${v}.${sign(v)}`;
}
function readSession(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)sahm_session=([^;]+)/);
  if (!m) return null;
  const [n, exp, sig] = m[1].split('.');
  if (!n || !exp || !sig) return null;
  const expect = sign(`${n}.${exp}`);
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  if (Date.now() > Number(exp)) return null;
  const name = Buffer.from(n, 'base64url').toString();
  return byName[name] ? name : null;
}
const cookie = (req, value, maxAge) => {
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  return `sahm_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
};
const failures = new Map(); // 이름별 실패 횟수 (PIN 무작위 대입 막기)
function tooMany(name) {
  const f = failures.get(name);
  return f && f.count >= 5 && Date.now() - f.first < 15 * 60e3;
}
function noteFailure(name) {
  const f = failures.get(name);
  if (!f || Date.now() - f.first > 15 * 60e3) failures.set(name, { count: 1, first: Date.now() });
  else f.count += 1;
}

// ── sahm.txt 저장소 (Cloud Run: GitHub, 로컬: data/sahm.txt) ─────────────
const LOCAL_FILE = process.env.SAHM_FILE || path.join(__dirname, 'data', 'sahm.txt');
let cache = { text: null, sha: null, at: 0 };
const gh = (p, opt = {}) => fetch(`https://api.github.com/repos/${REPO}/contents/${p}`, {
  ...opt,
  headers: {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'sahmyook-site',
    ...(opt.headers || {}),
  },
});
const storageMode = () => (process.env.GITHUB_TOKEN ? 'github' : ON_CLOUD_RUN ? 'none' : 'local');

async function readSahm(fresh = false) {
  const mode = storageMode();
  if (mode === 'local') {
    if (!fs.existsSync(LOCAL_FILE)) {
      fs.mkdirSync(path.dirname(LOCAL_FILE), { recursive: true });
      fs.copyFileSync(path.join(__dirname, 'sahm.txt'), LOCAL_FILE);
    }
    return { text: fs.readFileSync(LOCAL_FILE, 'utf8'), sha: null };
  }
  if (mode === 'none') return { text: fs.readFileSync(path.join(__dirname, 'sahm.txt'), 'utf8'), sha: null };
  if (!fresh && cache.text !== null && Date.now() - cache.at < 15e3) return cache;
  const r = await gh(`sahm.txt?ref=${BRANCH}`);
  if (!r.ok) throw new Error(`GitHub 읽기 실패 (${r.status})`);
  const j = await r.json();
  cache = { text: Buffer.from(j.content, 'base64').toString('utf8'), sha: j.sha, at: Date.now() };
  return cache;
}

async function appendSahm(line, message) {
  const mode = storageMode();
  if (mode === 'none') throw Object.assign(new Error('저장소 연결(GITHUB_TOKEN)이 아직 설정되지 않았습니다. 관리자에게 알려 주세요.'), { code: 503 });
  if (mode === 'local') {
    await readSahm();
    fs.appendFileSync(LOCAL_FILE, (fs.readFileSync(LOCAL_FILE, 'utf8').endsWith('\n') ? '' : '\n') + line + '\n');
    return;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const { text, sha } = await readSahm(true);
    const next = text + (text.endsWith('\n') ? '' : '\n') + line + '\n';
    const r = await gh('sahm.txt', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, content: Buffer.from(next).toString('base64'), sha, branch: BRANCH }),
    });
    if (r.ok) { cache.at = 0; return; }
    if (r.status !== 409 && r.status !== 422) throw new Error(`GitHub 저장 실패 (${r.status})`);
  }
  throw new Error('다른 저장과 겹쳐 저장하지 못했습니다. 잠시 뒤 다시 보내 주세요.');
}

// 웹 프롬프트 줄:   [todo] W<id> | 2026-11-15 14:03 | 전경철 | 프롬프트
// 결과 줄(예약작업): [done] W<id> | 2026-11-15 | 결과 요약   /  [skipped] W<id> | 날짜 | 이유
function parseLog(text, name) {
  const prompts = [];
  const results = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    let m = line.match(/^\[todo\]\s+(W\w+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.*)$/);
    if (m) { if (m[3] === name) prompts.push({ id: m[1], at: m[2], text: m[4] }); continue; }
    m = line.match(/^\[(done|skipped|running)\]\s+(W\w+)\s*\|\s*([^|]+?)\s*\|\s*(.*)$/);
    if (m) results[m[2]] = { status: m[1], at: m[3], note: m[4] };
  }
  return prompts.map((p) => ({ ...p, result: results[p.id] || null }));
}

// ── 실행 버튼 → 예약 작업 즉시 실행 ─────────────────────────────────────
const runs = []; // 최근 실행 기록 (서버 메모리)
let lastFire = 0;
async function fireRoutine(name) {
  if (!process.env.ROUTINE_TOKEN) {
    throw Object.assign(new Error('실행 연결(ROUTINE_TOKEN)이 아직 설정되지 않았습니다. 보낸 프롬프트는 매시 14분 예약 실행 때 처리됩니다.'), { code: 503 });
  }
  const wait = 90e3 - (Date.now() - lastFire);
  if (wait > 0) throw Object.assign(new Error(`방금 실행했습니다. ${Math.ceil(wait / 1000)}초 뒤에 다시 눌러 주세요.`), { code: 429 });
  lastFire = Date.now();
  const r = await fetch(ROUTINE_FIRE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.ROUTINE_TOKEN}`,
      'anthropic-beta': ROUTINE_BETA,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: `웹 사이트 실행 버튼 (${name}, ${kst()} KST): sahm.txt 의 [todo] W 프롬프트를 지금 처리해 주세요.` }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { lastFire = 0; throw new Error(`실행 요청 실패 (${r.status}) ${body.error?.message || ''}`.trim()); }
  const run = {
    at: kst(), by: name,
    sessionUrl: body.claude_code_session_url || body.session_url || null,
    sessionId: body.claude_code_session_id || body.session_id || null,
  };
  runs.unshift(run);
  runs.length = Math.min(runs.length, 30);
  return run;
}

// ── API ─────────────────────────────────────────────────────────────────
async function api(req, res, url) {
  const me = readSession(req);
  try {
    if (url === '/api/people' && req.method === 'GET') {
      return send(res, 200, { people: PEOPLE.map((p) => ({ ...p, hasPin: !!PINS[p.name] })) });
    }
    if (url === '/api/me' && req.method === 'GET') {
      return send(res, 200, {
        name: me, slug: me ? byName[me].slug : null,
        storage: storageMode(), canRun: !!process.env.ROUTINE_TOKEN,
      });
    }
    if (url === '/api/login' && req.method === 'POST') {
      const { name, pin } = await readBody(req);
      if (!byName[name]) return send(res, 400, { error: '이름을 목록에서 골라 주세요.' });
      if (!PINS[name]) return send(res, 403, { error: `${name}님의 PIN이 아직 등록되지 않았습니다. 관리자에게 알려 주세요.` });
      if (tooMany(name)) return send(res, 429, { error: 'PIN을 여러 번 틀렸습니다. 15분 뒤에 다시 해 주세요.' });
      const ok = /^\d{4}$/.test(String(pin)) && crypto.timingSafeEqual(
        Buffer.from(sign(`pin:${pin}`)), Buffer.from(sign(`pin:${PINS[name]}`)));
      if (!ok) { noteFailure(name); return send(res, 401, { error: 'PIN이 맞지 않습니다.' }); }
      failures.delete(name);
      return send(res, 200, { name, slug: byName[name].slug }, { 'Set-Cookie': cookie(req, makeSession(name), 30 * 86400) });
    }
    if (url === '/api/logout' && req.method === 'POST') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
    }
    if (url === '/api/log' && req.method === 'GET') {
      const slug = new URL(req.url, 'http://x').searchParams.get('person');
      const p = bySlug[slug];
      if (!p) return send(res, 404, { error: '없는 페이지입니다.' });
      const { text } = await readSahm();
      return send(res, 200, { person: p, prompts: parseLog(text, p.name), runs: runs.slice(0, 10) });
    }
    if (url === '/api/prompt' && req.method === 'POST') {
      if (!me) return send(res, 401, { error: '먼저 로그인해 주세요.' });
      const { person, text } = await readBody(req);
      const p = bySlug[person];
      if (!p) return send(res, 404, { error: '없는 페이지입니다.' });
      if (p.name !== me) return send(res, 403, { error: '프롬프트는 본인 페이지에서만 보낼 수 있습니다.' });
      const body = clean(text, 1500);
      if (!body) return send(res, 400, { error: '프롬프트 내용을 적어 주세요.' });
      const id = `W${Date.now().toString(36)}`;
      await appendSahm(`[todo] ${id} | ${kst()} | ${me} | ${body}`, `web prompt ${id}: ${p.slug}`);
      return send(res, 200, { id });
    }
    if (url === '/api/run' && req.method === 'POST') {
      if (!me) return send(res, 401, { error: '먼저 로그인해 주세요.' });
      const run = await fireRoutine(me);
      return send(res, 200, run);
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    return send(res, e.code || 500, { error: e.message || '오류가 났습니다.' });
  }
}

http.createServer((req, res) => {
  let url = req.url.split('?')[0].split('#')[0];
  if (url.length > 1 && url.endsWith('/')) url = url.slice(0, -1);
  if (url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (url.startsWith('/api/')) return api(req, res, url);
  const r = routes[url];
  if (!r) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('페이지를 찾을 수 없습니다. / Not found');
  }
  res.writeHead(200, { 'Content-Type': r.type });
  res.end(r.body);
}).listen(port, () => console.log(`sahmyook listening on ${port} (storage: ${storageMode()})`));
