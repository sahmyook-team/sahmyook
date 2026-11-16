// 결재검토 (careworld-in 과 분리된 별도 공간)
// - 담당자 계정: sahm.txt 의 "[reviewer] 영문id | 이름 | 시각 | 등록한 사람" 줄. careworld-in 사람 목록과 섞이지 않음
// - 로그인: 영문 id + 4자리 PIN (처음엔 직접 정함). PIN 은 pins.json 의 "reviewer:<id>" 키에 HMAC 값만 저장
// - 세션 쿠키도 따로(appr_session). careworld-in 로그인으로는 결재검토 API 에 들어올 수 없음
// - 결재 파일은 요청 하나 안에서 검토하고 바로 지움. 보고서는 Google Drive 비공개 폴더(REVIEW_FOLDER_ID)에만 90일 보관
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const KEEP_DAYS = Number(process.env.REVIEW_KEEP_DAYS || 90);
const MAX_ZIP = 30 * 1024 * 1024; // Cloud Run 요청 크기 한도(32MiB) 안쪽
const FOLDER = process.env.REVIEW_FOLDER_ID || '';
const WORKER = path.join(__dirname, 'review.py');
const PY = process.env.PYTHON || 'python3';
const LOCAL_REPORTS = path.join(__dirname, '..', 'data', 'approval-reports');
const RRN = /\d{6}\s*-?\s*[1-8]\d{6}/g;
const LICENSE = /\d{2}\s*-\s*\d{6}\s*-\s*\d{2}/g;
const scrub = (t) => String(t || '').replace(RRN, '[주민번호 가림]').replace(LICENSE, '[면허번호 가림]');

