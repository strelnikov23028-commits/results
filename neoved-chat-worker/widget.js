/**
 * Виджет обратной связи neoved — вставляется на сайт одной строкой:
 *
 *   <script src="https://neoved-chat.strelnikov2302.workers.dev/widget.js" defer></script>
 *
 * Рисуется внутри shadow DOM: стили Tilda (или любого другого сайта) до него
 * не дотягиваются, а его стили не ломают страницу.
 *
 * Шаблонных строк тут нет намеренно: файл заливается в Cloudflare текстовым
 * модулем и при необходимости инлайнится в worker.js — обратные кавычки в
 * такой сборке пришлось бы экранировать.
 */
(function () {
  'use strict';

  if (window.__neovedChatLoaded) return;
  window.__neovedChatLoaded = true;

  var script = document.currentScript ||
    document.querySelector('script[src*="widget.js"]');
  var API = (script && script.dataset.api) ||
    (script && script.src ? script.src.replace(/\/widget\.js.*$/, '') : '');

  var STORE = 'neoved_chat_v1';
  var POLL_OPEN = 5000;      // виджет раскрыт — ждём ответ менеджера
  var POLL_IDLE = 30000;     // свёрнут — только чтобы зажечь счётчик непрочитанных

  var T = {
    title: (script && script.dataset.title) || 'Напишите нам',
    subtitle: (script && script.dataset.subtitle) || 'Отвечаем в рабочее время, обычно в течение 15 минут',
    accent: (script && script.dataset.accent) || '#EE0000',
    policy: (script && script.dataset.policy) || 'https://neoved.io/policy',
  };

  // ─────────────────────────── состояние ───────────────────────────

  var state = load();
  var open = false;
  var sending = false;
  var lastId = state.lastId || 0;
  var unread = 0;
  var timer = null;
  var motion = null;               // Framer Motion, если CDN доступен

  function load() {
    try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) {}
  }

  // ─────────────────────────── разметка ───────────────────────────

  var CSS = [
    ':host{all:initial}',
    '*,*::before,*::after{box-sizing:border-box}',
    '.root{',
    '  position:fixed;right:24px;bottom:24px;z-index:2147483000;',
    '  font-family:Onest,-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Arial,sans-serif;',
    '  font-size:16px;line-height:1.5;color:#110000;',
    '}',

    /* кнопка-пузырь */
    '.bubble{',
    '  width:64px;height:64px;border:0;border-radius:100px;cursor:pointer;',
    '  background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;',
    '  box-shadow:0 10px 30px rgba(238,0,0,.32);transition:transform .2s ease,box-shadow .2s ease;',
    '}',
    '.bubble:hover{transform:translateY(-2px);box-shadow:0 14px 36px rgba(238,0,0,.4)}',
    '.bubble:active{transform:translateY(0)}',
    '.bubble:focus-visible{outline:3px solid #110000;outline-offset:3px}',
    '.bubble svg{width:28px;height:28px;display:block}',
    '.badge{',
    '  position:absolute;top:-2px;right:-2px;min-width:22px;height:22px;padding:0 6px;',
    '  border-radius:100px;background:#110000;color:#fff;font-size:12px;font-weight:600;',
    '  display:none;align-items:center;justify-content:center;',
    '}',
    '.badge.on{display:flex}',

    /* панель */
    '.panel{',
    '  position:absolute;right:0;bottom:80px;width:384px;max-height:min(640px,calc(100vh - 140px));',
    '  background:#fff;border-radius:28px;overflow:hidden;display:none;flex-direction:column;',
    '  box-shadow:0 24px 70px rgba(17,0,0,.18),0 2px 8px rgba(17,0,0,.06);',
    '}',
    '.panel.on{display:flex}',

    '.head{background:#110000;color:#fff;padding:20px 22px;display:flex;gap:12px;align-items:flex-start}',
    '.head h2{margin:0;font-size:19px;font-weight:500;letter-spacing:-.01em}',
    '.head p{margin:4px 0 0;font-size:13px;line-height:1.45;color:rgba(255,255,255,.62)}',
    '.head .dot{width:8px;height:8px;border-radius:100px;background:#62C584;margin-top:8px;flex:0 0 auto}',
    '.close{',
    '  margin-left:auto;width:36px;height:36px;flex:0 0 auto;border:0;border-radius:100px;cursor:pointer;',
    '  background:rgba(255,255,255,.1);color:#fff;display:flex;align-items:center;justify-content:center;',
    '  transition:background .2s ease;',
    '}',
    '.close:hover{background:rgba(255,255,255,.2)}',
    '.close:focus-visible{outline:2px solid #fff;outline-offset:2px}',
    '.close svg{width:16px;height:16px}',

    /* форма */
    '.body{padding:20px 22px 22px;overflow-y:auto;-webkit-overflow-scrolling:touch}',
    '.field{margin-bottom:14px}',
    '.field label{display:block;font-size:13px;font-weight:500;margin-bottom:6px;color:#110000}',
    '.field .opt{color:#999;font-weight:400}',
    '.field input,.field textarea{',
    '  width:100%;min-height:48px;padding:13px 16px;border:1.5px solid #EEE;border-radius:16px;',
    '  background:#F7F7F7;font:inherit;font-size:15px;color:#110000;transition:border-color .18s ease,background .18s ease;',
    '}',
    '.field textarea{min-height:96px;resize:vertical;line-height:1.5}',
    '.field input:hover,.field textarea:hover{border-color:#DDD}',
    '.field input:focus,.field textarea:focus{outline:0;border-color:var(--accent);background:#fff}',
    '.field input::placeholder,.field textarea::placeholder{color:#AAA}',
    '.field.bad input,.field.bad textarea{border-color:var(--accent);background:#fff}',
    '.err{display:none;margin:6px 0 0;font-size:12.5px;color:var(--accent)}',
    '.field.bad .err{display:block}',

    '.submit{',
    '  width:100%;min-height:52px;margin-top:4px;border:0;border-radius:100px;cursor:pointer;',
    '  background:var(--accent);color:#fff;font:inherit;font-size:16px;font-weight:500;',
    '  display:flex;align-items:center;justify-content:center;gap:10px;',
    '  transition:transform .18s ease,opacity .18s ease;',
    '}',
    '.submit:hover:not(:disabled){transform:translateY(-2px)}',
    '.submit:disabled{opacity:.6;cursor:default}',
    '.submit:focus-visible{outline:3px solid #110000;outline-offset:2px}',
    '.note{margin:12px 0 0;font-size:11.5px;line-height:1.5;color:#999;text-align:center}',
    '.note a{color:#999;text-decoration:underline}',
    '.fail{',
    '  display:none;margin:0 0 14px;padding:12px 14px;border-radius:14px;',
    '  background:#FDECEC;color:#C40000;font-size:13.5px;line-height:1.45;',
    '}',
    '.fail.on{display:block}',

    /* чат */
    '.chat{display:none;flex-direction:column;flex:1;min-height:0}',
    '.chat.on{display:flex}',
    '.feed{flex:1;min-height:180px;overflow-y:auto;padding:20px 22px;display:flex;flex-direction:column;gap:10px}',
    '.msg{max-width:82%;padding:11px 15px;border-radius:20px;font-size:14.5px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}',
    '.msg.me{align-self:flex-end;background:var(--accent);color:#fff;border-bottom-right-radius:8px}',
    '.msg.them{align-self:flex-start;background:#F0F0F0;color:#110000;border-bottom-left-radius:8px}',
    '.msg .who{display:block;font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;opacity:.6;margin-bottom:3px}',
    '.sys{align-self:center;max-width:90%;text-align:center;font-size:12px;line-height:1.5;color:#999}',
    '.compose{display:flex;gap:8px;padding:14px 16px;border-top:1px solid #EEE;background:#fff}',
    '.compose textarea{',
    '  flex:1;min-height:48px;max-height:120px;padding:13px 16px;border:1.5px solid #EEE;border-radius:20px;',
    '  background:#F7F7F7;font:inherit;font-size:15px;color:#110000;resize:none;transition:border-color .18s ease;',
    '}',
    '.compose textarea:focus{outline:0;border-color:var(--accent);background:#fff}',
    '.send{',
    '  width:48px;height:48px;flex:0 0 auto;border:0;border-radius:100px;cursor:pointer;align-self:flex-end;',
    '  background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;',
    '  transition:transform .18s ease,opacity .18s ease;',
    '}',
    '.send:hover:not(:disabled){transform:translateY(-2px)}',
    '.send:disabled{opacity:.5;cursor:default}',
    '.send:focus-visible{outline:3px solid #110000;outline-offset:2px}',
    '.send svg{width:20px;height:20px}',

    '.spin{width:18px;height:18px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:100px;animation:spin .7s linear infinite}',
    '@keyframes spin{to{transform:rotate(360deg)}}',

    /* мобильные: панель на весь экран */
    '@media (max-width:480px){',
    '  .root{right:16px;bottom:16px}',
    '  .panel{position:fixed;inset:0;width:100%;max-height:none;height:100dvh;border-radius:0}',
    '  .bubble{width:58px;height:58px}',
    '}',
    '@media (prefers-reduced-motion:reduce){',
    '  .bubble,.submit,.send{transition:none}',
    '  .bubble:hover,.submit:hover,.send:hover{transform:none}',
    '  .spin{animation-duration:2s}',
    '}',
  ].join('\n');

  var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
  var ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  var ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>';

  var HTML = [
    '<div class="root" part="root">',
    '  <div class="panel" role="dialog" aria-modal="false" aria-label="Чат с отделом продаж neoved">',
    '    <div class="head">',
    '      <span class="dot" aria-hidden="true"></span>',
    '      <div>',
    '        <h2 id="nv-title"></h2>',
    '        <p id="nv-sub"></p>',
    '      </div>',
    '      <button class="close" type="button" aria-label="Свернуть чат">' + ICON_CLOSE + '</button>',
    '    </div>',

    '    <form class="body" novalidate>',
    '      <p class="fail" role="alert"></p>',
    '      <div class="field" data-for="name">',
    '        <label for="nv-name">Имя</label>',
    '        <input id="nv-name" name="name" type="text" autocomplete="name" placeholder="Как к вам обращаться">',
    '        <p class="err">Напишите, как к вам обращаться</p>',
    '      </div>',
    '      <div class="field" data-for="email">',
    '        <label for="nv-email">Почта</label>',
    '        <input id="nv-email" name="email" type="email" inputmode="email" autocomplete="email" placeholder="you@company.com">',
    '        <p class="err">Проверьте адрес почты</p>',
    '      </div>',
    '      <div class="field" data-for="phone">',
    '        <label for="nv-phone">Телефон</label>',
    '        <input id="nv-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 999 123-45-67">',
    '        <p class="err">Проверьте номер телефона</p>',
    '      </div>',
    '      <div class="field" data-for="tg">',
    '        <label for="nv-tg">Telegram <span class="opt">— если удобнее там</span></label>',
    '        <input id="nv-tg" name="tg" type="text" autocomplete="off" placeholder="@username">',
    '        <p class="err">Ник в формате @username</p>',
    '      </div>',
    '      <div class="field" data-for="message">',
    '        <label for="nv-msg">Вопрос</label>',
    '        <textarea id="nv-msg" name="message" placeholder="Опишите задачу — ответим здесь же"></textarea>',
    '        <p class="err">Напишите хотя бы пару слов о задаче</p>',
    '      </div>',
    '      <button class="submit" type="submit"><span class="label">Связаться</span></button>',
    '      <p class="note">Нажимая «Связаться», вы соглашаетесь с <a href="#" target="_blank" rel="noopener" id="nv-policy">политикой обработки персональных данных</a></p>',
    '    </form>',

    '    <div class="chat">',
    '      <div class="feed" role="log" aria-live="polite" aria-label="История переписки"></div>',
    '      <form class="compose">',
    '        <textarea rows="1" placeholder="Сообщение…" aria-label="Текст сообщения"></textarea>',
    '        <button class="send" type="submit" aria-label="Отправить сообщение">' + ICON_SEND + '</button>',
    '      </form>',
    '    </div>',
    '  </div>',

    '  <button class="bubble" type="button" aria-label="Открыть чат с отделом продаж" aria-expanded="false">',
    '    ' + ICON_CHAT,
    '    <span class="badge" aria-hidden="true"></span>',
    '  </button>',
    '</div>',
  ].join('\n');

  // ─────────────────────────── сборка ───────────────────────────

  var host = document.createElement('div');
  host.id = 'neoved-chat';
  var shadow = host.attachShadow({ mode: 'open' });
  var style = document.createElement('style');
  style.textContent = ':host{--accent:' + T.accent + '}\n' + CSS;
  shadow.appendChild(style);
  var wrap = document.createElement('div');
  wrap.innerHTML = HTML;
  while (wrap.firstChild) shadow.appendChild(wrap.firstChild);

  var $ = function (sel) { return shadow.querySelector(sel); };
  var panel = $('.panel');
  var bubble = $('.bubble');
  var badge = $('.badge');
  var form = $('form.body');
  var chat = $('.chat');
  var feed = $('.feed');
  var compose = $('form.compose');
  var composeText = compose.querySelector('textarea');
  var sendBtn = $('.send');
  var submitBtn = $('.submit');
  var fail = $('.fail');

  $('#nv-title').textContent = T.title;
  $('#nv-sub').textContent = T.subtitle;
  $('#nv-policy').href = T.policy;

  // Onest — фирменный шрифт neoved.io. На самом сайте он уже подключён,
  // на сторонней странице подтягиваем сами; не загрузится — сработает
  // системный шрифт из font-family.
  if (!document.querySelector('link[href*="family=Onest"]')) {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600&display=swap';
    document.head.appendChild(link);
  }

  function mount() {
    document.body.appendChild(host);
    if (state.sid) { showChat(); render(); poll(); }
    schedule();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  // Framer Motion: тот же движок, что и в React-версии. Не подгрузился —
  // остаются CSS-переходы, виджет работает без анимаций входа.
  import('https://cdn.jsdelivr.net/npm/motion@11/+esm')
    .then(function (m) { motion = m; })
    .catch(function () { motion = null; });

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function animateIn(el) {
    if (!motion || reduced) return;
    motion.animate(el, { opacity: [0, 1], y: [12, 0], scale: [0.98, 1] },
      { duration: 0.26, easing: [0.22, 1, 0.36, 1] });
  }

  // ─────────────────────────── открытие/закрытие ───────────────────────────

  function setOpen(next) {
    open = next;
    panel.classList.toggle('on', open);
    bubble.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      unread = 0;
      badge.classList.remove('on');
      animateIn(panel);
      var focusTarget = state.sid ? composeText : $('#nv-name');
      setTimeout(function () { try { focusTarget.focus(); } catch (e) {} }, 60);
      if (state.sid) { poll(); scrollDown(); }
    }
    schedule();
  }

  bubble.addEventListener('click', function () { setOpen(!open); });
  $('.close').addEventListener('click', function () { setOpen(false); bubble.focus(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && open) { setOpen(false); bubble.focus(); }
  });

  // ─────────────────────────── форма ───────────────────────────

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zа-я]{2,}$/i;

  function value(name) {
    var el = form.querySelector('[name="' + name + '"]');
    return (el.value || '').trim();
  }
  function markBad(name, bad) {
    var box = form.querySelector('.field[data-for="' + name + '"]');
    if (box) box.classList.toggle('bad', !!bad);
  }

  function validate() {
    var v = {
      name: value('name'),
      email: value('email'),
      phone: value('phone'),
      tg: value('tg'),
      message: value('message'),
    };
    var bad = [];
    if (v.name.length < 2) bad.push('name');
    if (!EMAIL_RE.test(v.email)) bad.push('email');
    if (v.phone.replace(/\D/g, '').length < 10) bad.push('phone');
    if (v.tg && !/^@?[a-z0-9_]{4,32}$/i.test(v.tg.replace(/^https?:\/\/(t\.me|telegram\.me)\//i, ''))) bad.push('tg');
    if (v.message.length < 5) bad.push('message');

    ['name', 'email', 'phone', 'tg', 'message'].forEach(function (k) {
      markBad(k, bad.indexOf(k) >= 0);
    });
    if (bad.length) {
      var first = form.querySelector('.field[data-for="' + bad[0] + '"] input, .field[data-for="' + bad[0] + '"] textarea');
      if (first) first.focus();
      return null;
    }
    return v;
  }

  ['name', 'email', 'phone', 'tg', 'message'].forEach(function (k) {
    var el = form.querySelector('[name="' + k + '"]');
    el.addEventListener('blur', function () {
      if (el.value.trim()) markBad(k, false);
    });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (sending) return;
    var v = validate();
    if (!v) return;

    busy(submitBtn, true, 'Отправляем…');
    fail.classList.remove('on');

    api('/api/start', {
      name: v.name, email: v.email, phone: v.phone, tg: v.tg,
      message: v.message, page: location.href,
    }).then(function (res) {
      state.sid = res.sid;
      state.name = v.name;
      state.messages = [{ id: 'me-' + Date.now(), me: true, text: v.message }];
      lastId = 0;
      save();
      showChat();
      render();
      poll();
      // До этого момента опрашивать было нечего, и таймер не заводился.
      schedule();
    }).catch(function (err) {
      fail.textContent = err.message || 'Не удалось отправить. Попробуйте ещё раз или напишите на sales@neoved.io';
      fail.classList.add('on');
    }).then(function () {
      busy(submitBtn, false, 'Связаться');
    });
  });

  function busy(btn, on, label) {
    sending = on;
    btn.disabled = on;
    if (btn === submitBtn) {
      btn.innerHTML = on
        ? '<span class="spin"></span><span class="label">' + label + '</span>'
        : '<span class="label">' + label + '</span>';
    }
  }

  // ─────────────────────────── чат ───────────────────────────

  function showChat() {
    form.style.display = 'none';
    chat.classList.add('on');
  }

  function render() {
    var items = state.messages || [];
    feed.innerHTML = '';
    var intro = document.createElement('p');
    intro.className = 'sys';
    intro.textContent = 'Заявка ушла в отдел продаж. Ответ придёт сюда — страницу можно не держать открытой, переписка сохранится.';
    feed.appendChild(intro);

    items.forEach(function (m) {
      var el = document.createElement('div');
      el.className = 'msg ' + (m.me ? 'me' : 'them');
      if (!m.me) {
        var who = document.createElement('span');
        who.className = 'who';
        who.textContent = 'neoved';
        el.appendChild(who);
      }
      el.appendChild(document.createTextNode(m.text));
      feed.appendChild(el);
    });
    scrollDown();
  }

  function scrollDown() {
    requestAnimationFrame(function () { feed.scrollTop = feed.scrollHeight; });
  }

  function push(msg) {
    state.messages = (state.messages || []).concat([msg]);
    if (state.messages.length > 100) state.messages = state.messages.slice(-100);
    save();
  }

  compose.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = (composeText.value || '').trim();
    if (!text || sending || !state.sid) return;

    composeText.value = '';
    push({ id: 'me-' + Date.now(), me: true, text: text });
    render();

    sending = true;
    sendBtn.disabled = true;
    api('/api/send', { sid: state.sid, text: text }).catch(function (err) {
      push({ id: 'sys-' + Date.now(), me: false, text: 'Сообщение не доставлено: ' + (err.message || 'ошибка сети') });
      render();
    }).then(function () {
      sending = false;
      sendBtn.disabled = false;
    });
  });

  composeText.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      compose.dispatchEvent(new Event('submit'));
    }
  });
  composeText.addEventListener('input', function () {
    composeText.style.height = 'auto';
    composeText.style.height = Math.min(composeText.scrollHeight, 120) + 'px';
  });

  // ─────────────────────────── ответы менеджера ───────────────────────────

  function poll() {
    if (!state.sid) return Promise.resolve();
    return api('/api/poll?sid=' + encodeURIComponent(state.sid) + '&after=' + lastId, null)
      .then(function (res) {
        var list = res.messages || [];
        if (!list.length) return;
        list.forEach(function (m) {
          lastId = Math.max(lastId, Number(m.id) || 0);
          push({ id: m.id, me: false, text: m.text });
        });
        state.lastId = lastId;
        save();
        render();
        if (!open) {
          unread += list.length;
          badge.textContent = unread > 9 ? '9+' : String(unread);
          badge.classList.add('on');
        }
      })
      .catch(function () { /* сеть моргнула — повторим на следующем тике */ });
  }

  function schedule() {
    if (timer) clearInterval(timer);
    if (!state.sid) return;
    timer = setInterval(function () {
      if (document.hidden) return;
      poll();
    }, open ? POLL_OPEN : POLL_IDLE);
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && state.sid) poll();
  });

  // ─────────────────────────── сеть ───────────────────────────

  function api(path, body) {
    var opts = { method: body ? 'POST' : 'GET' };
    if (body) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    return fetch(API + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok || data.ok === false) {
          throw new Error(data.error || ('Сервер ответил ' + r.status));
        }
        return data;
      });
    });
  }

  // Ручное управление с сайта: neovedChat.open() — например, с кнопки в шапке.
  window.neovedChat = {
    open: function () { setOpen(true); },
    close: function () { setOpen(false); },
    reset: function () {
      state = {};
      lastId = 0;
      save();
      location.reload();
    },
  };
})();
