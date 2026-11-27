# Емеран — Telegram AI-агент + Mini App

Готовый проект: бот `@emeranonsbot`, AI-агент с инструментами и Mini App на одном Cloudflare Worker.

## Что уже сделано

- Токен бота сохранён в `.env` (в репозиторий не попадает — `.gitignore`).
- Команды бота и описание уже выставлены через Telegram Bot API.
- Сгенерированы `SETUP_TOKEN` и `WEBHOOK_SECRET` (тоже в `.env`).
- Написаны `worker.js` (бэкенд + агент + Mini App), `miniapp.html` (предпросмотр верстки), `wrangler.toml`.

## Возможности агента

| Инструмент | Пример запроса |
|---|---|
| Погода (Open-Meteo) | `Погода в Казани` |
| Калькулятор + проценты | `Посчитай 15% от 8400` |
| Поиск фактов (Википедия) | `Найди про чёрные дыры` |
| Генерация картинки (Pollinations) | `Нарисуй космического кота` |
| Заметки с памятью | `Запомни: встреча в 10:00`, `Мои заметки` |
| Время по часовому поясу | `Сколько времени в Москве` |
| Свободный диалог | любой вопрос |

Модель по умолчанию — бесплатный OpenAI-совместимый endpoint Pollinations (**ключ не нужен**). Можно подключить OpenAI / OpenRouter / Groq / Gemini через `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`.

---

## Вариант 1: без установки Node (через сайт Cloudflare)

1. Зайдите в **Cloudflare Dash → Workers & Pages → Create → Worker → Hello World → Deploy**.
2. Откройте **Edit code**, замените весь код содержимым `worker.js`, нажмите **Deploy**.
3. **Settings → Variables and Secrets** добавьте **Secrets**:
   - `TELEGRAM_BOT_TOKEN` — из `.env`
   - `SETUP_TOKEN` — из `.env`
   - `WEBHOOK_SECRET` — из `.env`
   
   и **Variables** (необязательно, уже есть значения по умолчанию):
   - `LLM_BASE_URL = https://text.pollinations.ai/openai`
   - `LLM_MODEL = openai`
4. Откройте в браузере:
   ```
   https://<имя-воркера>.<аккаунт>.workers.dev/setup?token=<SETUP_TOKEN из .env>
   ```
   Это привяжет webhook, команды, описание и кнопку Mini App в меню бота.
5. Готово: напишите боту `/start` или откройте `https://<имя-воркера>.<аккаунт>.workers.dev/app`.

> Для постоянных заметок и истории создайте в Cloudflare **KV namespace** и привяжите его как `AGENT_KV`. Без KV данные живут в памяти воркера (могут сбрасываться).

## Вариант 2: Wrangler CLI (нужен Node.js)

```powershell
npm install -g wrangler
wrangler login
cd C:\Users\Dim\Desktop\emeran-ai-agent
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put SETUP_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler deploy
```

Затем откройте `/setup?token=...` на адресе воркера (см. шаг 4 варианта 1).

---

## Локальный режим без хостинга (уже можно проверить)

`local-agent.ps1` — простой бот на long polling без Node/Python и без публичного HTTPS. Работает прямо сейчас:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\Dim\Desktop\emeran-ai-agent\local-agent.ps1
```

Он отвечает в Telegram через ту же модель, но без Mini App и инструментов. **Перед включением webhook остановите этот процесс** (Ctrl+C), иначе Telegram заблокирует polling.

---

## Безопасность

- Никогда не публикуйте `.env` и не вставляйте токен бота в клиентский код.
- `/setup` защищён `SETUP_TOKEN`, webhook — `WEBHOOK_SECRET`.
- Mini App проверяет подпись `initData` через HMAC с токеном бота; подделать запрос к `/api/chat` нельзя.
- Чтобы перевыпустить токены: сгенерируйте новые значения в `.env`, обновите Secrets в Cloudflare и вызовите `/setup?token=...` снова.
