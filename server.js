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
const ADMIN = process.env.SAHM_ADMIN || '전경철'; // 새 사람 가입은 이 사람 페이지에서만
const SHARED = { slug: 'careworld-in', name: 'careworld-in' }; // 메인페이지(공동 공간) 이름
// 가입한 사람:  [member] slug | 이름 | YYYY-MM-DD HH:MM | 가입시킨 사람   (sahm.txt)
let members = [];
const allPeople = () => [...PEOPLE, ...members];
const bySlug = (slug) => allPeople().find((p) => p.slug === slug);
const byNameFn = (name) => allPeople().find((p) => p.name === name);
function loadMembers(text) {
  const seen = new Set(PEOPLE.flatMap((p) => [p.slug, p.name]));
  const list = [];
  for (const raw of text.split('\n')) {
    const m = raw.trim().match(/^\[member\]\s+([a-z0-9-]+)\s*\|\s*([^|]+?)\s*\|/);
    if (m && !seen.has(m[1]) && !seen.has(m[2])) { seen.add(m[1]); seen.add(m[2]); list.push({ slug: m[1], name: m[2], member: true }); }
  }
  members = list;
}

const routes = {
  '/': { type: HTML, body: pub('index.html') },
  '/index.html': { type: HTML, body: pub('index.html') },
  '/login': { type: HTML, body: pub('login.html') },
  '/style.css': { type: 'text/css; charset=utf-8', body: pub('style.css') },
  '/app.js': { type: 'text/javascript; charset=utf-8', body: pub('app.js') },
};
for (const p of PEOPLE) routes[`/people/${p.slug}`] = { type: HTML, body: pub('people', `${p.slug}.html`) };
const TEMPLATE = pub('people', '_template.html').toString('utf8');
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function memberPage(p) { // 가입한 사람: 페이지 파일이 있으면 그것, 없으면 기본 틀
  const f = path.join(__dirname, 'public', 'people', `${p.slug}.html`);
  if (fs.existsSync(f)) return fs.readFileSync(f);
  return TEMPLATE.replaceAll('{{NAME}}', esc(p.name)).replaceAll('{{INITIAL}}', esc([...p.name][0])).replaceAll('{{SLUG}}', p.slug);
}

// ── 설정 (Cloud Run 환경 변수) ──────────────────────────────────────────
// SESSION_SECRET : (선택) 로그인 쿠키와 PIN 저장값(HMAC)용 비밀 문자열. 없으면 GITHUB_TOKEN 에서 만듦
// GITHUB_TOKEN   : sahmyook-team/sahmyook Contents 읽기·쓰기 권한 토큰 (sahm.txt, pins.json 저장용)
// ROUTINE_TOKEN  : (선택) 예약 작업의 API 트리거 토큰 — 없으면 [프롬프트 실행] 대신 매시 14분 예약 실행으로 처리
const ON_CLOUD_RUN = !!process.env.K_SERVICE;
const REPO = process.env.GITHUB_REPO || 'sahmyook-team/sahmyook';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const ROUTINE_ID = process.env.ROUTINE_ID || 'trig_01P9zA8BMadXpTpabwJjtNTy';
const ROUTINE_FIRE_URL = process.env.ROUTINE_FIRE_URL ||
  `https://api.anthropic.com/v1/claude_code/routines/${ROUTINE_ID}/fire`;
const ROUTINE_BETA = process.env.ROUTINE_BETA || 'experimental-cc-routine-2026-04-01';
// 서명 비밀값: SESSION_SECRET 이 있으면 그것, 없으면 GITHUB_TOKEN 에서 만든 값(토큰을 바꾸면 PIN 을 다시 정해야 함)
const SECRET = process.env.SESSION_SECRET
  || (process.env.GITHUB_TOKEN && crypto.createHash('sha256').update(`sahmyook-session:${process.env.GITHUB_TOKEN}`).digest('hex'))
  || crypto.randomBytes(32).toString('hex');
const SECRET_OK = !!(process.env.SESSION_SECRET || process.env.GITHUB_TOKEN) || !ON_CLOUD_RUN; // Cloud Run 에서는 고정 비밀값이 있어야 PIN 이 유지됨

