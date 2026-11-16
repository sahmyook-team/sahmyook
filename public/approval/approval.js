// 결재검토 화면 (careworld-in 과 별개)
(() => {
  const $ = (s) => document.querySelector(s);
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(c));
    return el;
  };
  const api = async (url, opt = {}) => {
    const r = await fetch(url, { credentials: 'same-origin', headers: opt.body ? { 'Content-Type': 'application/json' } : {}, ...opt, body: opt.body ? JSON.stringify(opt.body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `오류 (${r.status})`), { data: j });
    return j;
  };
  const MAX_FILES = 10;
  const MAX_SIZE = 30 * 1024 * 1024;
  const STAGES = [['unzip', '압축 해제'], ['extract', '본문 추출'], ['attach', '첨부 분석'], ['review', '검토 중'], ['done', '완료']];
  let files = [];
  let currentMd = '';
  let running = false;

  // ── 로그인 ──────────────────────────────────────────────────────────
  async function boot() {
    const me = await api('/api/approval/me');
    if (!me.id) return showLogin(me);
    $('#ap-user').replaceChildren(`${me.name} (${me.id})`, h('button', { class: 'ap-btn small', type: 'button', onclick: async () => { await api('/api/approval/logout', { method: 'POST' }); location.reload(); } }, '로그아웃'));
    $('#ap-app').hidden = false;
    $('#ap-keep').textContent = `보고서는 ${me.keepDays}일 동안 보관되고 그 뒤에는 자동으로 지워집니다. 본인이 만든 보고서만 보입니다.`;
    loadPast();
  }
  function showLogin(me) {
    $('#ap-login').hidden = false;
    const msg = $('#ap-login-msg');
    if (!me.ready) msg.textContent = '로그인 기능이 아직 준비 중입니다. 관리자에게 알려 주세요.';
    $('#ap-login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.classList.remove('bad');
      msg.textContent = '확인하는 중…';
      const body = { id: $('#ap-id').value.trim(), pin: $('#ap-pin').value };
      if (!$('#ap-pin2-wrap').hidden) body.pin2 = $('#ap-pin2').value;
      try {
        await api('/api/approval/login', { method: 'POST', body });
        location.reload();
      } catch (err) {
        msg.classList.add('bad');
        msg.textContent = err.message;
        if (err.data && err.data.needSetup) {
          $('#ap-pin2-wrap').hidden = false;
          msg.textContent = `${err.data.name}님, 처음이시네요. 쓸 PIN 4자리를 두 번 넣어 주세요.`;
        }
      }
    });
  }

  // ── 파일 올리기 ─────────────────────────────────────────────────────
  function addFiles(list) {
    const say = $('#ap-run-msg');
    say.classList.remove('bad');
    say.textContent = '';
    for (const f of list) {
      if (!/\.zip$/i.test(f.name)) { say.classList.add('bad'); say.textContent = `${f.name}: zip 파일만 올릴 수 있습니다.`; continue; }
      if (f.size > MAX_SIZE) { say.classList.add('bad'); say.textContent = `${f.name}: 30MB를 넘어 올릴 수 없습니다.`; continue; }
      if (files.length >= MAX_FILES) { say.classList.add('bad'); say.textContent = `한 번에 ${MAX_FILES}건까지 검토할 수 있습니다.`; break; }
      if (files.some((x) => x.file.name === f.name && x.file.size === f.size)) continue;
      files.push({ file: f, state: 'ready', stage: null });
    }
    renderFiles();
  }
  function renderFiles() {
    const ul = $('#ap-files');
    ul.replaceChildren(...files.map((x, i) => h('li', {},
      h('span', { class: 'ap-fname' }, x.file.name),
      h('span', { class: 'ap-stages' }, STAGES.map(([k, label]) => {
        const idx = STAGES.findIndex((s) => s[0] === x.stage);
        const my = STAGES.findIndex((s) => s[0] === k);
        let cls = 'ap-stage';
        if (x.state === 'fail' && k === x.stage) cls += ' fail';
        else if (idx > my || x.stage === 'done') cls += ' done';
        else if (idx === my) cls += ' on';
        return h('span', { class: cls }, x.state === 'fail' && k === x.stage ? '실패' : label);
      })),
      x.error ? h('span', { class: 'ap-msg bad' }, x.error) : null,
      running ? null : h('button', { class: 'ap-btn small', type: 'button', onclick: () => { files.splice(i, 1); renderFiles(); } }, '삭제'))));
    $('#ap-run').disabled = running || !files.length;
  }
  const drop = $('#ap-drop');
  $('#ap-file').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

  // ── 검토 실행 (건별로 서버에 보내고 진행 상태를 받음) ────────────────
  async function reviewOne(x) {
    x.state = 'run'; x.stage = 'unzip'; x.error = ''; renderFiles();
    const r = await fetch('/api/approval/review', { method: 'POST', credentials: 'same-origin', headers: { 'X-File-Name': encodeURIComponent(x.file.name), 'Content-Type': 'application/zip' }, body: x.file });
    if (!r.ok || !r.body) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `오류 (${r.status})`); }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let result = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const o = JSON.parse(line);
        if (o.type === 'stage') { x.stage = o.stage; renderFiles(); }
        if (o.type === 'case') result = o.result;
        if (o.type === 'error') throw new Error(o.msg);
      }
    }
    if (!result) throw new Error('검토 결과를 받지 못했습니다.');
    x.state = 'done'; x.stage = 'done'; renderFiles();
    return result;
  }
  $('#ap-run').addEventListener('click', async () => {
    if (running || !files.length) return;
    running = true; renderFiles();
    const say = $('#ap-run-msg');
    say.classList.remove('bad');
    const cases = [];
    for (const [n, x] of files.entries()) {
      say.textContent = `${n + 1}/${files.length}건 검토 중… (건마다 1~3분 걸릴 수 있어요. 창을 닫지 마세요)`;
      try { cases.push(await reviewOne(x)); }
      catch (e) { x.state = 'fail'; x.error = e.message; renderFiles(); cases.push({ file: x.file.name, failed: true, error: e.message }); }
    }
    say.textContent = '보고서를 만드는 중…';
    try {
      const rep = await api('/api/approval/report', { method: 'POST', body: { cases } });
      showReport(rep.markdown);
      say.textContent = `보고서를 저장했습니다. ${rep.count}건 중 확인 필요 ${rep.flagged}건.`;
      files = [];
      loadPast();
    } catch (e) { say.classList.add('bad'); say.textContent = e.message; }
    running = false; renderFiles();
  });

  // ── 보고서 보기·내려받기 ─────────────────────────────────────────────
  function mdToNodes(md) {
    const out = [];
    let ul = null;
    const inline = (t) => {
      const span = document.createDocumentFragment();
      t.split(/(\*\*[^*]+\*\*)/).forEach((p) => span.append(p.startsWith('**') && p.endsWith('**') ? h('strong', {}, p.slice(2, -2)) : p));
      return span;
    };
    for (const line of md.split('\n')) {
      if (line.startsWith('- ')) { if (!ul) { ul = h('ul'); out.push(ul); } ul.append(h('li', {}, inline(line.slice(2)))); continue; }
      ul = null;
      if (line.startsWith('### ')) out.push(h('h3', { class: line.includes('확인 필요') || line.includes('개인정보') || line.includes('실패') ? 'warn' : '' }, line.slice(4)));
      else if (line.startsWith('## ')) out.push(h('h2', {}, line.slice(3)));
      else if (line.trim()) out.push(h('p', {}, inline(line)));
    }
    return out;
  }
  function showReport(md) {
    currentMd = md;
    $('#ap-report').replaceChildren(...mdToNodes(md));
    $('#ap-report-card').hidden = false;
    $('#ap-report-card').scrollIntoView({ behavior: 'smooth' });
  }
  $('#ap-pdf').addEventListener('click', () => window.print());
  $('#ap-word').addEventListener('click', () => {
    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>결재 검토</title></head><body style="font-family:'맑은 고딕',sans-serif">${$('#ap-report').innerHTML}</body></html>`;
    const a = h('a', { href: URL.createObjectURL(new Blob(['﻿', html], { type: 'application/msword' })), download: `결재검토_${(currentMd.match(/\d{4}-\d{2}-\d{2}/) || ['보고서'])[0]}.doc` });
    document.body.append(a); a.click(); a.remove();
  });

  async function loadPast() {
    const tb = $('#ap-past');
    try {
      const { reports } = await api('/api/approval/reports');
      if (!reports.length) return tb.replaceChildren(h('tr', {}, h('td', { colspan: '4' }, '아직 보고서가 없습니다.')));
      tb.replaceChildren(...reports.map((r) => h('tr', {},
        h('td', {}, new Date(r.created).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })),
        h('td', {}, `${r.count}건`), h('td', {}, `${r.flagged}건`),
        h('td', {}, h('button', { class: 'ap-btn small', type: 'button', onclick: async () => showReport((await api(`/api/approval/reports/${r.id}`)).markdown) }, '보기')))));
    } catch (e) { tb.replaceChildren(h('tr', {}, h('td', { colspan: '4' }, e.message))); }
  }

  boot().catch((e) => { $('#ap-login').hidden = false; $('#ap-login-msg').textContent = e.message; });
})();
