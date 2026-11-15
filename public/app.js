// sahmyook v4.8 — 로그인 표시, 로그인 페이지, 사람 페이지 프롬프트 창·실행 버튼·터미널
(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(k));
    return el;
  };
  const api = async (url, opt = {}) => {
    const r = await fetch(url, {
      credentials: 'same-origin',
      headers: opt.body ? { 'Content-Type': 'application/json' } : {},
      ...opt,
      body: opt.body ? JSON.stringify(opt.body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `오류 (${r.status})`);
    return j;
  };

  let me = { name: null };
  const DOC_URL = 'https://docs.google.com/document/d/1tJDne4SayMP-kPmeWIrXVFBN_VoGfY7hZAsKZJZHMSY/edit';
  const notReady = () => me.storage === 'none'; // 서버에 저장소(GITHUB_TOKEN)가 아직 없음
  const readyNote = () => h('p', { class: 'ready-note', role: 'note' },
    '로그인·프롬프트 저장 기능은 아직 준비 중입니다. 지금은 ', h('a', { href: DOC_URL, target: '_blank', rel: 'noopener' }, 'sahm_all 문서'),
    '에 요청을 적어 주세요. 매시 14분에 처리되어 사이트에 반영됩니다.');


  // ── 위쪽 메뉴에 로그인 상태 ──────────────────────────────────────────
  function renderNav() {
    const ul = $('.site-nav ul');
    if (!ul) return;
    const old = $('#nav-auth');
    if (old) old.remove();
    const li = h('li', { id: 'nav-auth', class: 'nav-auth' });
    if (me.name) {
      li.append(
        h('a', { href: `/people/${me.slug}`, class: 'nav-me' }, `${me.name}님`),
        h('button', { type: 'button', class: 'nav-logout', onclick: async () => {
          await api('/api/logout', { method: 'POST' }).catch(() => {});
          location.reload();
        } }, '로그아웃'),
      );
    } else {
      li.append(h('a', { href: '/login', 'aria-current': location.pathname === '/login' ? 'page' : false }, '로그인'));
    }
    ul.append(li);
  }

  // ── 로그인 페이지 ────────────────────────────────────────────────────
  async function initLogin() {
    const list = $('#login-names');
    if (!list) return;
    const form = $('#login-form'), pin = $('#login-pin'), pin2 = $('#login-pin2'), btn = $('#login-submit');
    const who = $('#login-who'), msg = $('#login-msg');
    let chosen = null;
    let setup = false; // 처음: 내 PIN 정하기
    const digits = (el) => el.addEventListener('input', () => { el.value = el.value.replace(/\D/g, '').slice(0, 4); });
    [pin, pin2, $('#change-old'), $('#change-new'), $('#change-new2')].forEach((el) => el && digits(el));

    const mode = (isSetup) => {
      setup = isSetup;
      pin2.hidden = !isSetup;
      pin2.required = isSetup;
      pin.placeholder = isSetup ? '새 PIN' : '••••';
      btn.textContent = isSetup ? 'PIN 정하고 로그인' : '로그인';
      if (notReady()) { who.textContent = `${chosen.name}님, 로그인은 준비가 끝나면 바로 쓸 수 있습니다.`; return; }
      who.textContent = isSetup
        ? `${chosen.name}님은 처음이시네요. 앞으로 쓸 PIN 4자리를 정해서 두 번 넣어 주세요. (1111, 1234처럼 쉬운 숫자는 안 돼요)`
        : `${chosen.name}님의 PIN 4자리를 넣어 주세요.`;
    };

    if (me.name) {
      who.textContent = `지금 ${me.name}님으로 로그인되어 있습니다. 다른 이름으로 바꾸려면 이름을 고르세요.`;
      $('#pin-change').hidden = false;
    }
    if (notReady()) { form.before(readyNote()); }
    const { people } = await api('/api/people');
    for (const p of people) {
      list.append(h('li', {}, h('button', {
        type: 'button', class: 'login-name', 'data-name': p.name, 'aria-pressed': 'false',
        onclick: (e) => {
          chosen = p;
          list.querySelectorAll('.login-name').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
          pin.disabled = btn.disabled = notReady();
          pin2.disabled = notReady();
          pin.value = pin2.value = '';
          msg.textContent = '';
          mode(!p.hasPin);
          pin.focus();
        },
      }, p.name, p.hasPin ? null : h('small', { class: 'login-new' }, ' 처음'))));
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!chosen) return;
      if (!/^\d{4}$/.test(pin.value)) { msg.textContent = 'PIN은 숫자 4자리입니다.'; return; }
      if (setup && pin.value !== pin2.value) { msg.textContent = '두 번 넣은 PIN이 서로 다릅니다.'; return; }
      btn.disabled = true;
      msg.textContent = setup ? 'PIN을 저장하는 중…' : '확인하는 중…';
      try {
        const r = setup
          ? await api('/api/pin/setup', { method: 'POST', body: { name: chosen.name, pin: pin.value, pin2: pin2.value } })
          : await api('/api/login', { method: 'POST', body: { name: chosen.name, pin: pin.value } });
        msg.textContent = `${r.name}님, 환영합니다. 내 페이지로 이동합니다.`;
        location.href = `/people/${r.slug}`;
      } catch (err) {
        msg.textContent = err.message;
        btn.disabled = false;
        if (/아직 PIN을 정하지/.test(err.message)) { chosen.hasPin = false; mode(true); }
        if (/이미 정해져/.test(err.message)) { chosen.hasPin = true; mode(false); }
        pin.select();
      }
    });

    const change = $('#change-form');
    if (change) change.addEventListener('submit', async (e) => {
      e.preventDefault();
      const cm = $('#change-msg');
      cm.textContent = '바꾸는 중…';
      try {
        await api('/api/pin/change', { method: 'POST', body: { oldPin: $('#change-old').value, pin: $('#change-new').value, pin2: $('#change-new2').value } });
        cm.textContent = 'PIN을 바꿨습니다. 다음 로그인부터 새 PIN을 쓰세요.';
        change.reset();
      } catch (err) { cm.textContent = err.message; }
    });
  }

  // ── 사람 페이지: 프롬프트 창 · 실행 버튼 · 터미널 ─────────────────────
  // ── 새 사람 가입 (관리자 페이지에서만) ──────────────────────────────
  function signupBox() {
    const name = h('input', { type: 'text', maxlength: '20', placeholder: '이름 (예: 홍길동)', 'aria-label': '새 사람 이름', class: 'term-input join-input' });
    const slug = h('input', { type: 'text', maxlength: '20', placeholder: '페이지 주소 영문 (예: gildong)', 'aria-label': '페이지 주소', class: 'term-input join-input', autocapitalize: 'off', spellcheck: 'false' });
    const msg = h('p', { class: 'term-status', role: 'status' });
    const btn = h('button', { type: 'button', class: 'btn primary' }, '가입시키기');
    slug.addEventListener('input', () => { slug.value = slug.value.toLowerCase().replace(/[^a-z0-9-]/g, ''); });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      msg.classList.remove('bad');
      msg.textContent = 'sahm.txt에 저장하는 중…';
      try {
        const r = await api('/api/member', { method: 'POST', body: { name: name.value.trim(), slug: slug.value.trim() } });
        msg.textContent = '';
        msg.append(`${r.name}님을 가입시켰습니다. 페이지: `, h('a', { href: r.url }, r.url), ` — ${r.name}님이 로그인 페이지에서 처음 PIN을 정하면 바로 쓸 수 있습니다.`);
        name.value = slug.value = '';
      } catch (e) { msg.textContent = e.message; msg.classList.add('bad'); }
      btn.disabled = false;
    });
    return h('section', { class: 'wrap term join', 'aria-labelledby': 'join-title' },
      h('h2', { id: 'join-title' }, '새 사람 가입'),
      h('p', { class: 'term-note' }, `가입은 ${me.admin}님 페이지에서만 할 수 있습니다. 이름과 페이지 주소(영문)를 넣으면 sahm.txt에 [member] 한 줄이 저장되고, 그 사람의 페이지와 로그인이 바로 생깁니다.`),
      h('div', { class: 'join-form' }, name, slug, btn),
      msg);
  }

  // ── 사람 메뉴에 새로 가입한 사람 추가 ────────────────────────────────
  async function addMembersToNav() {
    const ul = $('.people-nav ul');
    if (!ul) return;
    try {
      const { people } = await api('/api/people');
      const have = new Set([...ul.querySelectorAll('a')].map((a) => a.getAttribute('href')));
      for (const p of people) {
        const href = `/people/${p.slug}`;
        if (have.has(href)) continue;
        ul.append(h('li', {}, h('a', { href, 'aria-current': location.pathname === href ? 'page' : false }, p.name)));
      }
    } catch { /* 메뉴는 없어도 페이지는 동작 */ }
  }

  function initConsole() {
    const m = location.pathname.match(/^\/people\/([a-z0-9-]+)\/?$/);
    const isShared = location.pathname === '/' || location.pathname === '/index.html'; // careworld-in (메인페이지)
    const main = $('main');
    if ((!m && !isShared) || !main) return;
    const slug = isShared ? 'careworld-in' : m[1];
    const isOwner = isShared ? !!me.name : me.slug === slug; // 공동 창은 로그인한 누구나
    const ready = !notReady();

    const term = h('pre', { class: 'term-out', 'aria-live': 'polite', tabindex: '0', 'aria-label': '진행 상황 터미널' });
    const status = h('p', { class: 'term-status', role: 'status' });
    const input = h('textarea', {
      class: 'term-input', rows: '4', maxlength: '1500',
      placeholder: !isOwner ? '' : isShared ? '예) careworld-in에 이번 주 모임 소식을 넣어줘' : '예) 내 페이지에 유바람님이 좋아하는 노래 목록을 만들어줘',
      'aria-label': '프롬프트', disabled: !isOwner,
    });
    const sendBtn = h('button', { type: 'button', class: 'btn primary', disabled: !isOwner }, '프롬프트 보냄');
    const runBtn = h('button', { type: 'button', class: 'btn ghost', disabled: !isOwner }, '프롬프트 실행');

    let note;
    if (isShared && isOwner) note = 'careworld-in은 모두가 함께 쓰는 공동 공간입니다. 로그인한 누구나 여기서 careworld-in(메인페이지)을 고치는 프롬프트를 보낼 수 있습니다. [프롬프트 보냄]을 누르면 sahm.txt에 저장되어 매시 14분 예약 실행 때 처리되고, [프롬프트 실행]을 누르면 지금 바로 실행합니다.';
    else if (isShared) note = h('span', {}, 'careworld-in은 모두가 함께 쓰는 공동 공간입니다. ', h('a', { href: '/login' }, '로그인'), '하면 여기서 careworld-in을 고치는 프롬프트를 보낼 수 있습니다.');
    else if (isOwner) note = '이 페이지는 내 공간입니다. 프롬프트로는 내 페이지만 바꿀 수 있고, careworld-in(메인페이지)은 그곳의 공동 프롬프트 창으로 요청합니다. [프롬프트 보냄]을 누르면 sahm.txt에 저장되어 매시 14분 예약 실행 때 처리되고, [프롬프트 실행]을 누르면 지금 바로 실행합니다.';
    else if (me.name) note = `${me.name}님으로 로그인되어 있습니다. 프롬프트는 본인 페이지에서만 보낼 수 있어요. 아래 터미널에서 이 페이지의 진행 상황은 볼 수 있습니다.`;
    else note = h('span', {}, h('a', { href: '/login' }, '로그인'), '하면 내 페이지에서 프롬프트를 보내고 실행할 수 있습니다. 아래 터미널에서 진행 상황은 누구나 볼 수 있습니다.');

    const box = h('section', { class: 'wrap term', 'aria-labelledby': 'term-title' },
      h('h2', { id: 'term-title' }, isShared ? 'careworld-in 공동 프롬프트 창 · 터미널' : '프롬프트 창 · 터미널'),
      h('p', { class: 'term-note' }, note),
      h('div', { class: 'term-form' }, input, h('div', { class: 'term-actions' }, sendBtn, runBtn)),
      status,
      h('div', { class: 'term-window' },
        h('div', { class: 'term-bar' }, h('span'), h('span'), h('span'), h('b', {}, `sahmyook — ${slug}`)),
        term),
    );
    if (!ready) box.querySelector('.term-note').after(readyNote());
    main.append(box);
    if (!isShared && me.isAdmin && me.slug === slug) main.append(signupBox());

    const say = (t, bad) => { status.textContent = t; status.classList.toggle('bad', !!bad); };
    const nextRun = () => { // 예약 실행 시각(매시 14분)을 한국시간으로 표시
      const d = new Date();
      const n = new Date(d);
      n.setUTCMinutes(14, 0, 0);
      if (n <= d) n.setUTCHours(n.getUTCHours() + 1);
      return `${String((n.getUTCHours() + 9) % 24).padStart(2, '0')}:14`;
    };

    let timer = null;
    let lastRunAt = 0;
    async function refresh() {
      try {
        const log = await api(`/api/log?person=${slug}`);
        const lines = [`$ sahmyook terminal · ${isShared ? 'careworld-in 공동 공간' : `${log.person.name} 페이지`}`, `  다음 예약 실행: ${nextRun()} (매시 14분)`, ''];
        const mine = isShared ? log.runs : log.runs.filter((r) => r.by === log.person.name);
        for (const r of mine.slice(0, 3)) {
          lines.push(`▶ ${r.at} 실행 요청 (${r.by})`);
          if (r.sessionUrl) lines.push(`  ↳ 실행 세션: ${r.sessionUrl}`);
        }
        if (mine.length) lines.push('');
        if (!log.prompts.length) lines.push('  아직 보낸 프롬프트가 없습니다.');
        for (const p of log.prompts.slice(-15)) {
          lines.push(isShared ? `> ${p.at}  [${p.by}] ${p.text}` : `> ${p.at}  ${p.text}`);
          if (!p.result) lines.push('  … 대기 중 — 다음 실행 때 처리됩니다');
          else if (p.result.status === 'running') lines.push(`  ⟳ 처리 중 (${p.result.at}) ${p.result.note}`);
          else if (p.result.status === 'done') lines.push(`  ✓ 완료 (${p.result.at}) ${p.result.note}`);
          else lines.push(`  ✗ 반영 안 함 (${p.result.at}) ${p.result.note}`);
          lines.push('');
        }
        term.textContent = '';
        for (const l of lines) {
          const url = l.match(/https:\/\/\S+/);
          if (url) {
            const [a, b] = l.split(url[0]);
            term.append(a, h('a', { href: url[0], target: '_blank', rel: 'noopener' }, url[0]), b, '\n');
          } else term.append(l + '\n');
        }
        term.scrollTop = term.scrollHeight;
        const pending = log.prompts.some((p) => !p.result || p.result.status === 'running');
        clearTimeout(timer);
        timer = setTimeout(refresh, pending && Date.now() - lastRunAt < 20 * 60e3 ? 5000 : 20000);
      } catch (e) {
        term.textContent = `터미널을 불러오지 못했습니다: ${e.message}`;
        clearTimeout(timer);
        timer = setTimeout(refresh, 30000);
      }
    }

    sendBtn.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text) { say('프롬프트 내용을 적어 주세요.', true); input.focus(); return; }
      sendBtn.disabled = true;
      say('sahm.txt에 저장하는 중…');
      try {
        await api('/api/prompt', { method: 'POST', body: { person: slug, text } });
        input.value = '';
        say(`저장했습니다. ${nextRun()} 예약 실행 때 처리되며, 지금 바로 하려면 [프롬프트 실행]을 누르세요.`);
        refresh();
      } catch (e) { say(e.message, true); }
      sendBtn.disabled = false;
    });

    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      say('실행을 요청하는 중…');
      try {
        await api('/api/run', { method: 'POST' });
        lastRunAt = Date.now();
        say('실행을 시작했습니다. 처리 결과는 몇 분 안에 터미널에 표시됩니다.');
        refresh();
      } catch (e) { say(e.message, true); }
      runBtn.disabled = false;
    });

    refresh();
  }

  (async () => {
    try { me = await api('/api/me'); } catch { me = { name: null }; }
    renderNav();
    addMembersToNav();
    initLogin().catch((e) => { const m = $('#login-msg'); if (m) m.textContent = e.message; });
    initConsole();
  })();
})();