// ── 공통 도우미 ─────────────────────────────────────────────────────────
const kst = (d = new Date()) => {
  const t = new Date(d.getTime() + 9 * 3600e3).toISOString();
  return `${t.slice(0, 10)} ${t.slice(11, 16)}`;
};
const send = (res, code, obj, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
};
const readBody = (req, limit = 20000) => new Promise((resolve, reject) => {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > limit) { reject(new Error('too large')); req.destroy(); } });
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
  return name;
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
    const text = fs.readFileSync(LOCAL_FILE, 'utf8');
    loadMembers(text);
    return { text, sha: null };
  }
  if (mode === 'none') { const text = fs.readFileSync(path.join(__dirname, 'sahm.txt'), 'utf8'); loadMembers(text); return { text, sha: null }; }
  if (!fresh && cache.text !== null && Date.now() - cache.at < 15e3) return cache;
  const r = await gh(`sahm.txt?ref=${BRANCH}`);
  if (!r.ok) throw new Error(`GitHub 읽기 실패 (${r.status})`);
  const j = await r.json();
  cache = { text: Buffer.from(j.content, 'base64').toString('utf8'), sha: j.sha, at: Date.now() };
  loadMembers(cache.text);
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

// ── PIN 저장 (각자 정한 PIN — 원문이 아니라 HMAC 값만 pins.json 에 저장) ──
const LOCAL_PINS = path.join(path.dirname(LOCAL_FILE), 'pins.json');
let pinCache = { data: null, sha: null, at: 0 };
const pinHash = (name, pin) => crypto.createHmac('sha256', SECRET).update(`pin:${name}:${pin}`).digest('hex');

async function readPins(fresh = false) {
  const mode = storageMode();
  if (mode === 'local') return { data: fs.existsSync(LOCAL_PINS) ? JSON.parse(fs.readFileSync(LOCAL_PINS, 'utf8')) : {}, sha: null };
  if (mode === 'none') return { data: {}, sha: null };
  if (!fresh && pinCache.data && Date.now() - pinCache.at < 15e3) return pinCache;
  const r = await gh(`pins.json?ref=${BRANCH}`);
  if (r.status === 404) { pinCache = { data: {}, sha: null, at: Date.now() }; return pinCache; }
  if (!r.ok) throw new Error(`GitHub 읽기 실패 (${r.status})`);
  const j = await r.json();
  pinCache = { data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8') || '{}'), sha: j.sha, at: Date.now() };
  return pinCache;
}

async function savePin(name, hash, { onlyIfEmpty }) {
  const mode = storageMode();
  if (mode === 'none') throw Object.assign(new Error('저장소 연결(GITHUB_TOKEN)이 아직 설정되지 않아 PIN을 저장할 수 없습니다. 관리자에게 알려 주세요.'), { code: 503 });
  if (!SECRET_OK) throw Object.assign(new Error('SESSION_SECRET 이 설정되지 않아 PIN을 저장할 수 없습니다. 관리자에게 알려 주세요.'), { code: 503 });
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, sha } = await readPins(true);
    if (onlyIfEmpty && data[name]) throw Object.assign(new Error(`${name}님의 PIN은 이미 정해져 있습니다. 로그인해 주세요.`), { code: 409 });
    const next = { ...data, [name]: { h: hash, at: kst() } };
    const text = JSON.stringify(next, null, 2) + '\n';
    if (mode === 'local') {
      fs.mkdirSync(path.dirname(LOCAL_PINS), { recursive: true });
      fs.writeFileSync(LOCAL_PINS, text);
      return;
    }
    const r = await gh('pins.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `set PIN: ${bySlugName(name)}`, content: Buffer.from(text).toString('base64'), ...(sha ? { sha } : {}), branch: BRANCH }),
    });
    if (r.ok) { pinCache.at = 0; return; }
    if (r.status !== 409 && r.status !== 422) throw new Error(`GitHub 저장 실패 (${r.status})`);
  }
  throw new Error('다른 저장과 겹쳐 저장하지 못했습니다. 잠시 뒤 다시 해 주세요.');
}
const bySlugName = (name) => (byNameFn(name) ? byNameFn(name).slug : 'unknown');
const badPin = (pin) => !/^\d{4}$/.test(pin) ? 'PIN은 숫자 4자리입니다.'
  : /^(\d)\1{3}$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin) ? '1111, 1234처럼 쉬운 숫자는 쓸 수 없어요. 다른 4자리를 정해 주세요.' : null;
