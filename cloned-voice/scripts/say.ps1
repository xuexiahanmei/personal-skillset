<#
.SYNOPSIS
  Speak text in the cloned voice served by the VoxCPM2 service inside WSL.

.DESCRIPTION
  Two modes:
    -Text    one line, one tone.
    -Script  a JSON array of {text, emotion} so one passage can change tone
             partway through. Segments are joined with a short gap.

  Windows cannot reach the WSL loopback port even under mirrored networking, so
  this shells into WSL (which always works) and lets it call 127.0.0.1:18790
  there. The request crosses as base64 and the bash half lives in WSL as a real
  file, because anything piped from PowerShell arrives with a UTF-8 BOM and CRLF
  endings that bash refuses.

  The model stays resident in the service, so a call costs only generation time,
  roughly 1.5x the spoken length plus about a second of overhead.

.PARAMETER Emotion
  calm - ordinary speech, statements, questions, apologies.
  loud - shouting, anger, confrontation.
  The two are separate voice references; the tone cannot be steered by wording
  alone, so the caller must pick.

.EXAMPLE
  .\say.ps1 -Text "Hello there" -Emotion calm

.EXAMPLE
  .\say.ps1 -Script '[{"text":"A","emotion":"calm"},{"text":"B","emotion":"loud"}]' -Format mp3

.EXAMPLE
  .\say.ps1 -Text "Hi" -Probe        # health check only, no generation
#>
[CmdletBinding(DefaultParameterSetName = 'Single')]
param(
  [Parameter(Mandatory = $true, ParameterSetName = 'Single')][string]$Text,
  [Parameter(ParameterSetName = 'Single')][ValidateSet('calm', 'loud')][string]$Emotion = 'calm',

  [Parameter(Mandatory = $true, ParameterSetName = 'Script')][string]$Script,

  [ValidateSet('wav', 'mp3')][string]$Format = 'wav',
  [string]$Out = '',
  [int]$GapMs = 180,
  [switch]$Probe
)

$ErrorActionPreference = 'Stop'

function Invoke-WslTts {
  param([string]$Endpoint, [string]$JsonBody)
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($JsonBody))
  $result = wsl -d Ubuntu -u root -- bash /opt/voxcpm/say.sh $b64 $Endpoint
  if ($LASTEXITCODE -ne 0 -or -not $result) {
    throw "TTS failed (exit $LASTEXITCODE). Check the service: " +
          "wsl -d Ubuntu -u root -- systemctl status voxcpm-tts"
  }
  return ($result -join '').Trim()
}

if ($Probe) {
  $h = wsl -d Ubuntu -u root -- curl -s --max-time 5 http://127.0.0.1:18790/health
  if ($LASTEXITCODE -ne 0 -or -not $h) { throw 'Service is not answering.' }
  return ($h -join '')
}

if ($PSCmdlet.ParameterSetName -eq 'Script') {
  try { $segs = $Script | ConvertFrom-Json } catch { throw "-Script is not valid JSON: $_" }
  if (-not $segs) { throw '-Script parsed to nothing.' }
  $list = @(foreach ($s in $segs) {
    if (-not $s.text) { throw 'every segment needs a non-empty text field' }
    $e = if ($s.emotion) { "$($s.emotion)".ToLower() } else { 'calm' }
    if ($e -ne 'calm' -and $e -ne 'loud') { throw "unknown emotion '$e' (use calm or loud)" }
    @{ text = "$($s.text)"; emotion = $e }
  })
  $body = @{ segments = $list; format = $Format; gap_ms = $GapMs } | ConvertTo-Json -Compress -Depth 5
  $endpoint = 'tts_script'
  $label = "$($list.Count) segments"
}
else {
  $body = @{ text = $Text; emotion = $Emotion; format = $Format } | ConvertTo-Json -Compress
  $endpoint = 'tts'
  $label = $Emotion
}

if (-not $Out) {
  $Out = Join-Path $env:TEMP ("tts_{0}.{1}" -f (Get-Date -Format 'HHmmss'), $Format)
}
$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

$sw = [Diagnostics.Stopwatch]::StartNew()
$b64out = Invoke-WslTts -Endpoint $endpoint -JsonBody $body
$sw.Stop()

[IO.File]::WriteAllBytes($Out, [Convert]::FromBase64String($b64out))
[pscustomobject]@{
  Path    = $Out
  SizeKB  = [math]::Round((Get-Item $Out).Length / 1KB, 1)
  Spoke   = $label
  Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
}
