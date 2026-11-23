<#
.SYNOPSIS
  End-to-end check of the speech-to-text skill.

.DESCRIPTION
  Makes a four-line, two-voice English conversation with the built-in Windows
  voices, transcribes it with speaker labels, then checks the words and that the
  labels alternate. Then plays the same conversation with a third voice talking
  quietly in between, as if from across the room, and checks that --keep-loud 2
  drops that voice and keeps the four lines. About a minute once the model is on disk.

.EXAMPLE
  .\tests\selftest.ps1
  .\tests\selftest.ps1 -Root D:\speech-to-text
#>
param([string]$Root = 'C:\dev-workspace\tools\speech-to-text')

$ErrorActionPreference = 'Stop'
$py = Join-Path $Root 'venv\Scripts\python.exe'
$transcribe = Join-Path $PSScriptRoot '..\scripts\transcribe.py'
if (-not (Test-Path $py)) { throw "No venv at $py - see references/INSTALL.md" }

$lines = @(
  'Good morning. Did you finish the report for the client?',
  'Not yet. I still need the sales numbers from last week.',
  'I can send them to you this afternoon.',
  'Great, then I will finish it by Friday.'
)
$background = @(
  'The coffee machine on the third floor is broken again.',
  'Let us order lunch from the noodle place downstairs.'
)
$work = Join-Path $env:TEMP ('stt-selftest-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory $work | Out-Null
try {
  Add-Type -AssemblyName System.Speech
  $tts = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $voices = @($tts.GetInstalledVoices() |
    Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'en-*' } |
    ForEach-Object { $_.VoiceInfo.Name })

  # Writes one wav. Each item is a voice index, a volume (0-100, linear) and the text; one
  # Speak call per item, so each can have its own volume, all into the same file.
  function New-Conversation([string]$path, $items) {
    $tts.SetOutputToWaveFile($path)
    foreach ($item in $items) {
      $tts.Volume = $item[1]
      $pb = New-Object System.Speech.Synthesis.PromptBuilder
      if ($voices.Count) { $pb.StartVoice($voices[$item[0] % $voices.Count]) }
      $pb.AppendText($item[2])
      if ($voices.Count) { $pb.EndVoice() }
      $pb.AppendBreak([TimeSpan]::FromMilliseconds(800))
      $tts.Speak($pb)
    }
    $tts.SetOutputToNull()
  }

  # transcribe.py logs progress to stderr. If the caller redirects stderr, PowerShell 5.1
  # turns each line into an error record, which 'Stop' would make fatal.
  function Invoke-Transcribe([string]$wav, [string[]]$extra) {
    $ErrorActionPreference = 'Continue'
    & $py $transcribe $wav --language en --formats json @extra | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "transcribe.py exited with $LASTEXITCODE on $wav" }
    # PowerShell 5.1 emits a parsed JSON array as one pipeline object, so wrapping the
    # pipeline in @() would nest it; assign first, then unroll.
    $parsed = Get-Content ([IO.Path]::ChangeExtension($wav, '.json')) -Raw -Encoding UTF8 | ConvertFrom-Json
    return , @($parsed)
  }

  $script:failed = 0
  function Check([string]$name, [bool]$ok) {
    if ($ok) { Write-Host "ok   $name" } else { Write-Host "FAIL $name"; $script:failed++ }
  }
  function Norm([string]$s) { $s.ToLower() -replace '[^a-z0-9]', '' }

  function Test-Conversation([string]$case, $rows) {
    Check "$case - four lines" ($rows.Count -eq 4)
    for ($i = 0; $i -lt [Math]::Min($rows.Count, 4); $i++) {
      Check "$case - line $($i + 1) text" ((Norm $rows[$i].text) -eq (Norm $lines[$i]))
    }
    if ($voices.Count -lt 2) {
      Write-Host "skip $case - speakers alternate (fewer than two English voices installed)"
    } elseif ($rows.Count -eq 4) {
      Check "$case - speakers alternate" ($rows[0].speaker -ne $rows[1].speaker -and
        $rows[0].speaker -eq $rows[2].speaker -and $rows[1].speaker -eq $rows[3].speaker)
    }
  }

  # Case 1: two voices taking turns.
  $plain = for ($i = 0; $i -lt 4; $i++) { , @($i, 100, $lines[$i]) }
  New-Conversation "$work\plain.wav" $plain
  Test-Conversation 'plain' (Invoke-Transcribe "$work\plain.wav" @('--speakers', '2'))

  # Case 2: the same, with a third voice (or the first again, if only two are installed)
  # at volume 8, about 22 dB down, saying two other lines in between.
  $mixed = @(
    @(0, 100, $lines[0]), @(2, 8, $background[0]), @(1, 100, $lines[1]),
    @(0, 100, $lines[2]), @(2, 8, $background[1]), @(1, 100, $lines[3])
  )
  New-Conversation "$work\background.wav" $mixed
  $rows = Invoke-Transcribe "$work\background.wav" @('--keep-loud', '2')
  Test-Conversation 'background' $rows
  $leaked = @($rows | Where-Object { (Norm $_.text) -match 'coffee|noodle|lunch|machine' })
  Check 'background - quiet voice dropped' ($leaked.Count -eq 0)

  $tts.Dispose()
  if ($script:failed) { Write-Host "$($script:failed) check(s) failed"; exit 1 }
  Write-Host 'all checks passed'
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
