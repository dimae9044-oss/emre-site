# Локальный AI-агент для Telegram без Node/Python и без публичного хостинга.
# Работает через long polling. Остановите перед включением webhook (Ctrl+C).

[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$token = ''
foreach ($line in (Get-Content (Join-Path $dir '.env'))) {
  if ($line -match '^\s*TELEGRAM_BOT_TOKEN=(.*)$') { $token = $Matches[1].Trim() }
}
if (-not $token) { throw 'TELEGRAM_BOT_TOKEN не найден в .env' }

$offsetFile = Join-Path $dir 'offset.txt'
$offset = 0
if (Test-Path $offsetFile) { $offset = [int64](Get-Content $offsetFile -Raw) }

$system = 'Ты Емеран — дружелюбный AI-агент в Telegram. Отвечай на русском, кратко и по делу. Умеешь объяснять, считать, помогать с идеями. Если не знаешь — честно говори об этом.'
$siteUrl = 'https://dimae9044-oss.github.io/emre-site/'

function Send-Telegram([string]$method, [hashtable]$payload) {
  $json = ($payload | ConvertTo-Json -Depth 8 -Compress)
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  return Invoke-RestMethod -TimeoutSec 30 -Method Post `
    -Uri ('https://api.telegram.org/bot' + $token + '/' + $method) `
    -ContentType 'application/json; charset=utf-8' -Body $bytes
}

function Ask-Model([string]$question) {
  $body = @{
    model = 'openai'
    messages = @(
      @{ role = 'system'; content = $system },
      @{ role = 'user'; content = $question }
    )
    stream = $false
    max_tokens = 500
    temperature = 0.4
  }
  $json = ($body | ConvertTo-Json -Depth 8 -Compress)
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $r = Invoke-RestMethod -TimeoutSec 60 -Method Post -Uri 'https://text.pollinations.ai/openai' `
    -ContentType 'application/json; charset=utf-8' -Body $bytes
  return [string]$r.choices[0].message.content
}

Write-Host 'Емеран (локальный режим) запущен. Ctrl+C — остановить.' -ForegroundColor Green

while ($true) {
  try {
    $updates = Invoke-RestMethod -TimeoutSec 40 `
      -Uri ('https://api.telegram.org/bot' + $token + '/getUpdates?offset=' + $offset + '&timeout=25&allowed_updates=%5B%22message%22%5D')
    foreach ($u in $updates.result) {
      $offset = [int64]$u.update_id + 1
      Set-Content -Path $offsetFile -Value $offset -Encoding ASCII
      $msg = $u.message
      if (-not $msg -or -not $msg.text) { continue }
      $chat = $msg.chat.id
      $text = [string]$msg.text

      $keyboard = @{
        inline_keyboard = @(
          @(
            @{ text = 'Открыть сайт emre'; web_app = @{ url = $siteUrl } }
          )
        )
      }

      if ($text -eq '/start' -or $text -eq '/help' -or $text -eq '/app') {
        Send-Telegram 'sendMessage' @{
          chat_id = $chat
          text = 'Привет! Я Емеран 🤖 Сайт emre открывается прямо здесь как Mini App — жми кнопку ниже. Также я отвечаю на вопросы как AI-агент.'
          reply_markup = $keyboard
        } | Out-Null
        continue
      }

      Write-Host ('[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $text)
      try {
        $answer = Ask-Model $text
        if (-not $answer) { $answer = 'Не удалось получить ответ. Попробуйте ещё раз.' }
      } catch {
        $answer = 'Модель временно недоступна: ' + $_.Exception.Message
      }
      if ($answer.Length -gt 3500) { $answer = $answer.Substring(0, 3500) }
      Send-Telegram 'sendMessage' @{ chat_id = $chat; text = $answer } | Out-Null
    }
  } catch {
    Write-Host ('Ошибка: ' + $_.Exception.Message) -ForegroundColor Red
    Start-Sleep -Seconds 4
  }
}