const sameHash = (a, b) => a && b && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// 웹 프롬프트 줄:   [todo] W<id> | 2026-11-15 14:03 | 전경철 | 프롬프트
// 결과 줄(예약작업): [done] W<id> | 2026-11-15 | 결과 요약   /  [skipped] W<id> | 날짜 | 이유
// careworld-in 공동 프롬프트: [todo] C<id> | 시각 | 이름 | 프롬프트  (결과도 같은 C<id> 로)
function parseLog(text, name, prefix = 'W') {
  const prompts = [];
  const results = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    let m = line.match(/^\[todo\]\s+([WC]\w+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(.*)$/);
    if (m) {
      if (m[1][0] === prefix && (prefix === 'C' || m[3] === name)) prompts.push({ id: m[1], at: m[2], by: m[3], text: m[4] });
      continue;
    }
    m = line.match(/^\[(done|skipped|running)\]\s+([WC]\w+)\s*\|\s*([^|]+?)\s*\|\s*(.*)$/);
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
    body: JSON.stringify({ text: `웹 사이트 실행 버튼 (${name}, ${kst()} KST): sahm.txt 의 [todo] W·C 프롬프트를 지금 처리해 주세요.` }),
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
  let me = readSession(req);
  try {
    if (me && !byNameFn(me)) { await readSahm(); if (!byNameFn(me)) me = null; }
    if (url === '/api/people' && req.method === 'GET') {
      await readSahm();
      const { data } = await readPins();
      return send(res, 200, { people: allPeople().map((p) => ({ ...p, hasPin: !!data[p.name] })), admin: ADMIN, shared: SHARED });
    }
    if (url === '/api/me' && req.method === 'GET') {
      return send(res, 200, {
        name: me, slug: me ? byNameFn(me).slug : null, isAdmin: me === ADMIN, admin: ADMIN,
        storage: storageMode(), canRun: !!process.env.ROUTINE_TOKEN,
      });
    }
    if (url === '/api/login' && req.method === 'POST') {
      const { name, pin } = await readBody(req);
      await readSahm();
      if (!byNameFn(name)) return send(res, 400, { error: '이름을 목록에서 골라 주세요.' });
      const { data } = await readPins(true);
      if (!data[name]) return send(res, 409, { error: '아직 PIN을 정하지 않았습니다. 사용할 PIN을 먼저 정해 주세요.', needSetup: true });
      if (tooMany(name)) return send(res, 429, { error: 'PIN을 여러 번 틀렸습니다. 15분 뒤에 다시 해 주세요.' });
      if (!/^\d{4}$/.test(String(pin)) || !sameHash(pinHash(name, String(pin)), data[name].h)) {
        noteFailure(name);
        return send(res, 401, { error: 'PIN이 맞지 않습니다.' });
      }
      failures.delete(name);
      return send(res, 200, { name, slug: byNameFn(name).slug }, { 'Set-Cookie': cookie(req, makeSession(name), 30 * 86400) });
    }
    if (url === '/api/pin/setup' && req.method === 'POST') { // 처음 한 번: 내 PIN 정하기
      const { name, pin, pin2 } = await readBody(req);
      await readSahm();
      if (!byNameFn(name)) return send(res, 400, { error: '이름을 목록에서 골라 주세요.' });
      const why = badPin(String(pin || ''));
      if (why) return send(res, 400, { error: why });
      if (String(pin) !== String(pin2)) return send(res, 400, { error: '두 번 넣은 PIN이 서로 다릅니다.' });
      await savePin(name, pinHash(name, String(pin)), { onlyIfEmpty: true });
      return send(res, 200, { name, slug: byNameFn(name).slug }, { 'Set-Cookie': cookie(req, makeSession(name), 30 * 86400) });
    }
    if (url === '/api/pin/change' && req.method === 'POST') { // 로그인한 본인: PIN 바꾸기
      if (!me) return send(res, 401, { error: '먼저 로그인해 주세요.' });
      const { oldPin, pin, pin2 } = await readBody(req);
      const { data } = await readPins(true);
      if (tooMany(me)) return send(res, 429, { error: 'PIN을 여러 번 틀렸습니다. 15분 뒤에 다시 해 주세요.' });
      if (!data[me] || !sameHash(pinHash(me, String(oldPin || '')), data[me].h)) { noteFailure(me); return send(res, 401, { error: '지금 PIN이 맞지 않습니다.' }); }
      const why = badPin(String(pin || ''));
      if (why) return send(res, 400, { error: why });
      if (String(pin) !== String(pin2)) return send(res, 400, { error: '두 번 넣은 새 PIN이 서로 다릅니다.' });
      await savePin(me, pinHash(me, String(pin)), { onlyIfEmpty: false });
      return send(res, 200, { ok: true });
    }
    if (url === '/api/logout' && req.method === 'POST') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
    }
    if (url === '/api/log' && req.method === 'GET') {
      const slug = new URL(req.url, 'http://x').searchParams.get('person');
      const { text } = await readSahm();
      if (slug === SHARED.slug) return send(res, 200, { person: SHARED, prompts: parseLog(text, null, 'C'), runs: runs.slice(0, 10) });
      const p = bySlug(slug);
      if (!p) return send(res, 404, { error: '없는 페이지입니다.' });
      return send(res, 200, { person: p, prompts: parseLog(text, p.name), runs: runs.slice(0, 10) });
    }
    if (url === '/api/prompt' && req.method === 'POST') {
      if (!me) return send(res, 401, { error: '먼저 로그인해 주세요.' });
      const { person, text } = await readBody(req);
      const body = clean(text, 1500);
      if (!body) return send(res, 400, { error: '프롬프트 내용을 적어 주세요.' });
      if (person === SHARED.slug) { // careworld-in 공동 프롬프트: 로그인한 누구나
        const id = `C${Date.now().toString(36)}`;
        await appendSahm(`[todo] ${id} | ${kst()} | ${me} | ${body}`, `careworld-in prompt ${id}`);
        return send(res, 200, { id });
      }
      const p = bySlug(person);
      if (!p) return send(res, 404, { error: '없는 페이지입니다.' });
      if (p.name !== me) return send(res, 403, { error: '프롬프트는 본인 페이지에서만 보낼 수 있습니다.' });
      const id = `W${Date.now().toString(36)}`;
      await appendSahm(`[todo] ${id} | ${kst()} | ${me} | ${body}`, `web prompt ${id}: ${p.slug}`);
      return send(res, 200, { id });
    }
    if (url === '/api/member' && req.method === 'POST') { // 새 사람 가입 — 관리자(전경철)만
      if (!me) return send(res, 401, { error: '먼저 로그인해 주세요.' });
      if (me !== ADMIN) return send(res, 403, { error: `가입은 ${ADMIN}님 페이지에서만 할 수 있습니다.` });
      const b = await readBody(req);
      const name = clean(b.name, 20);
      const slug = String(b.slug || '').trim().toLowerCase();
      if (!/^[가-힣A-Za-z][가-힣A-Za-z0-9 ]{0,19}$/.test(name)) return send(res, 400, { error: '이름은 한글이나 영문으로 1~20자로 적어 주세요.' });
      if (!/^[a-z][a-z0-9-]{1,19}$/.test(slug) || slug === SHARED.slug) return send(res, 400, { error: '페이지 주소는 영문 소문자로 시작하는 2~20자(소문자·숫자·-)로 적어 주세요. 예) minsu' });
      await readSahm(true);
      if (byNameFn(name)) return send(res, 409, { error: `${name}님은 이미 가입되어 있습니다.` });
      if (bySlug(slug)) return send(res, 409, { error: `/people/${slug} 주소는 이미 쓰이고 있습니다.` });
      await appendSahm(`[member] ${slug} | ${name} | ${kst()} | ${me}`, `add member ${slug}`);
      await readSahm(true);
      return send(res, 200, { slug, name, url: `/people/${slug}` });
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

// ── 결재검토 (careworld-in 과 분리: /approval 페이지, /api/approval/* API, 별도 계정·쿠키) ──
const approvalApi = require('./approval/server-approval')({
  send, readBody, sign, cookie, readSahm, readPins, savePin, badPin, sameHash, tooMany, noteFailure, kst,
  storageMode, ON_CLOUD_RUN, SECRET_OK,
});
routes['/approval'] = { type: HTML, body: pub('approval', 'index.html') };
routes['/approval/app.js'] = { type: 'text/javascript; charset=utf-8', body: pub('approval', 'approval.js') };
routes['/approval/style.css'] = { type: 'text/css; charset=utf-8', body: pub('approval', 'approval.css') };

http.createServer((req, res) => {
  let url = req.url.split('?')[0].split('#')[0];
  if (url.length > 1 && url.endsWith('/')) url = url.slice(0, -1);
  if (url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (url.startsWith('/api/approval/')) return approvalApi(req, res, url);
  if (url.startsWith('/api/')) return api(req, res, url);
  const r = routes[url];
  const mm = !r && url.match(/^\/people\/([a-z0-9-]+)$/);
  if (mm) {
    return readSahm().catch(() => {}).then(() => {
      const p = members.find((x) => x.slug === mm[1]);
      if (!p) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('페이지를 찾을 수 없습니다. / Not found'); }
      res.writeHead(200, { 'Content-Type': HTML });
      res.end(memberPage(p));
    });
  }
  if (!r) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('페이지를 찾을 수 없습니다. / Not found');
  }
  res.writeHead(200, { 'Content-Type': r.type });
  res.end(r.body);
}).listen(port, () => console.log(`sahmyook listening on ${port} (storage: ${storageMode()})`));
