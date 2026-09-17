<#
.SYNOPSIS
  Run JavaScript in an open Chrome DevTools console and get the result back.

.DESCRIPTION
  The only Win32 step left in the "do everything through the web" flow: paste a
  short expression into the DevTools console and read what it produced. Everything
  else - finding a chat, reading messages, composing - is done in JS against the
  page's own DOM, which is far more reliable than driving Chrome with fake clicks.

  Two things this fixes versus naive SendKeys automation:

  1. SetForegroundWindow is refused unpredictably by Windows' foreground lock. When
     it is refused the keystrokes land wherever focus actually is - in a browser
     that means "address bar, paste, navigate". AttachThreadInput to the current
     foreground thread lifts the restriction, and the result is verified.

  2. A run that never reached the console leaves the PREVIOUS result sitting in the
     clipboard, which looks exactly like success. Every call here checks that the
     clipboard actually changed away from the code it pasted, and throws if not.
#>

Add-Type -AssemblyName System.Windows.Forms

if (-not ('DT' -as [type])) {
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class DT {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
}
"@
}
[void][DT]::SetProcessDPIAware()

# Windows refuses SetForegroundWindow from a process that does not own the
# foreground. Attaching our input queue to the foreground thread lifts that for the
# duration of the call.
function Set-WindowForeground {
  param([Parameter(Mandatory)][IntPtr]$Handle, [int]$Tries = 3)
  for ($i = 0; $i -lt $Tries; $i++) {
    if ([DT]::IsIconic($Handle)) { [void][DT]::ShowWindow($Handle, 9) }
    $fg = [DT]::GetForegroundWindow()
    if ($fg -eq $Handle) { return $true }
    $me = [DT]::GetCurrentThreadId()
    $other = 0
    $fgThread = [DT]::GetWindowThreadProcessId($fg, [ref]$other)
    $attached = $false
    if ($fgThread -ne 0 -and $fgThread -ne $me) { $attached = [DT]::AttachThreadInput($me, $fgThread, $true) }
    [void][DT]::BringWindowToTop($Handle)
    [void][DT]::SetForegroundWindow($Handle)
    if ($attached) { [void][DT]::AttachThreadInput($me, $fgThread, $false) }
    Start-Sleep -Milliseconds 350
    if ([DT]::GetForegroundWindow() -eq $Handle) { return $true }
  }
  return ([DT]::GetForegroundWindow() -eq $Handle)
}

# The undocked DevTools window for a given page, found by its title.
function Get-DevToolsWindow {
  param([string]$Match = 'DevTools')
  $found = New-Object System.Collections.ArrayList
  $cb = [DT+EnumWindowsProc]{
    param($h, $l)
    if ([DT]::IsWindowVisible($h)) {
      $sb = New-Object System.Text.StringBuilder 600
      [void][DT]::GetWindowTextW($h, $sb, 600)
      $t = $sb.ToString()
      if ($t -like "*$Match*") { [void]$found.Add([pscustomobject]@{ Handle = $h; Title = $t }) }
    }
    return $true
  }
  [void][DT]::EnumWindows($cb, [IntPtr]::Zero)
  if ($found.Count -eq 0) { throw "No window whose title contains '$Match'. Is DevTools open and undocked?" }
  return $found[0]
}

<#
.SYNOPSIS
  Evaluate an expression in the DevTools console and return its result.
.DESCRIPTION
  The expression is wrapped so its value is JSON-stringified into the clipboard,
  and errors come back as "ERROR: ...". Keep $Code to a single expression - a large
  multi-line paste is exactly what failed before, so load big scripts once by hand
  and call into them from here.
#>
function Invoke-DevToolsJS {
  param(
    [Parameter(Mandatory)][string]$Code,
    [int]$TimeoutMs = 20000,
    [switch]$Raw
  )
  $dt = Get-DevToolsWindow
  $wrapped = "(()=>{try{const r=($Code);copy(typeof r==='string'?r:JSON.stringify(r));return '(ok)';}catch(e){copy('ERROR: '+(e&&e.message||e));return '(err)';}})()"

  Set-Clipboard -Value $wrapped
  Start-Sleep -Milliseconds 250
  if (-not (Set-WindowForeground -Handle $dt.Handle)) {
    throw "Could not bring DevTools to the foreground; refusing to send keystrokes blind."
  }
  [System.Windows.Forms.SendKeys]::SendWait("^v")
  Start-Sleep -Milliseconds 500
  [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")

  # The pasted code is still on the clipboard. When the expression runs, its own
  # copy() replaces it - so "clipboard still equals what we pasted" means the
  # console never received it.
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 300
    $cb = Get-Clipboard -Raw
    if ($cb -ne $wrapped) {
      if ($cb -like 'ERROR: *') { throw "JS error in page: $cb" }
      if ($Raw) { return $cb }
      try { return ($cb | ConvertFrom-Json) } catch { return $cb }
    }
  }
  throw "Console never ran the code (clipboard unchanged after ${TimeoutMs}ms). The paste did not land."
}

# Convenience: is the big extractor still loaded in that console?
function Test-LinexLoaded {
  try { $r = Invoke-DevToolsJS -Code "typeof LINEX" -Raw; return ($r -replace '"','') -eq 'function' -or ($r -replace '"','') -eq 'object' }
  catch { return $false }
}
