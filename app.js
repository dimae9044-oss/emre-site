/* emre — web app for streamer subscriptions (frontend demo + Telegram Worker API) */

const STORAGE_KEY = 'emreStreams.state.v1';
const AUTH_KEY = 'emreStreams.auth.v1';
const USER_KEY = 'emreStreams.user.v1';
const CURRENT_ADMIN_PASSWORD = '604Ss1480';
const AUTHOR_TELEGRAM = '@dimasert56';
const BANK_APPS = [
  { label: 'Сбер', url: 'https://www.sberbank.ru/' },
  { label: 'Т-Банк', url: 'https://www.tbank.ru/' },
  { label: 'Альфа-Банк', url: 'https://alfabank.ru/' },
  { label: 'Озон Банк', url: 'https://ozonbank.ru/' }
];

const clone = (value) => JSON.parse(JSON.stringify(value));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const DAY = 24 * 60 * 60 * 1000;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

function makeDefaultState() {
  const now = new Date();

  return {
    settings: {
      botName: 'emre',
      price: 200,
      channel: '7946867611',
      adminPassword: CURRENT_ADMIN_PASSWORD,
      sbpPhone: '7 920 604 14 80',
      receivingBank: 'Т-Банк',
      paymentComment: 'emre — подписка на стримы',
      workerUrl: location.protocol === 'https:' ? location.origin : 'http://localhost:8787',
      adminToken: 'd3b834a6283544df8510d98bdd393621'
    },
    streamers: [
      {
        id: 'st-nainangel',
        name: 'Nainangel',
        twitch: 'nainangel',
        chatId: '@nainangel',
        game: 'Fortnite',
        title: 'Какая-то игра с сундуками',
        link: 'https://www.twitch.tv/nainangel',
        status: 'active',
        joinedAt: new Date(now.getTime() - 20 * DAY).toISOString(),
        paidUntil: new Date(now.getTime() + 10 * DAY).toISOString()
      },
      {
        id: 'st-dimstream',
        name: 'DimStream',
        twitch: 'dimstream',
        chatId: '@dimstream',
        game: 'Fortnite',
        title: 'Рейтинговая катка с чатом',
        link: 'https://www.twitch.tv/dimstream',
        status: 'active',
        joinedAt: new Date(now.getTime() - 8 * DAY).toISOString(),
        paidUntil: new Date(now.getTime() + 22 * DAY).toISOString()
      }
    ],
    subscribers: [
      {
        id: 'sub-1',
        streamerId: 'st-nainangel',
        name: 'Nainangel',
        telegram: '@nainangel',
        status: 'active',
        joinedAt: new Date(now.getTime() - 20 * DAY).toISOString(),
        paidUntil: new Date(now.getTime() + 10 * DAY).toISOString()
      },
      {
        id: 'sub-2',
        streamerId: 'st-dimstream',
        name: 'DimStream',
        telegram: '@dimstream',
        status: 'active',
        joinedAt: new Date(now.getTime() - 8 * DAY).toISOString(),
        paidUntil: new Date(now.getTime() + 22 * DAY).toISOString()
      }
    ],
    accounts: [
      { id: 'acc-nainangel', username: '@nainangel', name: 'Nainangel', channel: '@nainangel', createdAt: new Date(now.getTime() - 20 * DAY).toISOString() },
      { id: 'acc-dimstream', username: '@dimstream', name: 'DimStream', channel: '@dimstream', createdAt: new Date(now.getTime() - 8 * DAY).toISOString() }
    ]
  };
}

function mergeState(parsed) {
  const def = makeDefaultState();
  if (!parsed || typeof parsed !== 'object') return def;
  const settings = { ...def.settings, ...(parsed.settings || {}), adminPassword: CURRENT_ADMIN_PASSWORD };
  if (!settings.workerUrl) settings.workerUrl = def.settings.workerUrl;
  if (location.protocol === 'https:' && /^http:\/\/(localhost|127\.0\.0\.1)/.test(settings.workerUrl)) {
    settings.workerUrl = location.origin;
  }
  if (!settings.adminToken) settings.adminToken = def.settings.adminToken;
  if (!settings.channel) settings.channel = def.settings.channel;
  if (!settings.receivingBank) settings.receivingBank = def.settings.receivingBank;

  const accounts = Array.isArray(parsed.accounts) && parsed.accounts.length ? parsed.accounts : def.accounts;

  return {
    settings,
    streamers: Array.isArray(parsed.streamers) ? parsed.streamers : def.streamers,
    subscribers: Array.isArray(parsed.subscribers) ? parsed.subscribers : def.subscribers,
    accounts
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return makeDefaultState();
    return mergeState(JSON.parse(raw));
  } catch {
    return makeDefaultState();
  }
}

let state = loadState();
let currentView = location.hash === '#admin' ? 'admin' : 'public';
let adminTab = 'overview';
let modalSubmit = null;

const normUser = (value) => '@' + String(value || '').trim().replace(/^@+/, '').toLowerCase();
const validUser = (value) => /^[A-Za-z0-9_]{5,32}$/.test(String(value || '').trim().replace(/^@+/, ''));

function loadCurrentUser() {
  try { return sessionStorage.getItem(USER_KEY) || ''; } catch { return ''; }
}

let currentUser = loadCurrentUser();

function findAccount(username) {
  const needle = normUser(username);
  return (state.accounts || []).find((a) => normUser(a.username) === needle) || null;
}

function loginUser(username) {
  currentUser = normUser(username);
  sessionStorage.setItem(USER_KEY, currentUser);
}

function logoutUser() {
  currentUser = '';
  sessionStorage.removeItem(USER_KEY);
}

/* ---------- AI-проверка данных ---------- */
const AI_URL = 'https://text.pollinations.ai/openai';
const AI_SYSTEM = 'Ты строгий валидатор демо-сайта emre. Проверяй только формат и согласованность данных: Telegram-логин @name (5-32 буквы/цифры/_), Twitch-логин (4-32), ссылка twitch.tv/<логин>, канал начинается с @, цена — число больше нуля. НЕ проверяй реальное существование аккаунтов в Telegram. Возвращай строго JSON: {"ok":true,"issues":[]} либо {"ok":false,"issues":["причина"]}. Без текста вне JSON.';

async function aiRequest(data) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(AI_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openai',
        messages: [
          { role: 'system', content: AI_SYSTEM },
          { role: 'user', content: JSON.stringify(data) }
        ],
        stream: false,
        max_tokens: 200,
        temperature: 0
      }),
      signal: controller.signal
    });
    if (!response.ok) return null;
    const result = await response.json();
    const content = String(result?.choices?.[0]?.message?.content || '');
    const match = content.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function aiVerdict(result, local = false) {
  if (!result) return null;
  const issues = Array.isArray(result.issues) ? result.issues.filter(Boolean) : [];
  return { ok: result.ok !== false && issues.length === 0, issues, local };
}