module.exports = function approval(d) {
  // d: { send, readBody, sign, cookie, readSahm, readPins, savePin, badPin, sameHash, tooMany, noteFailure, kst, ON_CLOUD_RUN, SECRET_OK }

  function reviewers(text) {
    const list = [];
    const seen = new Set();
    for (const raw of text.split('\n')) {
      const m = raw.trim().match(/^\[reviewer\]\s+([a-z][a-z0-9-]{1,19})\s*\|\s*([^|]+?)\s*(\||$)/);
      if (m && !seen.has(m[1])) { seen.add(m[1]); list.push({ id: m[1], name: m[2] }); }
    }
    return list;
  }
  async function findReviewer(id) {
    const { text } = await d.readSahm();
    return reviewers(text).find((r) => r.id === id) || null;
  }
  const pinKey = (id) => `reviewer:${id}`;
  const pinHash = (id, pin) => crypto.createHmac('sha256', 'appr').update(d.sign(`appr-pin:${id}:${pin}`)).digest('hex');

  // ── 세션 (appr_session, careworld-in 쿠키와 별개) ──────────────────────
  function makeSession(id) {
    const v = `${id}.${Date.now() + 12 * 3600e3}`; // 12시간
    return `${v}.${d.sign(`appr:${v}`)}`;
  }
  function readSession(req) {
    const m = (req.headers.cookie || '').match(/(?:^|;\s*)appr_session=([^;]+)/);
    if (!m) return null;
    const [id, exp, sig] = m[1].split('.');
    if (!id || !exp || !sig) return null;
    const expect = d.sign(`appr:${id}.${exp}`);
    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    if (Date.now() > Number(exp)) return null;
    return id;
  }
  const setCookie = (req, value, maxAge) => d.cookie(req, value, maxAge).replace(/^sahm_session=/, 'appr_session=');

  // ── 보고서 저장소: Google Drive (Cloud Run 서비스 계정, 키 없음) / 로컬 ─────────
  let tok = { value: null, exp: 0 };
  async function driveToken() {
    if (tok.value && Date.now() < tok.exp - 60e3) return tok.value;
    const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'
      + '?scopes=https://www.googleapis.com/auth/drive', { headers: { 'Metadata-Flavor': 'Google' } });
    if (!r.ok) throw new Error(`서비스 계정 토큰을 받지 못했습니다 (${r.status})`);
    const j = await r.json();
    tok = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return tok.value;
  }
  const storeMode = () => (FOLDER && d.ON_CLOUD_RUN ? 'drive' : d.ON_CLOUD_RUN ? 'none' : 'local');
  const DRIVE = 'https://www.googleapis.com/drive/v3/files';
  async function drive(url, opt = {}) {
    const r = await fetch(url, { ...opt, headers: { Authorization: `Bearer ${await driveToken()}`, ...(opt.headers || {}) } });
    if (!r.ok) throw new Error(`Google Drive 오류 (${r.status}) ${(await r.text()).slice(0, 200)}`);
    return r;
  }

  async function saveReport(owner, meta, markdown) {
    const id = `R${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    const appProperties = { kind: 'approval-report', owner, rid: id, count: String(meta.count), flagged: String(meta.flagged) };
    const name = `결재검토_${d.kst().slice(0, 10)}_${owner}_${id}.md`;
    if (storeMode() === 'local') {
      fs.mkdirSync(LOCAL_REPORTS, { recursive: true });
      fs.writeFileSync(path.join(LOCAL_REPORTS, `${id}.json`), JSON.stringify({ id, name, created: new Date().toISOString(), appProperties, markdown }));
      return id;
    }
    if (storeMode() === 'none') throw Object.assign(new Error('보고서 저장 폴더(REVIEW_FOLDER_ID)가 아직 설정되지 않았습니다. 관리자에게 알려 주세요.'), { code: 503 });
    const boundary = `b${crypto.randomBytes(8).toString('hex')}`;
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`
      + JSON.stringify({ name, parents: [FOLDER], mimeType: 'text/markdown', appProperties })
      + `\r\n--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${markdown}\r\n--${boundary}--`;
    await drive('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    });
    return id;
  }

  async function listReports(owner) {
    const cutoff = Date.now() - KEEP_DAYS * 864e5;
    let items = [];
    if (storeMode() === 'local') {
      if (fs.existsSync(LOCAL_REPORTS)) {
        for (const f of fs.readdirSync(LOCAL_REPORTS)) {
          const r = JSON.parse(fs.readFileSync(path.join(LOCAL_REPORTS, f), 'utf8'));
          items.push({ fileId: f, created: r.created, ...r.appProperties });
        }
      }
    } else if (storeMode() === 'drive') {
      const q = `'${FOLDER}' in parents and trashed=false and appProperties has { key='kind' and value='approval-report' } and appProperties has { key='owner' and value='${owner}' }`;
      const r = await drive(`${DRIVE}?q=${encodeURIComponent(q)}&fields=files(id,createdTime,appProperties)&pageSize=200`
        + '&supportsAllDrives=true&includeItemsFromAllDrives=true&orderBy=createdTime desc');
      items = (await r.json()).files.map((f) => ({ fileId: f.id, created: f.createdTime, ...f.appProperties }));
    }
    const keep = [];
    for (const it of items) { // 보관 기간이 지난 보고서는 자동 삭제
      if (new Date(it.created).getTime() < cutoff) { await deleteReport(it).catch(() => {}); continue; }
      if (it.owner === owner) keep.push(it);
    }
    return keep.sort((a, b) => (a.created < b.created ? 1 : -1));
  }
  async function deleteReport(it) {
    if (storeMode() === 'local') return fs.rmSync(path.join(LOCAL_REPORTS, it.fileId), { force: true });
    await drive(`${DRIVE}/${it.fileId}?supportsAllDrives=true`, { method: 'DELETE' });
  }
  async function readReport(owner, rid) {
    const it = (await listReports(owner)).find((x) => x.rid === rid);
    if (!it) return null; // 남의 보고서이거나 없음
    if (storeMode() === 'local') return JSON.parse(fs.readFileSync(path.join(LOCAL_REPORTS, it.fileId), 'utf8')).markdown;
    return (await drive(`${DRIVE}/${it.fileId}?alt=media&supportsAllDrives=true`)).text();
  }

  // ── 보고서 형식 (규칙.md 의 결과 형식) ────────────────────────────────
  function buildReport(cases, summary) {
    const day = d.kst().slice(0, 10);
    const lines = [`## ${day} 결재 검토 (${cases.length}건)`, '', '### 결재 전 확인 필요'];
    const flagged = cases.filter((c) => !c.failed && (c.needs_check || (c.issues || []).length));
    if (!flagged.length) lines.push('- 없음');
    flagged.forEach((c, i) => {
      lines.push(`**${i + 1}. ${c.title || c.file} (${c.drafter || '기안자 미상'}, ${c.amount || '금액 없음'})**`);
      for (const s of c.issues || []) lines.push(`- ${s}`);
    });
    lines.push('', '### 특이사항 없음');
    const ok = cases.filter((c) => !c.failed && !flagged.includes(c));
    if (!ok.length) lines.push('- 없음');
    ok.forEach((c, i) => lines.push(`- ${i + 1}. ${c.title || c.file}: ${c.ok_note || '점검 항목 이상 없음'}`));
    lines.push('', '### 개인정보 주의');
    const pii = cases.flatMap((c) => (c.pii_notes || []).map((p) => `- ${c.title || c.file}: ${p}`));
    lines.push(...(pii.length ? pii : ['- 없음']));
    const failed = cases.filter((c) => c.failed);
    if (failed.length) lines.push('', '### 검토 실패', ...failed.map((c) => `- ${c.file}: ${c.error}`));
    const sum = String(summary || '').replace(/^\s*(\*\*)?요약\s*[:：]\s*(\*\*)?\s*/, '');
    lines.push('', sum ? `**요약:** ${sum}` : '');
    return { markdown: scrub(lines.join('\n')), flagged: flagged.length };
  }

  function runWorker(args, stdin, onLine) {
    return new Promise((resolve) => {
      const p = spawn(PY, ['-I', WORKER, ...args], { env: process.env });
      let buf = '';
      p.stdout.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) { try { onLine(JSON.parse(line)); } catch { /* 무시 */ } }
        }
      });
      p.stderr.on('data', () => {}); // OCR 원문 등이 섞일 수 있어 로그로 남기지 않음
      p.on('close', (code) => resolve(code));
      if (stdin) p.stdin.end(stdin); else p.stdin.end();
    });
  }

  // ── API ────────────────────────────────────────────────────────────────
  return async function handle(req, res, url) {
    try {
      if (url === '/api/approval/me' && req.method === 'GET') {
        const id = readSession(req);
        const r = id ? await findReviewer(id) : null;
        return d.send(res, 200, { id: r ? r.id : null, name: r ? r.name : null, ready: d.storageMode() !== 'none' && d.SECRET_OK, store: storeMode(), keepDays: KEEP_DAYS });
      }
      if (url === '/api/approval/login' && req.method === 'POST') {
        const { id, pin, pin2 } = await d.readBody(req);
        const rid = String(id || '').trim().toLowerCase();
        const r = await findReviewer(rid);
        if (!r) return d.send(res, 401, { error: '결재검토 담당자로 등록된 id가 아닙니다.' });
        const key = pinKey(rid);
        const { data } = await d.readPins(true);
        if (!data[key]) { // 처음: PIN 정하기
          if (pin2 === undefined) return d.send(res, 409, { error: '처음 로그인입니다. 쓸 PIN을 두 번 넣어 주세요.', needSetup: true, name: r.name });
          const why = d.badPin(String(pin || ''));
          if (why) return d.send(res, 400, { error: why });
          if (String(pin) !== String(pin2)) return d.send(res, 400, { error: '두 번 넣은 PIN이 서로 다릅니다.' });
          await d.savePin(key, pinHash(rid, String(pin)), { onlyIfEmpty: true });
        } else {
          if (d.tooMany(key)) return d.send(res, 429, { error: 'PIN을 여러 번 틀렸습니다. 15분 뒤에 다시 해 주세요.' });
          if (!d.sameHash(pinHash(rid, String(pin || '')), data[key].h)) { d.noteFailure(key); return d.send(res, 401, { error: 'PIN이 맞지 않습니다.' }); }
        }
        return d.send(res, 200, { id: rid, name: r.name }, { 'Set-Cookie': setCookie(req, makeSession(rid), 12 * 3600) });
      }
      if (url === '/api/approval/logout' && req.method === 'POST') {
        return d.send(res, 200, { ok: true }, { 'Set-Cookie': setCookie(req, '', 0) });
      }

      // 여기부터는 결재검토 담당자만 (careworld-in 로그인으로는 접근 불가)
      const me = readSession(req);
      if (!me || !(await findReviewer(me))) return d.send(res, 403, { error: '결재검토 담당자만 쓸 수 있습니다.' });

      if (url === '/api/approval/review' && req.method === 'POST') { // zip 1개 = 결재 1건
        const fname = decodeURIComponent(String(req.headers['x-file-name'] || 'upload.zip')).replace(/[\\/]/g, '_').slice(0, 200);
        if (!/\.zip$/i.test(fname)) return d.send(res, 400, { error: 'zip 파일만 올릴 수 있습니다.' });
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'appr-'));
        try {
          const zpath = path.join(work, 'in.zip');
          let size = 0;
          await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(zpath);
            req.on('data', (c) => { size += c.length; if (size > MAX_ZIP) { req.destroy(); reject(new Error('파일이 30MB를 넘습니다.')); } });
            req.pipe(out);
            out.on('finish', resolve);
            out.on('error', reject);
          });
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
          const fixed = path.join(work, fname);
          fs.renameSync(zpath, fixed);
          let gotCase = false;
          await runWorker(['case', fixed, work], null, (o) => {
            if (o.type === 'case') gotCase = true;
            res.write(JSON.stringify(o) + '\n');
          });
          if (!gotCase) res.write(JSON.stringify({ type: 'error', msg: '검토하지 못했습니다.' }) + '\n');
          return res.end();
        } catch (e) {
          if (!res.headersSent) return d.send(res, 400, { error: e.message });
          res.write(JSON.stringify({ type: 'error', msg: e.message }) + '\n');
          return res.end();
        } finally {
          fs.rmSync(work, { recursive: true, force: true }); // 원본·중간 파일 즉시 삭제
        }
      }
      if (url === '/api/approval/report' && req.method === 'POST') { // 건별 결과 → 보고서 저장
        const { cases } = await d.readBody(req, 2_000_000);
        if (!Array.isArray(cases) || !cases.length) return d.send(res, 400, { error: '검토 결과가 없습니다.' });
        const clean = cases.slice(0, 50).map((c) => ({
          file: scrub(c.file).slice(0, 200), title: scrub(c.title).slice(0, 300), drafter: scrub(c.drafter).slice(0, 100),
          amount: scrub(c.amount).slice(0, 100), needs_check: !!c.needs_check, ok_note: scrub(c.ok_note).slice(0, 500),
          issues: (c.issues || []).slice(0, 30).map((s) => scrub(s).slice(0, 800)),
          pii_notes: (c.pii_notes || []).slice(0, 30).map((s) => scrub(s).slice(0, 300)),
          failed: !!c.failed, error: scrub(c.error).slice(0, 300),
        }));
        let summary = '';
        await runWorker(['summary'], JSON.stringify(clean.filter((c) => !c.failed)), (o) => { if (o.type === 'summary') summary = o.text; });
        const { markdown, flagged } = buildReport(clean, summary);
        const rid = await saveReport(me, { count: clean.length, flagged }, markdown);
        return d.send(res, 200, { id: rid, markdown, count: clean.length, flagged });
      }
      if (url === '/api/approval/reports' && req.method === 'GET') {
        const list = await listReports(me);
        return d.send(res, 200, { reports: list.map((r) => ({ id: r.rid, created: r.created, count: Number(r.count), flagged: Number(r.flagged) })), keepDays: KEEP_DAYS });
      }
      const m = url.match(/^\/api\/approval\/reports\/(R[a-z0-9]+)$/);
      if (m && req.method === 'GET') {
        const md = await readReport(me, m[1]);
        if (md === null) return d.send(res, 404, { error: '보고서를 찾을 수 없습니다.' });
        return d.send(res, 200, { id: m[1], markdown: md });
      }
      return d.send(res, 404, { error: 'Not found' });
    } catch (e) {
      console.error('approval:', e.message);
      return d.send(res, e.code || 500, { error: e.message || '오류가 났습니다.' });
    }
  };
};
