/**
 * Емеран — Telegram AI-агент + Mini App на одном Cloudflare Worker.
 *
 * Маршруты:
 *   GET  /health   — проверка состояния
 *   GET  /app      — Mini App (HTML)
 *   GET  /setup?token=SETUP_TOKEN — привязка webhook, команд и кнопки меню
 *   POST /webhook  — обновления Telegram
 *   POST /api/chat — чат из Mini App (проверка initData)
 */

const enc = new TextEncoder();

// Публичный сайт opens as Mini App; бот доступен всем пользователям Telegram.
const SITE_URL = 'https://dimae9044-oss.github.io/emre-site/';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*'
    }
  });

const text = (body, status = 200, type = 'text/plain; charset=utf-8') =>
  new Response(body, { status, headers: { 'content-type': type } });

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

const clip = (s, n = 2000) => String(s ?? '').slice(0, n);

async function fetchJSON(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout?.(15000) ?? undefined
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + url);
  return r.json();
}

/* ------------------------------------------------------------------ */
/* Telegram                                                            */
/* ------------------------------------------------------------------ */

async function tg(env, method, payload = {}) {
  const r = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await r.json().catch(() => ({ ok: false, description: 'bad json' }));
  if (!data.ok) console.error('Telegram ' + method + ':', data.description);
  return data;
}

/* ------------------------------------------------------------------ */
/* LLM (OpenAI-совместимый endpoint, по умолчанию Pollinations — без ключа) */
/* ------------------------------------------------------------------ */