// Встроенная модель: работает всегда, даже если внешний ИИ недоступен или требует оплату.
function localAiVerdict(data) {
  const issues = [];
  const str = (v) => String(v || '').trim();
  const userOk = (v) => /^[A-Za-z0-9_]{5,32}$/.test(str(v).replace(/^@+/, ''));
  const twitchOk = (v) => /^[A-Za-z0-9_]{4,32}$/.test(str(v).replace(/^@+/, '').replace(/^https?:\/\/[^/]+\//, '').replace(/^www\./, ''));
  const add = (condition, message) => { if (!condition) issues.push(message); };

  if (data.kind === 'login') {
    add(userOk(data.username), 'неверный Telegram-логин');
  } else if (data.kind === 'register') {
    add(userOk(data.username), 'неверный Telegram-логин');
    add(str(data.name).length >= 2, 'слишком короткое имя');
    add(userOk(data.channel), 'неверный Telegram-канал');
  } else if (data.kind === 'payment') {
    add(str(data.name).length >= 2, 'слишком короткое имя стримера');
    add(twitchOk(data.twitch), 'неверный Twitch-логин');
    add(userOk(data.channel), 'неверный Telegram-канал');
    add(Number(data.price) > 0, 'неверная цена');
    add(str(data.sbpPhone).replace(/\D/g, '').length >= 10, 'неверный номер СБП');
  } else if (data.kind === 'streamer') {
    add(str(data.name).length >= 2, 'слишком короткое имя стримера');
    add(twitchOk(data.twitch), 'неверный Twitch-логин');
    add(userOk(data.chatId), 'неверный Telegram-канал');
    if (str(data.link)) {
      const login = str(data.twitch).replace(/^@+/, '').toLowerCase();
      add(str(data.link).toLowerCase().includes('twitch.tv/' + login), 'ссылка не соответствует Twitch-логину');
    }
  } else if (data.kind === 'audit') {
    (data.accounts || []).forEach((a) => {
      add(userOk(a.username), 'аккаунт ' + str(a.username));
      add(userOk(a.channel), 'канал ' + str(a.channel));
    });
    (data.streamers || []).forEach((s) => {
      add(str(s.name).length >= 2, 'стример ' + str(s.name));
      add(twitchOk(s.twitch), 'Twitch ' + str(s.twitch));
      add(userOk(s.chatId), 'канал стримера ' + str(s.chatId));
    });
    (data.subscribers || []).forEach((s) => add(userOk(s.telegram), 'подписчик ' + str(s.telegram)));
    add(Number(data.settings?.price) > 0, 'неверная цена');
    add(str(data.settings?.sbpPhone).replace(/\D/g, '').length >= 10, 'неверный номер СБП');
  }
  return { ok: issues.length === 0, issues: issues.slice(0, 8) };
}

async function aiCheck(data) {
  const remote = await aiRequest(data);
  return remote ? aiVerdict(remote) : aiVerdict(localAiVerdict(data), true);
}

async function aiFormCheck(kind, data, targetId) {
  const el = document.getElementById(targetId);
  if (el) el.textContent = '🤖 ИИ: проверяю…';
  const verdict = await aiCheck({ kind, ...data });
  if (!el) return verdict;
  const suffix = verdict.local ? ' (локальная модель)' : '';
  if (verdict.ok) {
    el.textContent = '🤖 ИИ: данные корректны' + suffix;
    el.classList.remove('form-error');
  } else {
    el.textContent = '🤖 ИИ: ' + verdict.issues.join('; ');
    el.classList.add('form-error');
  }
  return verdict;
}

let aiAuditTimer = null;

async function aiAuditState() {
  const badge = document.getElementById('aiBadge');
  if (!badge) return;
  badge.textContent = '🤖 ИИ: проверяю…';
  badge.classList.remove('ai-badge--warn');
  const verdict = await aiCheck({
    kind: 'audit',
    accounts: (state.accounts || []).map((a) => ({ username: a.username, channel: a.channel })),
    streamers: (state.streamers || []).map((s) => ({ name: s.name, twitch: s.twitch, chatId: s.chatId, status: s.status })),
    subscribers: (state.subscribers || []).map((s) => ({ telegram: s.telegram, status: s.status })),
    settings: { botName: state.settings.botName, price: state.settings.price, sbpPhone: state.settings.sbpPhone, receivingBank: state.settings.receivingBank }
  });
  if (verdict.ok) {
    badge.textContent = '🤖 ИИ: всё ок';
    badge.title = verdict.local ? 'Проверено локальной моделью' : 'Данные сайта согласованы';
  } else {
    badge.textContent = `🤖 ИИ: ${verdict.issues.length} замечаний`;
    badge.title = verdict.issues.join('\n');
    badge.classList.add('ai-badge--warn');
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  clearTimeout(aiAuditTimer);
  aiAuditTimer = setTimeout(() => aiAuditState(), 600);
  if (location.protocol === 'http:') {
    fetch('/api/state?token=' + encodeURIComponent(state.settings.adminToken), {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(state),
      keepalive: true
    }).catch(() => {});
  }
}

function isAuthed() {
  return sessionStorage.getItem(AUTH_KEY) === '1';
}

function fmtMoney(value) {
  return `${Number(value || 0).toLocaleString('ru-RU')} ₽`;
}

function fmtDate(iso, withTime = true) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'long',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {})
  });
}

function toLocalInput(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function fromLocalInput(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function checked(value) {
  return value ? 'checked' : '';
}

function selected(value, current) {
  return value === current ? 'selected' : '';
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fallback ниже */ }

  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}

function getStreamer(id) {
  return state.streamers.find((s) => s.id === id) || null;
}

function streamerLink(streamer) {
  if (!streamer) return '';
  return streamer.link || (streamer.twitch ? `https://www.twitch.tv/${streamer.twitch}` : '');
}

/* ---------- toast ---------- */
function toast(message, type = 'ok') {
  const root = document.getElementById('toastRoot');
  const node = document.createElement('div');
  node.className = `toast toast--${type === 'err' ? 'err' : 'ok'}`;
  node.innerHTML = `<span class="toast__ico">${type === 'err' ? '⚠️' : '✅'}</span><span>${esc(message)}</span>`;
  root.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateX(20px)';
    node.style.transition = '0.25s ease';
    setTimeout(() => node.remove(), 260);
  }, 3800);
}

