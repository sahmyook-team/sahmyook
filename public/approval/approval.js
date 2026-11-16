// 결재검토 [검토 실행] 버튼: careworld-in 관리자(전경철) 로그인으로만 실행
(() => {
  const btn = document.getElementById('ap-run');
  const msg = document.getElementById('ap-run-msg');
  const say = (text, bad) => { msg.textContent = text; msg.classList.toggle('bad', !!bad); };
  let me = null;
  fetch('/api/me', { credentials: 'same-origin' }).then((r) => r.json()).then((j) => {
    me = j;
    if (!j.name) { say('실행하려면 먼저 로그인해 주세요.'); msg.append(' ', Object.assign(document.createElement('a'), { href: '/login', textContent: '로그인' })); }
    else if (!j.isAdmin) { btn.disabled = true; say(`검토 실행은 ${j.admin}님만 할 수 있습니다. (매시 14분에 자동으로 검토됩니다)`); }
    else if (!j.canRun) { btn.disabled = true; say('실행 연결이 아직 설정되지 않았습니다. 매시 14분에 자동으로 검토됩니다.'); }
  }).catch(() => {});
  btn.addEventListener('click', async () => {
    if (me && !me.name) { location.href = '/login'; return; }
    btn.disabled = true;
    say('검토를 시작하는 중…');
    try {
      const r = await fetch('/api/approval/run', { method: 'POST', credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `오류 (${r.status})`);
      say(`검토를 시작했습니다(${j.at}). 5~10분 뒤 보고서 폴더를 확인해 주세요.`);
    } catch (e) { say(e.message, true); }
    setTimeout(() => { btn.disabled = false; }, 30000);
  });
})();
