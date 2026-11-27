param([int]$Port = 8787)

# emre — локальный сервер: раздаёт сайт и отправляет сообщения через Telegram-бота.
# Токен бота хранится только в .env и никогда не попадает в браузер.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$envPath = Join-Path $root '.env'

if (-not (Test-Path -LiteralPath $envPath)) {
  throw "Не найден файл .env рядом с server.ps1: $envPath"
}

$cfg = @{}
Get-Content -LiteralPath $envPath -Encoding UTF8 | ForEach-Object {
  if ($_ -match '^\s*#') { return }
  if ($_ -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$') {
    $cfg[$Matches[1]] = $Matches[2]
  }
}

$botToken = $cfg['TELEGRAM_BOT_TOKEN']
$adminToken = $cfg['ADMIN_TOKEN']
$fallbackChat = $cfg['TELEGRAM_CHAT_ID']
$botName = $cfg['BOT_NAME']
if (-not $botName) { $botName = 'emre' }

if (-not $botToken -or -not $adminToken) {
  throw 'В .env обязательны TELEGRAM_BOT_TOKEN и ADMIN_TOKEN'
}

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.webp' = 'image/webp'
}

function Send-Json($context, [int]$status, $data) {
  $json = $data | ConvertTo-Json -Compress -Depth 6
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $context.Response.StatusCode = $status
  $context.Response.ContentType = 'application/json; charset=utf-8'
  $context.Response.ContentLength64 = $bytes.Length
  $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Send-Text($context, [int]$status, [string]$text) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($text)
  $context.Response.StatusCode = $status
  $context.Response.ContentType = 'text/plain; charset=utf-8'
  $context.Response.ContentLength64 = $bytes.Length
  $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Esc([string]$value) {
  return [Net.WebUtility]::HtmlEncode([string]$value)
}

$listener = [Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()

Write-Host "emre готов: http://localhost:$Port/"
Write-Host "Проверка бота: http://localhost:$Port/health"
Write-Host "Для остановки нажми Ctrl+C"

try {
  while ($listener.IsListening) {
    $context = $null
    try {
      $context = $listener.GetContext()

      $context.Response.Headers.Add('Access-Control-Allow-Origin', '*')
      $context.Response.Headers.Add('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      $context.Response.Headers.Add('Access-Control-Allow-Headers', 'content-type')
      $context.Response.Headers.Add('Cache-Control', 'no-store')

      if ($context.Request.HttpMethod -eq 'OPTIONS') {
        $context.Response.StatusCode = 204
        $context.Response.Close()
        continue
      }

      $path = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath)

      if ($context.Request.HttpMethod -eq 'GET' -and $path -eq '/health') {
        try {
          $me = Invoke-RestMethod -Uri "https://api.telegram.org/bot$botToken/getMe" -TimeoutSec 15
          Send-Json $context 200 @{ ok = $true; username = $me.result.username; name = $me.result.first_name }
        } catch {
          Send-Json $context 502 @{ ok = $false; error = $_.Exception.Message }
        }
        $context.Response.Close()
        continue
      }

      if ($path -eq '/announce') {
        if ($context.Request.HttpMethod -ne 'POST') {
          Send-Text $context 405 'Only POST'
          $context.Response.Close()
          continue
        }
        if ($context.Request.QueryString['token'] -ne $adminToken) {
          Send-Text $context 403 'Неверный token'
          $context.Response.Close()
          continue
        }

        $reader = [IO.StreamReader]::new($context.Request.InputStream, [Text.Encoding]::UTF8)
        $raw = $reader.ReadToEnd()
        $reader.Close()

        try {
          $body = $raw | ConvertFrom-Json
        } catch {
          Send-Json $context 400 @{ error = 'Некорректный JSON' }
          $context.Response.Close()
          continue
        }

        $chatId = [string]$body.chat_id
        if (-not $chatId) { $chatId = [string]$fallbackChat }
        if (-not $chatId) {
          Send-Json $context 400 @{ error = 'Не указан Telegram-чат' }
          $context.Response.Close()
          continue
        }

        $kind = [string]$body.kind
        if ($kind -eq 'start') {
          $heading = '🔴 <b>СТРИМ НАЧАЛСЯ!</b>'
        } else {
          $heading = '📢 <b>УВЕДОМЛЕНИЕ О СТРИМЕ</b>'
        }

        $lines = @($heading, '')
        if ($body.name) { $lines += '👤 ' + (Esc ([string]$body.name)) }
        if ($body.game) { $lines += '🎮 Игра: ' + (Esc ([string]$body.game)) }
        if ($body.title) { $lines += '📝 ' + (Esc ([string]$body.title)) }
        if ($body.description -and $body.description -ne $body.title) {
          $lines += '💬 ' + (Esc ([string]$body.description))
        }
        if ($body.link) { $lines += '👉 Смотреть: ' + (Esc ([string]$body.link)) }

        if ($body.date) {
          try {
            $dt = [DateTimeOffset]::Parse([string]$body.date).ToOffset([TimeSpan]::FromHours(3))
            $ru = [Globalization.CultureInfo]::GetCultureInfo('ru-RU')
            $lines += '🕒 ' + $dt.ToString('d MMMM, HH:mm МСК', $ru)
          } catch { }
        }

        $text = ($lines -join "`n") + "`n`n💜 " + (Esc $botName)

        $payload = @{
          chat_id = $chatId
          text = $text
          parse_mode = 'HTML'
          disable_web_page_preview = $false
        }
        $jsonBody = $payload | ConvertTo-Json -Compress -Depth 5
        $bytes = [Text.Encoding]::UTF8.GetBytes($jsonBody)

        try {
          $res = Invoke-RestMethod `
            -Method Post `
            -Uri "https://api.telegram.org/bot$botToken/sendMessage" `
            -ContentType 'application/json; charset=utf-8' `
            -Body $bytes `
            -TimeoutSec 25
          if (-not $res.ok) { throw ($res.description) }
          Send-Json $context 200 @{ ok = $true; chat_id = $chatId }
        } catch {
          Send-Json $context 502 @{ error = $_.Exception.Message }
        }
        $context.Response.Close()
        continue
      }

      if ($context.Request.HttpMethod -ne 'GET') {
        Send-Text $context 405 'Only GET'
        $context.Response.Close()
        continue
      }

      if ($path -eq '/') { $path = '/index.html' }
      $relative = $path.TrimStart('/').Replace('/', [IO.Path]::DirectorySeparatorChar)
      $full = [IO.Path]::GetFullPath((Join-Path $root $relative))

      if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        Send-Text $context 403 'Forbidden'
        $context.Response.Close()
        continue
      }

      $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
      if (-not $mime.ContainsKey($ext) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
        Send-Text $context 404 'Not found'
        $context.Response.Close()
        continue
      }

      $bytes = [IO.File]::ReadAllBytes($full)
      $context.Response.StatusCode = 200
      $context.Response.ContentType = $mime[$ext]
      $context.Response.ContentLength64 = $bytes.Length
      $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      $context.Response.Close()
    } catch {
      if ($context -and $context.Response) {
        try {
          $context.Response.StatusCode = 500
          $context.Response.Close()
        } catch { }
      }
      Write-Warning $_.Exception.Message
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