/* ---------- modal ---------- */
function openModal({ title, subtitle = '', body, submitText = '', onSubmit = null }) {
  modalSubmit = onSubmit;
  const root = document.getElementById('modalRoot');
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal__head">
          <div>
            <h3>${esc(title)}</h3>
            ${subtitle ? `<p>${esc(subtitle)}</p>` : ''}
          </div>
          <button class="modal__close" type="button" data-action="close-modal" aria-label="Закрыть">×</button>
        </div>
        <form id="modalForm" class="form-grid form-grid--one">
          ${body}
          <div class="form-actions">
            <button type="button" class="btn btn--ghost" data-action="close-modal">Отмена</button>
            ${submitText ? `<button type="submit" class="btn btn--primary">${esc(submitText)}</button>` : ''}
          </div>
        </form>
      </div>
    </div>`;
  const first = root.querySelector('input:not([type="hidden"]), textarea, select');
  if (first) setTimeout(() => first.focus(), 60);
}

function closeModal() {
  document.getElementById('modalRoot').innerHTML = '';
  modalSubmit = null;
}

/* ---------- navigation ---------- */
function renderNav(admin) {
  return `
    <nav class="navbar">
      <div class="container navbar__inner">
        <button class="brand" type="button" data-action="go-public" style="border:0;background:none;color:inherit;padding:0;">
          <span class="brand__mark">e</span>
          <span>
            <span class="brand__name">${esc(state.settings.botName)}</span>
            <span class="brand__dot"></span>
          </span>
        </button>
        ${admin ? '' : `
          <div class="nav-links">
            <button class="nav-link" type="button" data-scroll="top">Главная</button>
            <button class="nav-link" type="button" data-scroll="subscribe">Подписка</button>
            <button class="nav-link" type="button" data-scroll="top">Пример поста</button>
          </div>`}
        <div class="navbar__actions">
          <span id="aiBadge" class="ai-badge">🤖 ИИ: проверяю…</span>
          ${currentUser
            ? `<span class="user-chip" title="Вы вошли">@${esc(currentUser.replace(/^@/, ''))}</span>
               <button class="btn btn--ghost btn--sm" type="button" data-action="logout-user">Выйти</button>`
            : `<button class="btn btn--ghost btn--sm" type="button" data-action="open-login">Войти</button>`}
          ${admin
            ? `<button class="btn btn--ghost btn--sm" type="button" data-action="go-public">На сайт</button>`
            : `<button class="btn btn--ghost btn--sm" type="button" data-action="go-admin">Админ-панель</button>`}
        </div>
      </div>
    </nav>`;
}

function renderFooter() {
  return `
    <footer class="footer">
      <div class="container footer__inner">
        <span>© ${new Date().getFullYear()} <span class="footer__bot">${esc(state.settings.botName)}</span> · стримы с уведомлениями в Telegram</span>
        <span>Автор: <a href="https://t.me/dimasert56" target="_blank" rel="noopener noreferrer">${esc(AUTHOR_TELEGRAM)}</a> · Telegram</span>
        <span>Сделано для тех, кто не любит пропускать эфиры 💜</span>
      </div>
    </footer>`;
}

function renderBankApps() {
  return `
    <div class="bank-apps">
      <div class="bank-apps__label">Открыть приложение банка для перевода:</div>
      <div class="bank-apps__list">
        ${BANK_APPS.map((bank) => `
          <a class="bank-chip" href="${esc(bank.url)}" target="_blank" rel="noopener noreferrer">${esc(bank.label)} ↗</a>`).join('')}
      </div>
      <small>На телефоне ссылка откроет сайт/приложение банка. Перевод — СБП по номеру телефона.</small>
    </div>`;
}

/* ---------- public view ---------- */
function renderExampleCard() {
  const demo = getStreamer('st-nainangel') || state.streamers[0] || {
    name: 'Nainangel',
    game: 'Fortnite',
    title: 'Какая-то игра с сундуками',
    twitch: 'nainangel'
  };
  const link = streamerLink(demo) || 'https://www.twitch.tv/nainangel';

  return `
    <div class="card next-card">
      <div class="next-card__top">
        <span class="next-card__label">Так выглядит пост в канале</span>
        <span class="badge badge--live">ОТ БОТА ${esc(state.settings.botName)}</span>
      </div>
      <div class="post-preview">
        <b>🔴 СТРИМ НАЧАЛСЯ!</b><br><br>
        👤 ${esc(demo.name)}<br>
        🎮 Игра: ${esc(demo.game || 'Fortnite')}<br>
        📝 ${esc(demo.title || 'Стрим')}<br>
        👉 Смотреть: <a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(link)}</a><br>
        🕒 26 ноября, 21:45 МСК
      </div>
      <div class="next-card__meta">
        <div class="meta-row"><span class="meta-row__icon">🤖</span><span>Бот ${esc(state.settings.botName)} публикует от твоего имени</span></div>
        <div class="meta-row"><span class="meta-row__icon">📢</span><span>Пост уходит в твой Telegram-канал</span></div>
      </div>
      <button class="btn btn--primary btn--block" type="button" data-action="open-pay">
        Подключить бота
      </button>
    </div>`;
}

function renderPublic() {
  const price = fmtMoney(state.settings.price);

  return `
    <div class="app-shell" id="top">
      ${renderNav(false)}
      <main>
        <section class="container hero">
          <div>
            <span class="badge"><span class="status-dot status-dot--on"></span> БОТ ДЛЯ СТРИМЕРОВ · ${esc(price)} / МЕСЯЦ</span>
            <h1 style="margin-top:22px">Твой стрим — <span class="gradient-text">в его Telegram-канале</span></h1>
            <p class="lead">${esc(state.settings.botName)} — бот, который публикует уведомление и ссылку на твой Twitch в твоём канале. Начал эфир — подписчики уже получили сообщение.</p>
            <div class="hero__actions">
              <button class="btn btn--primary" type="button" data-action="open-pay">Подключить за ${esc(price)}</button>
              <button class="btn btn--ghost" type="button" data-scroll="subscribe">Условия подписки</button>
            </div>
            <div class="hero__stats">
              <div class="hero__stat"><strong>${state.streamers.filter((s) => s.status === 'active').length}</strong><span>стримеров подключено</span></div>
              <div class="hero__stat"><strong>${state.streamers.length}</strong><span>каналов в системе</span></div>
              <div class="hero__stat"><strong>24/7</strong><span>автопубликация</span></div>
            </div>
          </div>
          ${renderExampleCard()}
        </section>

        <section class="section container" id="subscribe">
          <div class="section-head">
            <div>
              <span class="eyebrow">Подписка</span>
              <h2>Один бот для твоего канала</h2>
              <p>${esc(price)} в месяц — и уведомления уходят в твой Telegram-канал без ручного копирования.</p>
            </div>
          </div>
          <div class="pricing-wrap">
            <div class="card pricing-copy">
              <h3>Что входит в подписку</h3>
              <ul class="feature-list">
                <li><span class="feature-list__check">✓</span><span>Пост «🔴 СТРИМ НАЧАЛСЯ!» с именем, игрой и ссылкой</span></li>
                <li><span class="feature-list__check">✓</span><span>Автопубликация при старте стрима через Twitch EventSub</span></li>
                <li><span class="feature-list__check">✓</span><span>Публикация прямо в твоём Telegram-канале</span></li>
                <li><span class="feature-list__check">✓</span><span>Ссылка на твой Twitch, например twitch.tv/nainangel</span></li>
                <li><span class="feature-list__check">✓</span><span>Настройка текста и игры через админ-панель</span></li>
              </ul>
            </div>
            <div class="card price-card">
              <span class="badge price-card__badge badge--green">ПОПУЛЯРНОЕ</span>
              <div class="price-card__name">Бот ${esc(state.settings.botName)}</div>
              <div class="price">${esc(price)}<span> / мес</span></div>
              <div class="price-card__note">Оплата раз в месяц. Бот публикует от твоего имени.</div>
              <div class="price-card__divider"></div>
              <p style="font-size:13px">Бот: <b>${esc(state.settings.botName)}</b><br>Посты идут в <b>твой</b> Telegram-канал</p>
              <div class="pay-hint">СБП на номер <b>${esc(state.settings.sbpPhone)}</b><br>Банк получателя: <b>${esc(state.settings.receivingBank)}</b></div>
              ${renderBankApps()}
              <button class="btn btn--pink btn--block" type="button" data-action="open-pay">Перевести ${esc(price)} по СБП</button>
              <div class="mini-note">После перевода отправь заявку — админ подключит бота к каналу</div>
            </div>
          </div>
        </section>
      </main>
      ${renderFooter()}
    </div>`;
}

/* ---------- admin view ---------- */
function renderLogin() {
  return `
    <div class="app-shell">
      ${renderNav(true)}
      <div class="container auth-wrap">
        <div class="card auth-card">
          <div class="auth-card__icon">🔐</div>
          <h1>Вход в админку</h1>
          <p>Управляй стримерами, заявками на оплату и ботом ${esc(state.settings.botName)}.</p>
          <form id="loginForm" class="form-grid form-grid--one">
            <div class="field">
              <label for="adminPassword">Пароль админа</label>
              <input class="input" id="adminPassword" name="password" type="password" placeholder="Введи пароль" autocomplete="current-password" required />
            </div>
            <button class="btn btn--primary btn--block" type="submit">Войти</button>
          </form>
        </div>
      </div>
      ${renderFooter()}
    </div>`;
}

function subscriberRow(item) {
  const pending = item.status === 'pending';
  const dot = pending ? 'status-dot--wait' : item.status === 'active' ? 'status-dot--on' : 'status-dot--off';

  return `
    <div class="admin-row">
      <div class="admin-row__main">
        <div class="admin-row__title">
          <span class="status-dot ${dot}"></span>
          ${esc(item.name)}
        </div>
        <div class="admin-row__meta">
          <span>${esc(item.telegram || '—')}</span>
          <span>заявка: ${esc(fmtDate(item.joinedAt, false))}</span>
          ${pending
            ? `<span>перевод: ${item.transaction ? '••' + esc(item.transaction) : 'без номера'}</span>`
            : `<span>оплачено до: ${esc(fmtDate(item.paidUntil, false))}</span>`}
          <span>${item.paymentMethod === 'sbp' ? 'СБП' : '—'}</span>
        </div>
      </div>
      <div class="admin-row__actions">
        <span class="badge ${pending ? 'badge--muted' : 'badge--green'}">${pending ? 'ожидает проверки' : 'активен'}</span>
        ${pending ? `<button class="btn btn--soft btn--sm" type="button" data-action="approve-subscriber" data-id="${esc(item.id)}">Подтвердить</button>` : ''}
        <button class="btn btn--danger btn--sm" type="button" data-action="remove-subscriber" data-id="${esc(item.id)}">Удалить</button>
      </div>
    </div>`;
}

function renderSidebar() {
  const tabs = [
    ['overview', '◈', 'Обзор'],
    ['streamers', '🎤', 'Стримеры'],
    ['subscribers', '💳', 'Оплата'],
    ['settings', '⚙', 'Настройки']
  ];

  return `
    <aside class="card sidebar">
      <div class="sidebar__user">
        <div class="avatar">A</div>
        <div><strong>Админ</strong><span>${esc(state.settings.botName)} · панель</span></div>
      </div>
      <div class="side-nav">
        ${tabs.map(([key, ico, label]) => `
          <button class="side-nav__item ${adminTab === key ? 'is-active' : ''}" type="button" data-action="admin-tab" data-tab="${key}">
            <span class="side-nav__ico">${ico}</span><span>${label}</span>
          </button>`).join('')}
      </div>
      <div class="sidebar__divider"></div>
      <button class="side-nav__item" type="button" data-action="logout"><span class="side-nav__ico">↩</span><span>Выйти</span></button>
    </aside>`;
}

function streamerRow(item) {
  const pending = item.status === 'pending';
  const dot = pending ? 'status-dot--wait' : item.status === 'active' ? 'status-dot--on' : 'status-dot--off';

  return `
    <div class="admin-row">
      <div class="admin-row__main">
        <div class="admin-row__title">
          <span class="status-dot ${dot}"></span>
          ${esc(item.name)}
          <span style="font-size:11px;color:var(--muted)">@${esc(item.twitch || '—')}</span>
        </div>
        <div class="admin-row__meta">
          <span>📢 ${esc(item.chatId || '—')}</span>
          <span>🎮 ${esc(item.game || '—')}</span>
          <span>🔗 ${esc(streamerLink(item))}</span>
          <span>${pending ? 'ожидает оплаты' : 'оплачено до ' + esc(fmtDate(item.paidUntil, false))}</span>
        </div>
      </div>
      <div class="admin-row__actions">
        <span class="badge ${pending ? 'badge--muted' : 'badge--green'}">${pending ? 'новый' : 'активен'}</span>
        <button class="btn btn--ghost btn--sm" type="button" data-action="edit-streamer" data-id="${esc(item.id)}">Изменить</button>
        <button class="btn btn--danger btn--sm" type="button" data-action="delete-streamer" data-id="${esc(item.id)}">Удалить</button>
      </div>
    </div>`;
}

function renderStreamersTab() {
  const sorted = state.streamers.slice().sort((a, b) => new Date(b.joinedAt) - new Date(a.joinedAt));
  const active = sorted.filter((s) => s.status === 'active').length;
  const pending = sorted.filter((s) => s.status === 'pending').length;

  return `
    <div class="admin-head">
      <div><span class="eyebrow">Клиенты</span><h2>Стримеры</h2><p>Бот ${esc(state.settings.botName)} публикует уведомления в их Telegram-каналы.</p></div>
      <button class="btn btn--primary" type="button" data-action="new-streamer">+ Добавить стримера</button>
    </div>
    <div class="admin-head" style="margin-bottom:18px">
      <span class="badge badge--green">${active} активных</span>
      <span class="badge badge--muted">${pending} ожидают подключения</span>
    </div>
    <div class="card admin-panel">
      <div class="panel-head"><h3>Все стримеры · ${sorted.length}</h3></div>
      <div class="admin-list">
        ${sorted.map(streamerRow).join('') || '<div class="empty-box">Стримеров пока нет.</div>'}
      </div>
    </div>`;
}

function renderOverview() {
  const activeSubs = state.subscribers.filter((s) => s.status === 'active').length;
  const pendingSubs = state.subscribers.filter((s) => s.status === 'pending').length;
  const activeStreamers = state.streamers.filter((s) => s.status === 'active').length;
  const pendingStreamers = state.streamers.filter((s) => s.status === 'pending').length;
  const connected = !!(state.settings.workerUrl && state.settings.adminToken);

  return `
    <div class="admin-head">
      <div>
        <span class="eyebrow">Админ-панель</span>
        <h2>Привет, админ 👋</h2>
        <p>Всё под контролем: стримеры, каналы и бот ${esc(state.settings.botName)}.</p>
      </div>
      <button class="btn btn--primary" type="button" data-action="new-streamer">+ Добавить стримера</button>
    </div>

    <div class="stat-grid">
      <div class="card stat-card"><div class="stat-card__label">Стримеры</div><div class="stat-card__value">${activeStreamers}</div><div class="stat-card__hint">активных · ${pendingStreamers} новых</div></div>
      <div class="card stat-card"><div class="stat-card__label">Заявки на оплату</div><div class="stat-card__value">${pendingSubs}</div><div class="stat-card__hint">ожидают проверки</div></div>
      <div class="card stat-card"><div class="stat-card__label">Выручка / мес</div><div class="stat-card__value">${esc(fmtMoney(activeSubs * state.settings.price))}</div><div class="stat-card__hint">${activeSubs} оплат по ${esc(fmtMoney(state.settings.price))}</div></div>
      <div class="card stat-card"><div class="stat-card__label">Бот</div><div class="stat-card__value" style="font-size:21px">${connected ? 'Подключён' : 'Не задан'}</div><div class="stat-card__hint">${connected ? 'готов к работе' : 'укажи URL и токен'}</div></div>
    </div>

    <div class="card admin-panel">
      <div class="panel-head">
        <div><h3>Новые стримеры</h3><p>Проверь перевод и подключи бота к каналу</p></div>
        <button class="link-btn" type="button" data-action="admin-tab" data-tab="streamers">Все стримеры →</button>
      </div>
      <div class="admin-list">
        ${state.streamers.filter((s) => s.status === 'pending').slice(0, 5).map(streamerRow).join('') || '<div class="empty-box">Новых заявок нет</div>'}
      </div>
    </div>

    <div class="card admin-panel">
      <div class="panel-head">
        <div><h3>Последние стримеры</h3><p>Каналы, где работает бот ${esc(state.settings.botName)}</p></div>
        <button class="link-btn" type="button" data-action="admin-tab" data-tab="streamers">Управлять →</button>
      </div>
      <div class="admin-list">
        ${state.streamers.slice().sort((a, b) => new Date(b.joinedAt) - new Date(a.joinedAt)).slice(0, 5).map(streamerRow).join('') || '<div class="empty-box">Стримеров пока нет</div>'}
      </div>
    </div>`;
}

function renderSubscribersTab() {
  const sorted = state.subscribers.slice().sort((a, b) => new Date(b.joinedAt) - new Date(a.joinedAt));
  return `
    <div class="admin-head">
      <div><span class="eyebrow">Деньги</span><h2>Оплата и заявки</h2><p>Переводы по СБП на номер <b>${esc(state.settings.sbpPhone)}</b> · ${esc(fmtMoney(state.settings.price))} в месяц за стримера.</p></div>
      <span class="badge badge--muted">${sorted.filter((s) => s.status === 'pending').length} ожидают · ${sorted.filter((s) => s.status === 'active').length} активных</span>
    </div>
    <div class="card admin-panel">
      <div class="panel-head"><h3>Все подписчики · ${sorted.length}</h3></div>
      <div class="admin-list">
        ${sorted.map(subscriberRow).join('') || '<div class="empty-box">Подписчиков пока нет.</div>'}
      </div>
    </div>`;
}

function renderSettingsTab() {
  const s = state.settings;
  return `
    <div class="admin-head">
      <div><span class="eyebrow">Система</span><h2>Настройки</h2><p>Бот, цена, СБП, пароль и подключение к Worker API.</p></div>
    </div>

    <div class="card admin-panel">
      <div class="panel-head"><h3>Основное</h3><p>Эти данные видны на сайте</p></div>
      <form id="settingsForm" class="form-grid">
        <div class="field">
          <label for="setBotName">Имя бота</label>
          <input class="input" id="setBotName" name="botName" value="${esc(s.botName)}" required />
        </div>
        <div class="field">
          <label for="setPrice">Цена в месяц, ₽</label>
          <input class="input" id="setPrice" name="price" type="number" min="0" step="10" value="${esc(s.price)}" required />
        </div>
        <div class="field field--full">
          <label for="setChannel">Резервный Telegram-чат</label>
          <input class="input" id="setChannel" name="channel" value="${esc(s.channel)}" placeholder="@nainangel" />
          <small>Используется для теста, если у стримера не указан канал</small>
        </div>
      </form>
    </div>

    <div class="card admin-panel">
      <div class="panel-head">
        <div><h3>Оплата по СБП</h3><p>Номер и комментарий, которые увидят подписчики</p></div>
        <span class="badge badge--green">СБП</span>
      </div>
      <form id="paymentSettingsForm" class="form-grid">
        <div class="field field--full">
          <label for="setSbpPhone">Номер телефона для перевода</label>
          <input class="input" id="setSbpPhone" name="sbpPhone" value="${esc(s.sbpPhone)}" required />
          <small>Перевод будет именно на этот номер</small>
        </div>
        <div class="field field--full">
          <label for="setReceivingBank">Банк получателя</label>
          <select class="select" id="setReceivingBank" name="receivingBank">
            ${['Т-Банк', 'Сбербанк', 'Альфа-Банк', 'Озон Банк'].map((bank) => `<option value="${esc(bank)}" ${selected(bank, s.receivingBank)}>${esc(bank)}</option>`).join('')}
          </select>
          <small>Показывается пользователям как банк, на который идёт перевод</small>
        </div>
        <div class="field field--full">
          <label for="setPaymentComment">Комментарий при переводе</label>
          <input class="input" id="setPaymentComment" name="paymentComment" value="${esc(s.paymentComment)}" />
        </div>
        <div class="field field--full">
          <div class="form-actions">
            <button class="btn btn--primary" type="submit">Сохранить оплату</button>
          </div>
        </div>
      </form>
    </div>

    <div class="card admin-panel">
      <div class="panel-head">
        <div><h3>Telegram-уведомления</h3><p>Адрес локального сервера server.ps1 или Cloudflare Worker</p></div>
        <span class="badge ${s.workerUrl && s.adminToken ? 'badge--green' : 'badge--muted'}">${s.workerUrl && s.adminToken ? 'подключено' : 'не настроено'}</span>
      </div>
      <form id="settingsWorkerForm" class="form-grid">
        <div class="field field--full">
          <label for="setWorkerUrl">URL воркера / локального сервера</label>
          <input class="input" id="setWorkerUrl" name="workerUrl" value="${esc(s.workerUrl)}" placeholder="http://localhost:8787" />
          <small>Без завершающего слеша. Для локального режима запусти server.ps1</small>
        </div>
        <div class="field field--full">
          <label for="setAdminToken">ADMIN_TOKEN (секрет из воркера)</label>
          <input class="input" id="setAdminToken" name="adminToken" type="password" value="${esc(s.adminToken)}" placeholder="Секретная строка" />
        </div>
        <div class="field field--full">
          <div class="form-actions">
            <button class="btn btn--ghost" type="button" data-action="test-telegram">Тестовое сообщение</button>
            <button class="btn btn--primary" type="submit">Сохранить всё</button>
          </div>
        </div>
      </form>
    </div>

    <div class="card admin-panel">
      <div class="panel-head"><h3>Данные</h3><p>Бэкап и восстановление состояния сайта</p></div>
      <div class="form-actions" style="justify-content:flex-start">
        <button class="btn btn--ghost" type="button" data-action="export-data">Скачать бэкап</button>
        <button class="btn btn--ghost" type="button" data-action="import-data">Загрузить бэкап</button>
        <button class="btn btn--danger" type="button" data-action="reset-demo">Сбросить демо</button>
        <input type="file" id="importFile" accept="application/json,.json" class="hidden" />
      </div>
    </div>`;
}

function renderAdmin() {
  const content = {
    overview: renderOverview,
    streamers: renderStreamersTab,
    subscribers: renderSubscribersTab,
    settings: renderSettingsTab
  }[adminTab] || renderOverview;

  return `
    <div class="app-shell">
      ${renderNav(true)}
      <div class="container admin-layout">
        ${renderSidebar()}
        <main class="admin-main">${content()}</main>
      </div>
      ${renderFooter()}
    </div>`;
}

/* ---------- render ---------- */
function renderApp() {
  const app = document.getElementById('app');
  app.innerHTML = currentView === 'admin'
    ? (isAuthed() ? renderAdmin() : renderLogin())
    : renderPublic();
}

/* ---------- modal forms ---------- */
function modalError(id, message) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = message;
    el.classList.remove('hidden');
  }
}

function openLoginModal(after) {
  openModal({
    title: 'Вход в emre',
    subtitle: 'Сначала авторизация — потом оплата',
    submitText: 'Войти',
    body: `
      <div class="field">
        <label for="authLogin">Telegram-логин</label>
        <input class="input" id="authLogin" name="username" placeholder="@nainangel" autocomplete="username" required />
        <small>Введи логин, который уже есть в системе.</small>
      </div>
      <p id="authError" class="form-error hidden"></p>
      <p id="aiLogin" class="ai-check">🤖 ИИ-проверка включена</p>
      <button class="link-btn" type="button" data-action="open-register">Нет аккаунта? Создать</button>`,
    onSubmit: async (formData) => {
      const raw = String(formData.get('username') || '').trim();
      const account = validUser(raw) ? findAccount(normUser(raw)) : null;
      if (!account) {
        modalError('authError', 'Такого аккаунта не существует');
        return;
      }
      const ai = await aiFormCheck('login', { username: raw }, 'aiLogin');
      if (ai && !ai.ok) {
        modalError('authError', ai.issues.join('; '));
        return;
      }
      loginUser(account.username);
      closeModal();
      renderApp();
      toast(`Вы вошли как ${normUser(account.username)}`);
      if (after === 'pay') openPayModal();
    }
  });
}

function openRegisterModal() {
  openModal({
    title: 'Создать аккаунт',
    subtitle: 'Привяжи Telegram-логин и канал для постов',
    submitText: 'Создать и войти',
    body: `
      <div class="field">
        <label for="regLogin">Telegram-логин</label>
        <input class="input" id="regLogin" name="username" placeholder="@nainangel" required />
      </div>
      <div class="field">
        <label for="regName">Имя стримера</label>
        <input class="input" id="regName" name="name" placeholder="Nainangel" required />
      </div>
      <div class="field">
        <label for="regChannel">Telegram-канал для постов</label>
        <input class="input" id="regChannel" name="channel" placeholder="@nainangel" required />
      </div>
      <p id="regError" class="form-error hidden"></p>
      <p id="aiReg" class="ai-check">🤖 ИИ-проверка включена</p>`,
    onSubmit: async (formData) => {
      const raw = String(formData.get('username') || '').trim();
      if (!validUser(raw)) {
        modalError('regError', 'Неверный Telegram-логин');
        return;
      }
      const username = normUser(raw);
      if (findAccount(username)) {
        modalError('regError', 'Такой аккаунт уже существует — просто войди');
        return;
      }
      const channelRaw = String(formData.get('channel') || '').trim();
      if (!validUser(channelRaw)) {
        modalError('regError', 'Неверный Telegram-канал');
        return;
      }
      const name = String(formData.get('name') || '').trim() || username.slice(1);
      const ai = await aiFormCheck('register', { username: raw, name, channel: channelRaw }, 'aiReg');
      if (ai && !ai.ok) {
        modalError('regError', ai.issues.join('; '));
        return;
      }
      state.accounts.unshift({
        id: uid(),
        username,
        name,
        channel: normUser(channelRaw),
        createdAt: new Date().toISOString()
      });
      saveState();
      loginUser(username);
      closeModal();
      renderApp();
      toast(`Аккаунт ${username} создан`);
    }
  });
}

function paymentAiData(account) {
  const name = String(account.name || '').trim() || currentUser.replace(/^@/, '');
  const channel = String(account.channel || account.username || currentUser).trim();
  const twitch = String(account.twitch || name)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 32);
  return {
    name,
    twitch,
    channel,
    link: twitch ? `https://www.twitch.tv/${twitch}` : '',
    price: state.settings.price,
    sbpPhone: state.settings.sbpPhone
  };
}

