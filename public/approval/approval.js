// 결재검토: [검토 실행] 버튼 + 진행 상황 모니터 (careworld-in 관리자 로그인으로만)
(() => {
  const $ = (id) => document.getElementById(id);
  const btn = $('ap-run');
  const msg = $('ap-run-msg');
  const mon = $('ap-mon');
  const say = (text, bad) => { msg.textContent = text; msg.classList.toggle('bad', !!bad); };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const loginLink = () => Object.assign(document.createElement('a'), { href: '/login', textContent: '로그인' });
  let me = null;
  let timer = null;

  // 단계 → 표시 (루틴이 sahm.txt 에 남기는 [approval] 줄의 단계 이름)
  const STEPS = [['요청', '실행 요청'], ['시작', '시작'], ['준비', '도구 준비'], ['검토', '검토 중'], ['보고서', '보고서 작성'], ['정리', '파일 정리'], ['완료', '완료']];
  const STATE = { running: ['진행 중', 'run'], done: ['완료', 'ok'], error: ['오류', 'bad'], stale: ['아직 시작 안 됨', 'warn'] };

  function render(runs) {
    $('ap-mon-at').textContent = `확인 ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    if (!runs.length) { mon.replaceChildren(el('p', 'ap-muted', '아직 실행 기록이 없습니다. [검토 실행]을 누르면 여기에 진행 상황이 나타납니다.')); return; }
    mon.replaceChildren(...runs.map((r, i) => {
      const box = el('article', `ap-run ${i ? '' : 'latest'}`);
      const head = el('div', 'ap-run-head');
      const [label, cls] = STATE[r.state] || ['?', ''];
      head.append(el('b', null, `${r.events[0].at}`), el('span', `ap-badge ${cls}`, label));
      if (r.sessionUrl) head.append(Object.assign(el('a', 'ap-small', '실행 세션 보기'), { href: r.sessionUrl, target: '_blank', rel: 'noopener' }));
      box.append(head);
      // 단계 진행 표시
      const seen = new Set(r.events.map((e) => (e.stage === '대상없음' ? '완료' : e.stage === '오류' ? '' : e.stage)));
      const lastIdx = Math.max(...STEPS.map(([k], j) => (seen.has(k) ? j : -1)));
      const bar = el('ol', 'ap-steps-bar');
      STEPS.forEach(([k, name], j) => {
        let c = j < lastIdx || (j === lastIdx && r.state === 'done') ? 'done' : j === lastIdx ? (r.state === 'error' ? 'bad' : 'on') : '';
        bar.append(el('li', c, name));
      });
      box.append(bar);
      // 기록 (최근 것부터 최대 8줄)
      const log = el('ul', 'ap-log');
      r.events.slice(-8).reverse().forEach((e) => {
        const li = el('li');
        li.append(el('span', 'ap-time', e.at.slice(11) || e.at), ' ');
        const m = String(e.msg).match(/https:\/\/docs\.google\.com\/\S+/);
        li.append(e.msg.replace(m ? m[0] : '', '').trim() || e.stage);
        if (m) li.append(' ', Object.assign(el('a', null, '보고서 열기'), { href: m[0], target: '_blank', rel: 'noopener' }));
        log.append(li);
      });
      box.append(log);
      if (r.state === 'stale') box.append(el('p', 'ap-muted', '20분이 지나도 시작 기록이 없습니다. 다음 매시 14분 자동 실행 때 처리되거나, 다시 [검토 실행]을 눌러 주세요.'));
      return box;
    }));
  }

  async function poll() {
    clearTimeout(timer);
    try {
      const r = await fetch('/api/approval/status', { credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `오류 (${r.status})`);
      render(j.runs || []);
      const busy = (j.runs || []).some((x) => x.state === 'running');
      timer = setTimeout(poll, busy ? 10000 : 60000);
    } catch (e) {
      mon.replaceChildren(el('p', 'ap-msg bad', e.message));
      timer = setTimeout(poll, 60000);
    }
  }

  fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.json()).then((j) => {
    me = j;
    if (!j.name) {
      say('실행하려면 먼저 로그인해 주세요.'); msg.append(' ', loginLink());
      const p = el('p', 'ap-muted', `진행 상황은 ${j.admin}님으로 로그인하면 보입니다. `); p.append(loginLink()); mon.replaceChildren(p);
      return;
    }
    if (!j.isAdmin) {
      btn.disabled = true;
      say(`검토 실행은 ${j.admin}님만 할 수 있습니다. (매시 14분에 자동으로 검토됩니다)`);
      mon.replaceChildren(el('p', 'ap-muted', `진행 상황은 ${j.admin}님만 볼 수 있습니다.`));
      return;
    }
    if (!j.canRun) { btn.disabled = true; say('실행 연결이 아직 설정되지 않았습니다. 매시 14분에 자동으로 검토됩니다.'); }
    poll();
  }).catch(() => {});

  btn.addEventListener('click', async () => {
    if (me && !me.name) { location.href = '/login'; return; }
    btn.disabled = true;
    say('검토를 시작하는 중…');
    try {
      const r = await fetch('/api/approval/run', { method: 'POST', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `오류 (${r.status})`);
      say(`검토를 시작했습니다(${j.at}). 아래 '진행 상황'에서 확인하세요.`);
      setTimeout(poll, 1500);
    } catch (e) { say(e.message, true); }
    setTimeout(() => { btn.disabled = false; }, 30000);
  });
})();
