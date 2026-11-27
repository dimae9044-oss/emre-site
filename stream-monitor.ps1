param(
  [int]$IntervalSeconds = 60,
  [string]$TestChat = ''
)

# emre — мониторинг Twitch и автопубликация анонсов в Telegram-каналы стримеров.
# Работает через long polling: публичный webhook не нужен.
# Важно: бот должен быть добавлен в канал и иметь право «Отправлять сообщения».
# Анонс отправляется только если подписка стримера активна (status=active и paidUntil в будущем).

[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$envPath = Join-Path $root '.env'
$stateFile = Join-Path $root 'data\state.json'
$flagsFile = Join-Path $root 'data\live-flags.json'
$logFile = Join-Path $root 'data\monitor.log'
$dataDir = Join-Path $root 'data'

if (-not (Test-Path -LiteralPath $dataDir)) { New-Item -ItemType Directory -Force -Path $dataDir | Out-Null }

$botToken = ''
if (Test-Path -LiteralPath $envPath) {
  foreach ($line in (Get-Content -LiteralPath $envPath -Encoding UTF8)) {
    if ($line -match '^\s*TELEGRAM_BOT_TOKEN=(.*)$') { $botToken = $Matches[1].Trim() }
  }
}
if (-not $botToken) { throw 'TELEGRAM_BOT_TOKEN не найден в .env' }

function Log([string]$message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
  Write-Host $line
}

function To-Hashtable($obj) {
  if ($null -eq $obj) { return @{} }
  if ($obj -is [hashtable]) { return $obj }
  $h = @{}
  foreach ($p in $obj.PSObject.Properties) { $h[$p.Name] = $p.Value }
  return $h
}

function Read-Json([string]$path, $fallback) {
  if (-not (Test-Path -LiteralPath $path)) { return $fallback }
  try { return (Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json) }
  catch { return $fallback }
}

function Esc([string]$value) { return [Net.WebUtility]::HtmlEncode([string]$value) }

function Send-Telegram([string]$method, [hashtable]$payload) {
  for ($attempt = 0; $attempt -lt 4; $attempt++) {
    $json = $payload | ConvertTo-Json -Depth 8 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    try {
      $res = Invoke-RestMethod -TimeoutSec 30 -Method Post `
        -Uri ('https://api.telegram.org/bot' + $botToken + '/' + $method) `
        -ContentType 'application/json; charset=utf-8' -Body $bytes
      if ($res.ok) { return $res }
      if ($res.parameters -and $res.parameters.retry_after) {
        Start-Sleep -Seconds ([int]$res.parameters.retry_after + 1)
        continue
      }
      throw ($res.description)
    } catch {
      $detail = [string]$_.ErrorDetails.Message
      if ($detail -match '"retry_after"\s*:\s*(\d+)') {
        Start-Sleep -Seconds ([int]$Matches[1] + 1)
        continue
      }
      throw
    }
  }
  throw 'Telegram не ответил после повторов'
}

function Decapi([string]$login, [string]$field) {
  $wc = [Net.WebClient]::new()
  $wc.Encoding = [Text.Encoding]::UTF8
  return ([string]$wc.DownloadString('https://decapi.me/twitch/' + $field + '/' + $login)).Trim()
}

function Announce([hashtable]$streamer, [string]$chatId, [string]$title, [string]$game) {
  $lines = @('🔴 <b>СТРИМ НАЧАЛСЯ!</b>', '')
  if ($streamer.name) { $lines += '👤 ' + (Esc $streamer.name) }
  if ($game) { $lines += '🎮 Игра: ' + (Esc $game) }
  if ($title) { $lines += '📝 ' + (Esc $title) }
  if ($streamer.link) { $lines += '👉 Смотреть: ' + (Esc $streamer.link) }
  $text = ($lines -join "`n") + "`n`n💜 emre"

  $res = Send-Telegram 'sendMessage' @{
    chat_id = $chatId
    text = $text
    parse_mode = 'HTML'
    disable_web_page_preview = $false
  }
  if (-not $res.ok) { throw ($res.description) }
  return $res
}

try {
  $me = Send-Telegram 'getMe' @{}
  $botId = $me.result.id
  Log ('Бот @' + $me.result.username + ' (id=' + $botId + ') на связи.')
} catch {
  throw ('Не удалось получить getMe: ' + $_.Exception.Message)
}

if ($TestChat) {
  Log ('Тестовая отправка в ' + $TestChat)
  try {
    $res = Announce @{ name = 'Nainangel'; link = 'https://www.twitch.tv/nainangel' } $TestChat 'Тест анонса' 'Minecraft'
    Log ('ТЕСТ ОК: message_id=' + $res.result.message_id)
  } catch {
    Log ('ТЕСТ ОШИБКА: ' + $_.Exception.Message)
    Log 'Добавь @emeranonsbot в канал и выдай право «Отправлять сообщения» (Admin → Add Admin).'
  }
  exit
}

Log ('Мониторинг стримов запущен. Проверка каждые ' + $IntervalSeconds + ' сек.')

$adminWarned = @{}

while ($true) {
  try {
    if (-not (Test-Path -LiteralPath $stateFile)) {
      Log 'Нет data/state.json — открой http://localhost:8787/ в браузере хотя бы один раз.'
      Start-Sleep -Seconds $IntervalSeconds
      continue
    }

    $state = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $flags = To-Hashtable (Read-Json $flagsFile @{})
    $changed = $false

    foreach ($s in $state.streamers) {
      if ([string]$s.status -ne 'active') { continue }
      if ($s.paidUntil) {
        try {
          $until = [DateTimeOffset]::Parse([string]$s.paidUntil)
          if ($until -lt [DateTimeOffset]::UtcNow) { continue }
        } catch { continue }
      }

      $login = [string]$s.twitch
      if (-not $login) { continue }
      $key = [string]$s.id
      $chatId = [string]$s.chatId
      if (-not $chatId) { $chatId = [string]$state.settings.channel }
      if (-not $chatId) { continue }

      $isLive = $false
      try {
        $uptime = Decapi $login 'uptime'
        $isLive = ($uptime -ne '') -and ($uptime -notmatch 'offline')
      } catch {
        Log ('Не удалось проверить ' + $login + ': ' + $_.Exception.Message)
      }

      if (-not $isLive) {
        if ($flags.ContainsKey($key) -and $flags[$key]) {
          $flags[$key] = $null
          $changed = $true
          Log ('Стрим завершён: ' + $s.name)
        }
        continue
      }

      # Перед отправкой проверяем права бота в канале.
      try {
        $member = Send-Telegram 'getChatMember' @{ chat_id = $chatId; user_id = [int64]$botId }
        $status = [string]$member.result.status
        $canPost = [bool]$member.result.can_post_messages
        if ($status -notin @('administrator', 'creator') -or (-not $canPost -and $status -ne 'creator')) {
          throw 'нет права отправлять сообщения'
        }
        $adminWarned[$chatId] = $false
      } catch {
        if (-not $adminWarned[$chatId]) {
          Log ('НЕТ ДОСТУПА в ' + $chatId + ': ' + $_.Exception.Message)
          Log ('Решение: добавь @emeranonsbot в канал ' + $chatId + ' и выдай право «Отправлять сообщения» (Admin → Add Admin).')
          $adminWarned[$chatId] = $true
        }
        continue
      }

      if (-not ($flags.ContainsKey($key) -and $flags[$key])) {
        $title = ''
        $game = ''
        try { $title = Decapi $login 'title' } catch { }
        try { $game = Decapi $login 'game' } catch { }
        try {
          $res = Announce @{ name = $s.name; link = $s.link } $chatId $title $game
          $flags[$key] = [DateTimeOffset]::UtcNow.ToString('o')
          $changed = $true
          Log ('Анонс отправлен: ' + $s.name + ' → ' + $chatId + ' (message_id=' + $res.result.message_id + ')')
        } catch {
          Log ('ОШИБКА отправки в ' + $chatId + ': ' + $_.Exception.Message)
        }
      }
    }

    if ($changed) {
      $flags | ConvertTo-Json -Depth 6 -Compress | Set-Content -LiteralPath $flagsFile -Encoding UTF8
    }
  } catch {
    Log ('Ошибка цикла: ' + $_.Exception.Message)
  }
  Start-Sleep -Seconds $IntervalSeconds
}