function openPayModal() {
  const account = currentUser ? findAccount(currentUser) : null;
  // Сначала авторизация, потом оплата: без аккаунта платёжную форму не показываем.
  if (!currentUser || !account) {
    openLoginModal('pay');
    return;
  }
  const price = fmtMoney(state.settings.price);
  const aiData = paymentAiData(account);

  openModal({
    title: 'Оплата подписки по СБП',
    subtitle: `${price} в месяц · СБП на ${state.settings.sbpPhone} · ${state.settings.receivingBank}`,
    submitText: 'Я перевёл(а) — отправить на проверку',
    body: `
      <div class="pay-user">
        <span class="badge badge--green">АККАУНТ ПРОВЕРЕН</span>
        <span>@${esc(account.username.replace(/^@/, ''))}</span>
      </div>
      <p id="payError" class="form-error hidden"></p>
      <p id="aiPay" class="ai-check">🤖 ИИ-проверка включена</p>
      <div class="pay-box">
        <div class="pay-box__row"><span>Банк получателя</span><strong>${esc(state.settings.receivingBank)}</strong></div>
        <div class="pay-box__row"><span>Номер для перевода</span><strong>${esc(state.settings.sbpPhone)}</strong></div>
        <div class="pay-box__row"><span>Сумма</span><strong>${esc(price)}</strong></div>
        <div class="pay-box__row"><span>Комментарий</span><strong>${esc(state.settings.paymentComment)}</strong></div>
        <button type="button" class="btn btn--ghost btn--sm" data-action="copy-sbp">Скопировать данные</button>
      </div>
      ${renderBankApps()}
      <ol class="pay-steps">
        <li>Открой приложение банка → <b>СБП → Перевести по номеру телефона</b>.</li>
        <li>Выбери банк получателя <b>${esc(state.settings.receivingBank)}</b> (если банк спросит).</li>
        <li>Введи номер <b>${esc(state.settings.sbpPhone)}</b> и сумму <b>${esc(price)}</b>.</li>
        <li>Добавь комментарий <b>${esc(state.settings.paymentComment)}</b> и подтверди перевод.</li>
        <li>Проверь данные ниже и нажми кнопку — админ подтвердит перевод и включит подписку.</li>
      </ol>
      <div class="field">
        <label for="payName">Имя стримера</label>
        <input class="input" id="payName" name="name" value="${esc(aiData.name)}" placeholder="Nainangel" required />
      </div>
      <div class="form-grid">
        <div class="field">
          <label for="payTwitch">Twitch-логин</label>
          <input class="input" id="payTwitch" name="twitch" value="${esc(aiData.twitch)}" placeholder="nainangel" required />
        </div>
        <div class="field">
          <label for="payChannel">Telegram-канал для постов</label>
          <input class="input" id="payChannel" name="channel" value="${esc(aiData.channel)}" placeholder="@nainangel" required />
        </div>
      </div>
      <div class="field">
        <label for="payLink">Ссылка на Twitch (необязательно)</label>
        <input class="input" id="payLink" name="link" value="${esc(aiData.link)}" placeholder="https://www.twitch.tv/nainangel" />
      </div>
      <div class="field">
        <label for="payTx">Последние 4 цифры перевода (если есть)</label>
        <input class="input" id="payTx" name="transaction" placeholder="Например, 4821" />
      </div>
      <label class="checkbox-row">
        <input type="checkbox" name="agree" required />
        <span>Я перевёл(а) ${esc(price)} по СБП<small>Подписка станет активной после подтверждения админом</small></span>
      </label>`,
    onSubmit: async (formData) => {
      // Автоматическая проверялка перед отправкой заявки на оплату.
      if (!findAccount(currentUser)) {
        modalError('payError', 'Такого аккаунта не существует');
        return;
      }
      // Поля возвращены: значения подставлены из аккаунта, но пользователь может их изменить.
      const name = String(formData.get('name') || '').trim() || aiData.name;
      const channel = String(formData.get('channel') || '').trim();
      const twitch = String(formData.get('twitch') || '').trim().replace(/^@/, '');
      const link = String(formData.get('link') || '').trim() || (twitch ? `https://www.twitch.tv/${twitch}` : '');
      const transaction = String(formData.get('transaction') || '').trim();
      if (!/^[A-Za-z0-9_]{4,32}$/.test(twitch)) {
        modalError('payError', 'Неверный Twitch-логин — проверь написание');
        return;
      }
      if (!validUser(channel)) {
        modalError('payError', 'Такого Telegram-канала не существует');
        return;
      }
      const ai = await aiFormCheck('payment', { name, twitch, channel, link, price: state.settings.price, sbpPhone: state.settings.sbpPhone }, 'aiPay');
      if (ai && !ai.ok) {
        modalError('payError', ai.issues.join('; '));
        return;
      }
      const joinedAt = new Date().toISOString();
      const streamerId = uid();

      state.streamers.unshift({
        id: streamerId,
        name,
        twitch,
        chatId: channel,
        game: 'Fortnite',
        title: 'Стрим',
        link,
        status: 'pending',
        joinedAt,
        paidUntil: null
      });
      state.subscribers.unshift({
        id: uid(),
        streamerId,
        name,
        telegram: channel,
        status: 'pending',
        joinedAt,
        paidUntil: null,
        transaction,
        paymentMethod: 'sbp'
      });
      saveState();
      closeModal();
      renderApp();
      toast(`Заявка для ${name} отправлена. После проверки перевода бот подключится к ${channel}.`);
    }
  });
  // ИИ проверяет данные сразу при открытии окна оплаты — до нажатия кнопки.
  aiFormCheck('payment', aiData, 'aiPay');
}