async function llm(env, messages, options = {}) {
  const base = env.LLM_BASE_URL || 'https://text.pollinations.ai/openai';
  const headers = { 'content-type': 'application/json' };
  if (env.LLM_API_KEY) headers.authorization = 'Bearer ' + env.LLM_API_KEY;
  const body = {
    model: env.LLM_MODEL || 'openai',
    messages,
    stream: false,
    temperature: options.temperature ?? 0.3,
    max_tokens: options.max_tokens ?? 500
  };
  const r = await fetch(base, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('LLM HTTP ' + r.status);
  const d = await r.json();
  const content = d?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Пустой ответ модели');
  return String(content).trim();
}

function extractJson(s) {
  const start = String(s).indexOf('{');
  if (start < 0) return null;
  const end = String(s).lastIndexOf('}');
  if (end <= start) return null;
  try {
    return JSON.parse(String(s).slice(start, end + 1));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Инструменты агента                                                  */
/* ------------------------------------------------------------------ */

const memory = new Map(); // fallback, если KV не подключён

async function storeGet(env, key) {
  if (env.AGENT_KV) return env.AGENT_KV.get(key);
  return memory.get(key) ?? null;
}
async function storeSet(env, key, value) {
  if (env.AGENT_KV) await env.AGENT_KV.put(key, value);
  else memory.set(key, value);
}

const WEATHER_CODES = {
  0: 'ясно', 1: 'преимущественно ясно', 2: 'переменная облачность', 3: 'пасмурно',
  45: 'туман', 48: 'иней', 51: 'лёгкая морось', 53: 'морось', 55: 'сильная морось',
  61: 'небольшой дождь', 63: 'дождь', 65: 'сильный дождь', 71: 'небольшой снег',
  73: 'снег', 75: 'сильный снег', 80: 'ливень', 81: 'ливень', 82: 'сильный ливень',
  95: 'гроза', 96: 'гроза с градом', 99: 'сильная гроза с градом'
};

async function toolWeather(args) {
  const city = String(args.city || 'Москва').trim().slice(0, 80);
  const g = await fetchJSON(
    'https://geocoding-api.open-meteo.com/v1/search?name=' +
    encodeURIComponent(city) + '&count=1&language=ru&format=json'
  );
  const place = g?.results?.[0];
  if (!place) return { text: 'Не нашёл город «' + city + '». Попробуйте другое название.' };
  const w = await fetchJSON(
    'https://api.open-meteo.com/v1/forecast?latitude=' + place.latitude +
    '&longitude=' + place.longitude +
    '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&timezone=auto'
  );
  const c = w.current || {};
  const desc = WEATHER_CODES[c.weather_code] || 'погода';
  return {
    text: '🌤 Погода в ' + place.name + ': ' + c.temperature_2m + '°C, ' + desc +
      ', ветер ' + c.wind_speed_10m + ' м/с, влажность ' + c.relative_humidity_2m + '%.',
    card: { kind: 'weather', city: place.name, temp: c.temperature_2m, desc }
  };
}

function toolTime(args) {
  const tz = String(args.timezone || 'Europe/Moscow').slice(0, 60);
  try {
    const s = new Intl.DateTimeFormat('ru-RU', {
      timeZone: tz, dateStyle: 'full', timeStyle: 'medium'
    }).format(new Date());
    return { text: '🕒 ' + s + ' (' + tz + ')' };
  } catch {
    return { text: '🕒 ' + new Date().toUTCString() + ' (UTC)' };
  }
}

function calculate(exprRaw) {
  let s = String(exprRaw || '')
    .replace(/,/g, '.')
    .replace(/(\d+(?:\.\d+)?)%\s*от\s*(\d+(?:\.\d+)?)/gi, '$2*$1/100')
    .replace(/\s+/g, '');
  let i = 0;
  const peek = () => s[i] || '';

  function primary() {
    if (peek() === '(') {
      i++;
      const v = expression();
      if (peek() !== ')') throw new Error('Незакрытая скобка');
      i++;
      return v;
    }
    const m = s.slice(i).match(/^(?:\d+\.?\d*|\.\d+)/);
    if (!m) throw new Error('Некорректное выражение');
    i += m[0].length;
    return parseFloat(m[0]);
  }
  function unary() {
    if (peek() === '+' || peek() === '-') {
      const op = s[i++];
      const v = unary();
      return op === '-' ? -v : v;
    }
    return primary();
  }
  function power() {
    const v = unary();
    if (peek() === '^') { i++; return Math.pow(v, power()); }
    return v;
  }
  function term() {
    let v = power();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = s[i++];
      const r = power();
      if ((op === '/' || op === '%') && r === 0) throw new Error('Деление на ноль');
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  function expression() {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = s[i++];
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }

  const out = expression();
  if (i !== s.length) throw new Error('Лишние символы в выражении');
  if (!Number.isFinite(out)) throw new Error('Слишком большое число');
  return Math.round(out * 10000) / 10000;
}

function toolCalc(args) {
  const expr = String(args.expression || args.expr || '').slice(0, 200);
  try {
    return { text: '🧮 ' + expr + ' = ' + calculate(expr) };
  } catch (e) {
    return { text: 'Не смог посчитать: ' + e.message + '. Пример: 8400*0.15 или 15% от 8400.' };
  }
}

async function toolSearch(args) {
  const q = String(args.query || '').trim().slice(0, 120);
  if (!q) return { text: 'Укажите, что искать.' };
  const d = await fetchJSON(
    'https://ru.wikipedia.org/w/api.php?action=query&list=search&srsearch=' +
    encodeURIComponent(q) + '&format=json&srlimit=2'
  );
  const items = d?.query?.search || [];
  if (!items.length) return { text: 'По запросу «' + q + '» ничего не нашёл.' };
  const lines = items.map((x) => '• ' + x.title + ': ' +
    String(x.snippet).replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').slice(0, 220));
  return { text: '🔎 ' + lines.join('\n') };
}

function toolImage(args) {
  const prompt = String(args.prompt || '').trim().slice(0, 300) || 'abstract neon art';
  const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt) +
    '?width=768&height=768&seed=' + Math.floor(Math.random() * 99999) + '&nologo=true';
  return { text: '🎨 Картинка готова: ' + url, image: url };
}

async function toolNoteSave(env, userId, args) {
  const key = 'notes:' + userId;
  const notes = JSON.parse((await storeGet(env, key)) || '[]');
  const item = { id: notes.length + 1, text: String(args.text || '').slice(0, 600), at: new Date().toISOString() };
  notes.push(item);
  await storeSet(env, key, JSON.stringify(notes.slice(-30)));
  return { text: '📝 Запомнил: «' + item.text + '» (№' + item.id + ')' };
}

async function toolNoteList(env, userId) {
  const notes = JSON.parse((await storeGet(env, 'notes:' + userId)) || '[]');
  if (!notes.length) return { text: 'Пока нет заметок. Напишите: запомни …' };
  return { text: '📓 Ваши заметки:\n' + notes.map((n) => n.id + '. ' + n.text).join('\n') };
}

async function toolNoteDelete(env, userId, args) {
  const key = 'notes:' + userId;
  const notes = JSON.parse((await storeGet(env, key)) || '[]');
  const id = Number(args.id || notes.length);
  const before = notes.length;
  const next = notes.filter((n) => n.id !== id);
  await storeSet(env, key, JSON.stringify(next));
  return { text: next.length < before ? '🗑 Удалил заметку №' + id : 'Заметка №' + id + ' не найдена.' };
}

const TOOL_NAMES = 'weather, time, calc, search, image, note_save, note_list, note_delete';

async function runTool(env, userId, name, args) {
  switch (name) {
    case 'weather': return toolWeather(args);
    case 'time': return toolTime(args);
    case 'calc': return toolCalc(args);
    case 'search': return toolSearch(args);
    case 'image': return toolImage(args);
    case 'note_save': return toolNoteSave(env, userId, args);
    case 'note_list': return toolNoteList(env, userId);
    case 'note_delete': return toolNoteDelete(env, userId, args);
    default: return { text: 'Неизвестный инструмент: ' + name };
  }
}

/* ------------------------------------------------------------------ */
/* Агент                                                               */
/* ------------------------------------------------------------------ */

const PLANNER = [
  'Ты маршрутизатор инструментов AI-агента «Емеран». Верни ТОЛЬКО валидный JSON без пояснений и без markdown.',
  'Формат: {"tool":"имя|null","args":{},"answer":"текст"}',
  'Если нужен инструмент: tool — одно из ' + TOOL_NAMES + ', args — объект с параметрами, answer — пустая строка.',
  'Если инструмент не нужен: tool — null, args — {}, answer — готовый ответ пользователю на русском.',
  'Инструменты и параметры:',
  '- weather: {"city":"Москва"} — актуальная погода',
  '- time: {"timezone":"Europe/Moscow"} — текущее время',
  '- calc: {"expression":"8400*0.15"} — арифметика; проценты пиши как "15% от 8400"',
  '- search: {"query":"..."} — поиск кратких фактов в Википедии',
  '- image: {"prompt":"..."} — генерация картинки',
  '- note_save: {"text":"..."} — запомнить информацию о пользователе',
  '- note_list: {} — показать заметки',
  '- note_delete: {"id":1} — удалить заметку по номеру',
  'Отвечай на русском. Будь кратким. Если пользователь просто поздоровался или спросил «что умеешь» — отвечай сам, без инструментов.'
].join('\n');

const FINALIZER = [
  'Ты AI-агент «Емеран» в Telegram. Ответь пользователю на русском кратко, дружелюбно и естественно.',
  'Используй результат инструмента как источник фактов. Не выдумывай лишнего.',
  'Не говори «инструмент вернул» — просто дай ответ. Можно использовать 1-2 эмодзи.'
].join('\n');

async function runAgent(env, userId, message, history = []) {
  const cleanHistory = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .slice(-6)
    .map((m) => ({ role: m.role, content: clip(m.content, 1500) }));

  try {
    const planRaw = await llm(env, [
      { role: 'system', content: PLANNER },
      ...cleanHistory,
      { role: 'user', content: clip(message, 2000) }
    ], { temperature: 0.1, max_tokens: 400 });

    const plan = extractJson(planRaw);
    if (!plan) return { text: planRaw || 'Извините, не смог ответить.' };

    const name = plan.tool && TOOL_NAMES.includes(plan.tool) ? plan.tool : null;
    if (!name) {
      return { text: String(plan.answer || planRaw).trim() || 'Извините, не смог ответить.' };
    }

    const result = await runTool(env, userId, name, plan.args || {});
    let answer = result.text;
    try {
      answer = await llm(env, [
        { role: 'system', content: FINALIZER },
        ...cleanHistory.slice(-2),
        { role: 'user', content: 'Вопрос пользователя: ' + clip(message, 1200) },
        { role: 'user', content: 'Результат (' + name + '): ' + clip(result.text, 1500) }
      ], { temperature: 0.4, max_tokens: 350 });
    } catch (e) {
      console.error('finalizer:', e.message);
    }
    return { text: answer || result.text, image: result.image, card: result.card };
  } catch (e) {
    console.error('agent:', e.message);
    return fallback(env, userId, message);
  }
}

async function fallback(env, userId, message) {
  const m = String(message).toLowerCase();
  try {
    if (/погод|температур|градус/.test(m)) return toolWeather({ city: /в\s+([\p{L}\-]+)/u.exec(m)?.[1] || 'Москва' });
    if (/время|который час/.test(m)) return toolTime({});
    if (/заметк|напомни|запомни/.test(m)) {
      if (/показ|список|мои/.test(m)) return toolNoteList(env, userId);
      return toolNoteSave(env, userId, { text: message.replace(/^(запомни|напомни)\s*/i, '') });
    }
    if (/[+\-*/^()]|\d/.test(m) && /посчита| calc|сколько|\*|\//.test(m)) return toolCalc({ expression: message });
  } catch (e) {
    return { text: 'Сервис временно недоступен: ' + e.message };
  }
  return {
    text: 'Привет! Я Емеран — AI-агент. Сейчас модель недоступна, но я умею: погода, время, калькулятор, поиск по Википедии, картинки и заметки. Попробуйте ещё раз чуть позже.'
  };
}

/* ------------------------------------------------------------------ */
/* Mini App initData                                                   */
/* ------------------------------------------------------------------ */

async function verifyInitData(initData, token) {
  try {
    const p = new URLSearchParams(initData);
    const hash = p.get('hash');
    if (!hash) return null;
    const auth = Number(p.get('auth_date') || 0);
    if (auth && Date.now() / 1000 - auth > 86400) return null;
    p.delete('hash');
    const check = [...p.keys()].sort().map((k) => k + '=' + p.get(k)).join('\n');

    const k1 = await crypto.subtle.importKey('raw', enc.encode('WebAppData'),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const secret = await crypto.subtle.sign('HMAC', k1, enc.encode(token));
    const k2 = await crypto.subtle.importKey('raw', secret,
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', k2, enc.encode(check));
    const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (hex !== hash) return null;
    return p.get('user') ? JSON.parse(p.get('user')) : { id: 0 };
  } catch (e) {
    console.error('initData:', e.message);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* HTML Mini App                                                       */
/* ------------------------------------------------------------------ */

const MINIAPP_HTML = String.raw`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0f19">
<title>Емеран · AI агент</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
:root{--bg:#0b0f19;--card:rgba(255,255,255,.055);--line:rgba(255,255,255,.09);--text:#eaf0ff;--muted:#98a3bd;--a:#8b5cf6;--b:#22d3ee;--tg-theme-bg-color:var(--bg);--tg-theme-text-color:var(--text);--tg-theme-hint-color:var(--muted);--tg-theme-secondary-bg-color:#111827}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{height:100%;margin:0}
body{background:var(--tg-theme-bg-color);color:var(--tg-theme-text-color);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;overflow:hidden}
.orb{position:fixed;border-radius:50%;filter:blur(80px);opacity:.35;pointer-events:none}
.o1{width:280px;height:280px;background:var(--a);top:-120px;left:-90px}
.o2{width:320px;height:320px;background:var(--b);bottom:-160px;right:-120px;opacity:.22}
.wrap{position:relative;height:100%;display:flex;flex-direction:column;padding:calc(env(safe-area-inset-top) + 14px) 14px calc(env(safe-area-inset-bottom) + 12px);max-width:720px;margin:0 auto}
header{display:flex;align-items:center;gap:11px;padding-bottom:12px}
.logo{width:38px;height:38px;border-radius:13px;display:grid;place-items:center;font-weight:800;font-size:19px;background:linear-gradient(135deg,var(--a),var(--b));box-shadow:0 8px 24px rgba(139,92,246,.35)}
h1{font-size:16px;margin:0;font-weight:700;letter-spacing:.2px}
.sub{font-size:11px;color:var(--muted);display:flex;align-items:center;gap:5px;margin-top:2px}
.dot{width:7px;height:7px;border-radius:50%;background:#34d399;box-shadow:0 0 8px #34d399}
.hero{margin:4px 0 12px;padding:15px;border:1px solid var(--line);border-radius:20px;background:linear-gradient(135deg,rgba(139,92,246,.14),rgba(34,211,238,.07))}
.hero b{font-size:18px;display:block;margin-bottom:4px}
.hero span{color:var(--muted);font-size:12.5px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:12px}
.f{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:9px 4px;text-align:center;cursor:pointer;transition:.18s;user-select:none}
.f:active{transform:scale(.94);border-color:var(--a)}
.f i{font-style:normal;font-size:18px;display:block}
.f small{font-size:10px;color:var(--muted)}
.chips{display:flex;gap:7px;overflow-x:auto;padding-bottom:8px;scrollbar-width:none}
.chips::-webkit-scrollbar{display:none}
.chip{white-space:nowrap;border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:999px;padding:6px 11px;font-size:12px;cursor:pointer}
.chip:active{transform:scale(.96);border-color:var(--b)}
.chat{flex:1;overflow-y:auto;padding:6px 2px 10px;display:flex;flex-direction:column;gap:9px;scroll-behavior:smooth}
.msg{max-width:88%;padding:10px 13px;border-radius:16px;white-space:pre-wrap;word-break:break-word;font-size:14px;animation:in .2s ease}
@keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.msg.user{align-self:flex-end;background:linear-gradient(135deg,#7c3aed,#6d28d9);border-bottom-right-radius:5px}
.msg.bot{align-self:flex-start;background:var(--card);border:1px solid var(--line);border-bottom-left-radius:5px}
.msg img{max-width:100%;border-radius:12px;margin-top:9px;display:block}
.msg .err{color:#fca5a5}
.typing{align-self:flex-start;color:var(--muted);font-size:12px;padding:4px 8px}
.form{display:flex;gap:8px;padding-top:10px;border-top:1px solid var(--line)}
input{flex:1;min-width:0;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;color:var(--text);font-size:15px;outline:none}
input:focus{border-color:var(--a)}
button{width:46px;height:46px;border:0;border-radius:14px;background:linear-gradient(135deg,var(--a),var(--b));color:#fff;font-size:19px;font-weight:700;cursor:pointer}
button:disabled{opacity:.5}
#toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:#1f2937;color:#fff;padding:9px 14px;border-radius:12px;font-size:12px;opacity:0;transition:.25s;pointer-events:none;z-index:9}
#toast.on{opacity:1}
</style>
</head>
<body>
<div class="orb o1"></div><div class="orb o2"></div>
<div class="wrap">
<header>
  <div class="logo">Е</div>
  <div><h1>Емеран · AI агент</h1><div class="sub"><span class="dot"></span><span id="status">онлайн · нейросеть</span></div></div>
</header>
<div class="hero"><b>Привет, я Емеран 👋</b><span>Спроси про погоду, попроси посчитать, найти факт, нарисовать картинку или запомнить заметку.</span></div>
<div class="grid">
  <div class="f" data-q="Погода в Москве"><i>🌤</i><small>Погода</small></div>
  <div class="f" data-q="Посчитай 15% от 8400"><i>🧮</i><small>Калькулятор</small></div>
  <div class="f" data-q="Мои заметки"><i>📓</i><small>Заметки</small></div>
  <div class="f" data-q="Нарисуй картинку: космический кот"><i>🎨</i><small>Картинки</small></div>
  <div class="f" data-q="Найди в Википедии: Телеграм"><i>🔎</i><small>Поиск</small></div>
  <div class="f" data-q="Что умеешь?"><i>✨</i><small>Умения</small></div>
</div>
<div class="chips">
  <button class="chip" data-q="Погода в Москве">погода в Москве</button>
  <button class="chip" data-q="Сколько времени в Москве">время</button>
  <button class="chip" data-q="Запомни: встреча завтра в 10:00">запомнить</button>
  <button class="chip" data-q="Расскажи коротко про чёрные дыры">факт</button>
</div>
<div class="chat" id="chat"></div>
<form class="form" id="form">
  <input id="input" placeholder="Напиши сообщение…" autocomplete="off">
  <button type="submit" id="send">➤</button>
</form>
</div>
<div id="toast"></div>
<script>
(function(){
  var tg = window.Telegram && Telegram.WebApp;
  var chat = document.getElementById('chat');
  var input = document.getElementById('input');
  var form = document.getElementById('form');
  var toast = document.getElementById('toast');
  var status = document.getElementById('status');
  var history = [];
  var busy = false;

  if (tg) {
    tg.ready();
    tg.expand();
    var tp = tg.themeParams || {};
    if (tp.bg_color) document.documentElement.style.setProperty('--tg-theme-bg-color', tp.bg_color);
    if (tp.text_color) document.documentElement.style.setProperty('--tg-theme-text-color', tp.text_color);
    if (tp.hint_color) document.documentElement.style.setProperty('--tg-theme-hint-color', tp.hint_color);
    if (tp.secondary_bg_color) document.documentElement.style.setProperty('--tg-theme-secondary-bg-color', tp.secondary_bg_color);
  } else {
    status.textContent = 'режим предпросмотра';
  }

  function say(t, msg){
    toast.textContent = t; toast.classList.add('on');
    setTimeout(function(){ toast.classList.remove('on'); }, 2400);
  }
  function bubble(role, body, image){
    var el = document.createElement('div');
    el.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
    var p = document.createElement('div'); p.textContent = body; el.appendChild(p);
    if (image) { var im = document.createElement('img'); im.src = image; im.alt = 'generated'; el.appendChild(im); }
    chat.appendChild(el); chat.scrollTop = chat.scrollHeight;
    return el;
  }
  function typing(on){
    var old = document.getElementById('typing');
    if (old) old.remove();
    if (on) { var d = document.createElement('div'); d.id='typing'; d.className='typing'; d.textContent='Емеран печатает…'; chat.appendChild(d); chat.scrollTop=chat.scrollHeight; }
  }
  async function send(q){
    q = String(q || input.value || '').trim();
    if (!q || busy) return;
    busy = true;
    document.getElementById('send').disabled = true;
    input.value = '';
    bubble('user', q);
    history.push({role:'user', content:q});
    typing(true);
    try {
      var r = await fetch('/api/chat', {
        method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({ message:q, history:history.slice(-10), initData: tg ? tg.initData : '' })
      });
      var d = await r.json();
      typing(false);
      if (!r.ok || !d.ok) throw new Error(d.error || ('HTTP ' + r.status));
      bubble('bot', d.answer, d.image);
      history.push({role:'assistant', content:d.answer});
      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
    } catch (e) {
      typing(false);
      var el = bubble('bot', 'Ошибка: ' + e.message);
      el.querySelector('div').className = 'err';
    } finally {
      busy = false;
      document.getElementById('send').disabled = false;
      input.focus();
    }
  }

  form.addEventListener('submit', function(e){ e.preventDefault(); send(); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-q]'), function(el){
    el.addEventListener('click', function(){ send(el.getAttribute('data-q')); });
  });
  if (tg && tg.MainButton) {
    tg.MainButton.setText('Отправить');
    tg.MainButton.onClick(function(){ send(); });
    input.addEventListener('input', function(){
      if (input.value.trim()) tg.MainButton.show(); else tg.MainButton.hide();
    });
    tg.MainButton.hide();
  }
  bubble('bot', 'Я на связи. Выбери быстрый action снизу или напиши свой вопрос ✨');
})();
</script>
</body>
</html>`;

/* ------------------------------------------------------------------ */
/* Маршруты                                                            */
/* ------------------------------------------------------------------ */

async function setup(request, env) {
  const url = new URL(request.url);
  if (!env.SETUP_TOKEN || url.searchParams.get('token') !== env.SETUP_TOKEN) {
    return json({ ok: false, error: 'Неверный SETUP_TOKEN' }, 403);
  }
  if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: 'Нет TELEGRAM_BOT_TOKEN' }, 500);

  const base = url.origin;
  const secret = env.WEBHOOK_SECRET || '';
  const webhook = await tg(env, 'setWebhook', {
    url: base + '/webhook',
    secret_token: secret,
    allowed_updates: ['message', 'edited_message', 'callback_query', 'inline_query']
  });
  const commands = await tg(env, 'setMyCommands', {
    commands: [
      { command: 'start', description: 'Запустить AI-агента' },
      { command: 'app', description: 'Открыть Mini App' },
      { command: 'chat', description: 'Спросить агента' },
      { command: 'notes', description: 'Мои заметки' },
      { command: 'help', description: 'Что умеет агент' }
    ],
    language_code: 'ru'
  });
  const description = await tg(env, 'setMyDescription', {
    description: 'AI-агент Емеран: погода, калькулятор, поиск, картинки, заметки и умный чат. Есть Mini App.',
    language_code: 'ru'
  });
  const menu = await tg(env, 'setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Открыть сайт emre', web_app: { url: SITE_URL } }
  });
  return json({
    ok: webhook.ok && commands.ok && description.ok && menu.ok,
    webhook: base + '/webhook',
    miniapp: SITE_URL,
    results: { webhook, commands, description, menu }
  });
}

async function apiChat(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  let user = null;
  if (body.initData) user = await verifyInitData(body.initData, env.TELEGRAM_BOT_TOKEN);
  if (!user && env.ALLOW_DEV === '1' && body.devUserId) user = { id: Number(body.devUserId) };
  if (!user) {
    return json({ ok: false, error: 'Откройте приложение внутри Telegram' }, 401);
  }
  const message = clip(body.message, 2000);
  if (!message) return json({ ok: false, error: 'Пустое сообщение' }, 400);
  const result = await runAgent(env, 'u' + user.id, message, body.history);
  return json({ ok: true, answer: result.text, image: result.image || null, card: result.card || null });
}

async function handleUpdate(env, update, origin) {
  const q = update.callback_query;
  if (q) {
    await tg(env, 'answerCallbackQuery', { callback_query_id: q.id });
    const chatId = q.message?.chat?.id;
    if (!chatId) return;
    if (q.data === 'weather') {
      const r = await runAgent(env, 'u' + (q.from?.id || chatId), 'Погода в Москве', []);
      await tg(env, 'sendMessage', { chat_id: chatId, text: r.text });
    } else if (q.data === 'help') {
      await tg(env, 'sendMessage', {
        chat_id: chatId,
        text: 'Я умею:\n• погода по городу\n• арифметика и проценты\n• поиск фактов в Википедии\n• генерация картинок\n• заметки («запомни …» / «мои заметки»)\n• текущее время\n\nКнопка «Открыть AI-приложение» в меню — мой Mini App.'
      });
    }
    return;
  }

  const inline = update.inline_query;
  if (inline) {
    await tg(env, 'answerInlineQuery', {
      inline_query_id: inline.id,
      results: [{
        type: 'article',
        id: 'ask1',
        title: 'Спросить Емерана',
        description: clip(inline.query || 'Напиши вопрос', 60),
        input_message_content: { message_text: inline.query || 'Привет, Емеран!' },
        reply_markup: { inline_keyboard: [[{ text: 'Открыть сайт emre', web_app: { url: SITE_URL } }]] }
      }],
      cache_time: 0
    });
    return;
  }

  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const uid = 'u' + (msg.from?.id || chatId);
  const raw = msg.text.trim();
  const cmd = raw.split('@')[0].split(' ')[0].toLowerCase();

  if (cmd === '/start' || cmd === '/app') {
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: 'Привет! Я Емеран — AI-агент с Mini App 🌟\n\nНажми кнопку ниже, чтобы открыть приложение, или просто напиши мне сообщение.',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚀 Открыть сайт emre', web_app: { url: SITE_URL } }],
          [{ text: '🌤 Погода', callback_data: 'weather' }, { text: '✨ Умения', callback_data: 'help' }]
        ]
      }
    });
    return;
  }
  if (cmd === '/help') {
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: 'Команды:\n/start — запуск и Mini App\n/app — открыть приложение\n/chat <вопрос> — спросить агента\n/notes — мои заметки\n/reset — очистить историю\n\nТакже просто напиши вопрос: погода, калькулятор, поиск, картинка, заметки.'
    });
    return;
  }
  if (cmd === '/notes') {
    const r = await toolNoteList(env, uid);
    await tg(env, 'sendMessage', { chat_id: chatId, text: r.text });
    return;
  }
  if (cmd === '/reset') {
    await storeSet(env, 'hist:' + uid, '[]');
    await tg(env, 'sendMessage', { chat_id: chatId, text: 'История очищена. Начнём заново ✨' });
    return;
  }

  let question = raw;
  if (cmd === '/chat') question = raw.slice('/chat'.length).trim();
  if (!question) return;

  await tg(env, 'sendChatAction', { chat_id: chatId, action: 'typing' });
  const history = JSON.parse((await storeGet(env, 'hist:' + uid)) || '[]');
  const result = await runAgent(env, uid, question, history);
  history.push({ role: 'user', content: clip(question, 1500) });
  history.push({ role: 'assistant', content: clip(result.text, 1500) });
  await storeSet(env, 'hist:' + uid, JSON.stringify(history.slice(-12)));

  if (result.image) {
    await tg(env, 'sendPhoto', { chat_id: chatId, photo: result.image, caption: clip(result.text, 900) });
  } else {
    await tg(env, 'sendMessage', { chat_id: chatId, text: clip(result.text, 3500) });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/') return Response.redirect(new URL('/app', url).href, 302);
    if (url.pathname === '/health') {
      return json({ ok: true, service: 'emeran-ai-agent', time: new Date().toISOString() });
    }
    if (url.pathname === '/app') {
      return text(MINIAPP_HTML, 200, 'text/html; charset=utf-8');
    }
    if (url.pathname === '/setup') return setup(request, env);
    if (url.pathname === '/api/chat' && request.method === 'POST') return apiChat(request, env);

    if (url.pathname === '/webhook' && request.method === 'POST') {
      if (env.WEBHOOK_SECRET) {
        const got = request.headers.get('x-telegram-bot-api-secret-token');
        if (got !== env.WEBHOOK_SECRET) return json({ ok: false, error: 'forbidden' }, 403);
      }
      let update;
      try { update = await request.json(); } catch { return json({ ok: false }, 400); }
      ctx.waitUntil(handleUpdate(env, update, url.origin).catch((e) => console.error('update:', e)));
      return json({ ok: true });
    }

    return json({ ok: false, error: 'not found' }, 404);
  }
};