function openStreamerModal(item = null) {
  const s = item || {
    name: '', twitch: '', chatId: '', game: 'Fortnite', title: 'Стрим',
    link: '', status: 'active', paidUntil: new Date(Date.now() + 30 * DAY).toISOString()
  };

  openModal({
    title: item ? 'Редактировать стримера' : 'Новый стример',
    subtitle: 'Эти данные уходят в Telegram-пост',
    submitText: item ? 'Сохранить' : 'Добавить стримера',
    body: `
      <input type="hidden" name="id" value="${esc(item ? item.id : '')}" />
      <div class="form-grid">
        <div class="field">
          <label for="stName">Имя стримера</label>
          <input class="input" id="stName" name="name" value="${esc(s.name)}" placeholder="Nainangel" required />
        </div>
        <div class="field">
          <label for="stTwitch">Twitch-логин</label>
          <input class="input" id="stTwitch" name="twitch" value="${esc(s.twitch)}" placeholder="nainangel" required />
        </div>
      </div>
      <div class="field">
        <label for="stChat">Telegram-канал для постов</label>
        <input class="input" id="stChat" name="chatId" value="${esc(s.chatId)}" placeholder="@nainangel" required />
        <small>Бот ${esc(state.settings.botName)} должен быть администратором в этом канале</small>
      </div>
      <div class="form-grid">
        <div class="field">
          <label for="stGame">Игра</label>
          <input class="input" id="stGame" name="game" value="${esc(s.game)}" placeholder="Fortnite" />
        </div>
        <div class="field">
          <label for="stTitle">Тема эфира (📝)</label>
          <input class="input" id="stTitle" name="title" value="${esc(s.title)}" placeholder="Какая-то игра с сундуками" />
        </div>
      </div>
      <div class="field">
        <label for="stLink">Ссылка на стрим</label>
        <input class="input" id="stLink" name="link" value="${esc(s.link)}" placeholder="https://www.twitch.tv/nainangel" />
      </div>
      <div class="form-grid">
        <div class="field">
          <label for="stStatus">Статус</label>
          <select class="select" id="stStatus" name="status">
            <option value="active" ${selected('active', s.status)}>Активен</option>
            <option value="pending" ${selected('pending', s.status)}>Ожидает оплаты</option>
          </select>
        </div>
        <div class="field">
          <label for="stPaid">Оплачено до</label>
          <input class="input" id="stPaid" name="paidUntil" type="date" value="${esc(toLocalInput(s.paidUntil).slice(0, 10))}" />
        </div>
      </div>
      <p id="aiStreamer" class="ai-check">🤖 ИИ-проверка включена</p>`,
    onSubmit: async (formData) => {
      const data = formData;
      const id = String(data.get('id') || '').trim();
      const twitch = String(data.get('twitch') || '').trim().replace(/^@/, '');
      const payload = {
        name: String(data.get('name') || '').trim() || 'Стример',
        twitch,
        chatId: String(data.get('chatId') || '').trim(),
        game: String(data.get('game') || '').trim(),
        title: String(data.get('title') || '').trim(),
        link: String(data.get('link') || '').trim() || (twitch ? `https://www.twitch.tv/${twitch}` : ''),
        status: String(data.get('status') || 'active'),
        paidUntil: data.get('paidUntil') ? new Date(`${data.get('paidUntil')}T23:59:59`).toISOString() : null,
        joinedAt: item ? item.joinedAt : new Date().toISOString()
      };

      const ai = await aiFormCheck('streamer', { name: payload.name, twitch: payload.twitch, chatId: payload.chatId, link: payload.link, status: payload.status }, 'aiStreamer');
      if (ai && !ai.ok) {
        toast('ИИ-проверка: ' + ai.issues.join('; '), 'err');
        return;
      }

      if (id) {
        const index = state.streamers.findIndex((entry) => entry.id === id);
        if (index >= 0) state.streamers[index] = { ...state.streamers[index], ...payload };
      } else {
        state.streamers.unshift({ id: uid(), ...payload });
      }

      saveState();
      closeModal();
      renderApp();
      toast(id ? 'Стример обновлён' : 'Стример добавлен');
    }
  });
}

/* ---------- telegram api ---------- */
async function publishToTelegram(item) {
  const { workerUrl, adminToken } = state.settings;
  if (!workerUrl || !adminToken) {
    toast('Укажи URL воркера и ADMIN_TOKEN в настройках', 'err');
    return false;
  }

  const streamer = getStreamer(item.streamerId);
  const chatId = String(streamer?.chatId || state.settings.channel || '').trim();
  if (!chatId) {
    toast('У стримера не указан Telegram-канал', 'err');
    return false;
  }

  try {
    const endpoint = `${workerUrl.replace(/\/$/, '')}/announce?token=${encodeURIComponent(adminToken)}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        channel: chatId,
        name: streamer?.name || '',
        title: item.title,
        game: item.game || streamer?.game || '',
        description: item.description,
        date: item.date,
        link: item.link || streamerLink(streamer),
        kind: item.kind
      })
    });
    const body = await response.text();
    if (!response.ok) throw new Error(body || `HTTP ${response.status}`);

    toast(`Сообщение отправлено в ${chatId} 💜`);
    return true;
  } catch (error) {
    toast('Ошибка отправки: ' + error.message, 'err');
    return false;
  }
}

/* ---------- data utils ---------- */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `emre-streams-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast('Бэкап скачан');
}

/* ---------- events ---------- */
document.addEventListener('click', async (event) => {
  const scrollTarget = event.target.closest('[data-scroll]');
  if (scrollTarget) {
    const node = document.getElementById(scrollTarget.dataset.scroll);
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  if (event.target.classList.contains('modal-backdrop')) {
    closeModal();
    return;
  }

  const el = event.target.closest('[data-action]');
  if (!el) return;

  const action = el.dataset.action;
  const id = el.dataset.id;

  switch (action) {
    case 'go-admin':
      location.hash = '#admin';
      break;

    case 'go-public':
      location.hash = '#home';
      break;

    case 'open-login':
      openLoginModal();
      break;

    case 'open-register':
      openRegisterModal();
      break;

    case 'logout-user':
      logoutUser();
      renderApp();
      toast('Вы вышли из аккаунта');
      break;

    case 'open-pay':
      openPayModal();
      break;

    case 'copy-sbp': {
      const details = `Банк получателя: ${state.settings.receivingBank}\nНомер СБП: ${state.settings.sbpPhone}\nСумма: ${fmtMoney(state.settings.price)}\nКомментарий: ${state.settings.paymentComment}`;
      const ok = await copyText(details);
      toast(ok ? 'Данные для перевода скопированы' : 'Не удалось скопировать — выдели данные вручную', ok ? 'ok' : 'err');
      break;
    }

    case 'telegram-remind': {
      const bot = String(state.settings.botName || '').replace(/^@/, '');
      window.open(`https://t.me/${bot}`, '_blank', 'noopener,noreferrer');
      break;
    }

    case 'close-modal':
      closeModal();
      break;

    case 'admin-tab':
      adminTab = el.dataset.tab || 'overview';
      renderApp();
      break;

    case 'logout':
      sessionStorage.removeItem(AUTH_KEY);
      renderApp();
      toast('Ты вышел из админки');
      break;

    case 'new-streamer':
      openStreamerModal();
      break;

    case 'edit-streamer': {
      const streamer = getStreamer(id);
      if (streamer) openStreamerModal(streamer);
      break;
    }

    case 'delete-streamer':
      if (confirm('Удалить стримера и его заявку на оплату?')) {
        state.streamers = state.streamers.filter((s) => s.id !== id);
        state.subscribers = state.subscribers.filter((s) => s.streamerId !== id);
        saveState();
        renderApp();
        toast('Стример удалён');
      }
      break;

    case 'approve-subscriber': {
      const sub = state.subscribers.find((s) => s.id === id);
      if (sub) {
        const paidUntil = new Date(Date.now() + 30 * DAY).toISOString();
        sub.status = 'active';
        sub.paidUntil = paidUntil;
        const streamer = getStreamer(sub.streamerId);
        if (streamer) {
          streamer.status = 'active';
          streamer.paidUntil = paidUntil;
        }
        saveState();
        renderApp();
        toast(`Подписка ${sub.name} подтверждена · бот → ${streamer?.chatId || 'канал'}`);
      }
      break;
    }

    case 'remove-subscriber':
      if (confirm('Удалить подписчика и отключить бота от его канала?')) {
        const sub = state.subscribers.find((s) => s.id === id);
        const streamerId = sub?.streamerId;
        state.subscribers = state.subscribers.filter((s) => s.id !== id);
        if (streamerId) {
          state.streamers = state.streamers.filter((s) => s.id !== streamerId);
        }
        saveState();
        renderApp();
        toast('Подписчик удалён, бот отключён');
      }
      break;

    case 'test-telegram': {
      await publishToTelegram({
        streamerId: '',
        title: `Тест уведомлений · ${state.settings.botName}`,
        game: 'Проверка связи',
        description: 'Если видишь это сообщение — бот подключён правильно.',
        date: new Date().toISOString(),
        link: '',
        kind: 'start'
      });
      break;
    }

    case 'export-data':
      exportData();
      break;

    case 'import-data':
      document.getElementById('importFile')?.click();
      break;

    case 'reset-demo':
      if (confirm('Сбросить все данные к демо-состоянию?')) {
        localStorage.removeItem(STORAGE_KEY);
        state = makeDefaultState();
        saveState();
        renderApp();
        toast('Демо-данные восстановлены');
      }
      break;
  }
});

document.addEventListener('submit', async (event) => {
  const form = event.target;

  if (form.id === 'loginForm') {
    event.preventDefault();
    const password = String(new FormData(form).get('password') || '');
    if (password === CURRENT_ADMIN_PASSWORD) {
      sessionStorage.setItem(AUTH_KEY, '1');
      adminTab = 'overview';
      renderApp();
      toast('Добро пожаловать в админку');
    } else {
      toast('Неверный пароль', 'err');
    }
    return;
  }

  if (form.id === 'settingsForm') {
    event.preventDefault();
    const data = new FormData(form);
    state.settings = {
      ...state.settings,
      botName: String(data.get('botName') || '').trim() || 'emre',
      price: Math.max(0, Number(data.get('price')) || 0),
      channel: String(data.get('channel') || '').trim()
    };
    saveState();
    renderApp();
    toast('Основные настройки сохранены');
    return;
  }

  if (form.id === 'paymentSettingsForm') {
    event.preventDefault();
    const data = new FormData(form);
    state.settings = {
      ...state.settings,
      sbpPhone: String(data.get('sbpPhone') || '').trim() || state.settings.sbpPhone,
      receivingBank: String(data.get('receivingBank') || '').trim() || state.settings.receivingBank,
      paymentComment: String(data.get('paymentComment') || '').trim() || state.settings.paymentComment
    };
    saveState();
    renderApp();
    toast('Настройки СБП сохранены');
    return;
  }

  if (form.id === 'settingsWorkerForm') {
    event.preventDefault();
    const data = new FormData(form);
    state.settings = {
      ...state.settings,
      workerUrl: String(data.get('workerUrl') || '').trim().replace(/\/$/, ''),
      adminToken: String(data.get('adminToken') || '').trim()
    };
    saveState();
    renderApp();
    toast('Настройки бота сохранены');
    return;
  }

  if (form.id === 'modalForm' && modalSubmit) {
    event.preventDefault();
    const submitButton = form.querySelector('button[type="submit"]');
    if (submitButton) submitButton.disabled = true;
    try {
      await modalSubmit(new FormData(form), form);
    } catch (error) {
      toast('Ошибка: ' + error.message, 'err');
    } finally {
      if (submitButton && submitButton.isConnected) submitButton.disabled = false;
    }
  }
});

document.addEventListener('change', async (event) => {
  if (event.target.id !== 'importFile') return;
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    state = mergeState(parsed);
    saveState();
    renderApp();
    toast('Бэкап загружен');
  } catch (error) {
    toast('Не удалось прочитать бэкап: ' + error.message, 'err');
  } finally {
    event.target.value = '';
  }
});

window.addEventListener('hashchange', () => {
  currentView = location.hash === '#admin' ? 'admin' : 'public';
  renderApp();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

async function bootstrap() {
  let hasRemote = false;
  if (location.protocol === 'http:') {
    try {
      const response = await fetch('/api/state', { cache: 'no-store' });
      if (response.ok) {
        const remote = await response.json();
        if (remote && Array.isArray(remote.streamers)) {
          state = mergeState(remote);
          hasRemote = true;
        }
      }
    } catch { /* сервер недоступен — работаем из localStorage */ }
  }
  renderApp();
  // Первый запуск: сохраняем состояние на сервере, чтобы мониторинг видел стримеров.
  if (location.protocol === 'http:' && !hasRemote) saveState();
  aiAuditState();
}

bootstrap();
