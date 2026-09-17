<#
.SYNOPSIS
  Drive the LINE for Windows desktop app without stealing the mouse or keyboard.

.DESCRIPTION
  LINE is a Qt app: the whole window is a single native HWND and every widget is
  drawn internally by Qt. That means input can be delivered with PostMessage
  straight to the window - Qt routes it to the right widget by coordinate - so the
  physical cursor never moves and the foreground window never changes.

  Screenshots use PrintWindow(PW_RENDERFULLCONTENT) rather than a screen grab, so
  the capture is correct even when LINE sits behind other windows.

  Known quirk: the main window snaps back to a narrow, chat-list-only layout, so
  the conversation pane and message box are unreachable there. Open-LineChat
  double-clicks a chat row to pop the conversation out into its own window, which
  has a stable layout - work against that window instead.

  PostMessage input and PrintWindow capture both keep working while the Windows
  session is LOCKED. Anything that needs the real keyboard or the foreground
  window does not.

.EXAMPLE
  . "$SkillDir\scripts\line-bridge.ps1"
  $chat = Open-LineChatByName -Name "Alice"
  Save-ComposeShot -Win $chat -Path "$scratch\before.png"   # look before typing
  Post-ClickWindow -Win $chat -X 200 -Y ($chat.H - 151)     # focus the message box
  Post-TextToWindow -Win $chat -Text "hello"                # type, leave unsent
  Save-ComposeShot -Win $chat -Path "$scratch\draft.png"    # confirm the draft
  Post-TextToWindow -Win $chat -Text "" -Send               # press Enter
  Save-ComposeShot -Win $chat -Path "$scratch\sent.png"     # confirm it landed
#>

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  // CharSet.Unicode is essential. The C# default is ANSI (GetWindowTextA), and on a
  // machine whose non-Unicode code page is 1252 every CJK character in a chat
  // window's title comes back as '?', so title comparisons against contact names
  // silently never match.
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

# ---------------------------------------------------------------- window lookup

# Every visible, titled LINE window big enough to be a real one.
function Get-LineWindows {
  [void][Win]::SetProcessDPIAware()
  $ids = @((Get-Process -Name LINE -ErrorAction SilentlyContinue).Id)
  if ($ids.Count -eq 0) { throw "LINE.exe is not running." }
  # The callback runs in its own scope, so accumulate into an ArrayList: `+=` on a
  # plain array would only ever update a local copy and come back empty.
  $acc = New-Object System.Collections.ArrayList
  $cb = [Win+EnumWindowsProc]{
    param($h, $l)
    $q = 0; [void][Win]::GetWindowThreadProcessId($h, [ref]$q)
    if ($ids -contains [int]$q -and [Win]::IsWindowVisible($h)) {
      $t = New-Object System.Text.StringBuilder 300
      [void][Win]::GetWindowText($h, $t, 300)
      $r = New-Object Win+RECT; [void][Win]::GetWindowRect($h, [ref]$r)
      $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
      # A minimised window's rect collapses to ~158x26, so let iconic windows
      # through the size gate or the chat list disappears once it is in the tray.
      if ($t.Length -gt 0 -and (([Win]::IsIconic($h)) -or ($w -gt 300 -and $ht -gt 300))) {
        [void]$acc.Add([pscustomobject]@{
          Handle = $h; Title = $t.ToString()
          X = $r.Left; Y = $r.Top; W = $w; H = $ht
          Minimised = [Win]::IsIconic($h)
        })
      }
    }
    return $true
  }
  [void][Win]::EnumWindows($cb, [IntPtr]::Zero)
  return $acc
}

# The main window (chat list). Restores it if it is minimised to the tray.
# Identified by its title, NOT by the process MainWindowHandle: Windows repoints
# that at whichever LINE window was last activated, so once a chat is popped out
# MainWindowHandle stops meaning "the chat list".
function Get-LineMainWindow {
  [void][Win]::SetProcessDPIAware()
  $main = Get-LineWindows | Where-Object { $_.Title -eq 'LINE' } | Select-Object -First 1
  if (-not $main) {
    $proc = Get-Process -Name LINE -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $proc) { throw "LINE.exe is not running, or has no main window." }
    $h = $proc.MainWindowHandle
    if ([Win]::IsIconic($h)) { [void][Win]::ShowWindow($h, 9); Start-Sleep -Milliseconds 700 }
    $r = New-Object Win+RECT
    [void][Win]::GetWindowRect($h, [ref]$r)
    return [pscustomobject]@{
      Handle = $h; Title = $proc.MainWindowTitle
      X = $r.Left; Y = $r.Top; W = ($r.Right - $r.Left); H = ($r.Bottom - $r.Top)
      Minimised = $false
    }
  }
  if ($main.Minimised) {
    [void][Win]::ShowWindow($main.Handle, 9)   # SW_RESTORE
    Start-Sleep -Milliseconds 700
    $main = Get-LineWindows | Where-Object { $_.Title -eq 'LINE' } | Select-Object -First 1
  }
  return $main
}

# A popped-out conversation window, by its exact title (the contact or group name).
function Get-LineChatWindow {
  param([Parameter(Mandatory)][string]$Title)
  $w = Get-LineWindows | Where-Object { $_.Title -eq $Title } | Select-Object -First 1
  if (-not $w) { throw "No LINE window titled '$Title'. Use Open-LineChat first." }
  return $w
}

# ------------------------------------------------------------------- capturing

# PrintWindow grabs the window's own rendering, so overlap and z-order don't matter.
#
# -Crop @(x,y,w,h) saves only that region. This matters a lot when the screenshot is
# being read back by a model: cost scales with pixel area (roughly w*h/750 tokens),
# so cropping to the compose area costs ~200 tokens instead of ~660 for the window.
function Save-WindowShot {
  param(
    [Parameter(Mandatory)]$Win,
    [Parameter(Mandatory)][string]$Path,
    [int[]]$Crop
  )
  $bmp = New-Object System.Drawing.Bitmap $Win.W, $Win.H
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $ok = [Win]::PrintWindow($Win.Handle, $hdc, 2)   # PW_RENDERFULLCONTENT
  $g.ReleaseHdc($hdc); $g.Dispose()

  if ($Crop -and $Crop.Count -eq 4) {
    $cx = [Math]::Max(0, $Crop[0]); $cy = [Math]::Max(0, $Crop[1])
    $cw = [Math]::Min($Crop[2], $Win.W - $cx); $ch = [Math]::Min($Crop[3], $Win.H - $cy)
    $sub = New-Object System.Drawing.Bitmap $cw, $ch
    $g2 = [System.Drawing.Graphics]::FromImage($sub)
    $g2.DrawImage($bmp, (New-Object System.Drawing.Rectangle 0, 0, $cw, $ch),
                        (New-Object System.Drawing.Rectangle $cx, $cy, $cw, $ch),
                        [System.Drawing.GraphicsUnit]::Pixel)
    $g2.Dispose(); $bmp.Dispose()
    $sub.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png); $sub.Dispose()
    return "{0}|crop {1}x{2}|PrintWindow={3}|{4}" -f $Win.Title, $cw, $ch, $ok, $Path
  }

  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  "{0}|{1}x{2}|PrintWindow={3}|{4}" -f $Win.Title, $Win.W, $Win.H, $ok, $Path
}

# The compose area plus the last couple of bubbles - everything needed to confirm
# what is about to be sent, or that a send landed and cleared the box.
function Save-ComposeShot {
  param([Parameter(Mandatory)]$Win, [Parameter(Mandatory)][string]$Path, [int]$Height = 300)
  Save-WindowShot -Win $Win -Path $Path -Crop @(0, ($Win.H - $Height), $Win.W, $Height)
}

# --------------------------------------------------------------- input (quiet)

function Get-ClientPoint {
  param([Parameter(Mandatory)]$Win, [int]$X, [int]$Y)
  $pt = New-Object Win+POINT
  $pt.X = $Win.X + $X; $pt.Y = $Win.Y + $Y
  [void][Win]::ScreenToClient($Win.Handle, [ref]$pt)
  return $pt
}

function Post-ClickWindow {
  param([Parameter(Mandatory)]$Win, [Parameter(Mandatory)][int]$X,
        [Parameter(Mandatory)][int]$Y, [switch]$Double)
  $pt = Get-ClientPoint -Win $Win -X $X -Y $Y
  $lp = [IntPtr](($pt.Y -shl 16) -bor ($pt.X -band 0xFFFF))
  [void][Win]::PostMessage($Win.Handle, 0x0200, [IntPtr]0, $lp)   # WM_MOUSEMOVE
  Start-Sleep -Milliseconds 120
  [void][Win]::PostMessage($Win.Handle, 0x0201, [IntPtr]1, $lp)   # WM_LBUTTONDOWN
  Start-Sleep -Milliseconds 60
  [void][Win]::PostMessage($Win.Handle, 0x0202, [IntPtr]0, $lp)   # WM_LBUTTONUP
  if ($Double) {
    Start-Sleep -Milliseconds 60
    [void][Win]::PostMessage($Win.Handle, 0x0203, [IntPtr]1, $lp) # WM_LBUTTONDBLCLK
    [void][Win]::PostMessage($Win.Handle, 0x0202, [IntPtr]0, $lp)
  }
  Start-Sleep -Milliseconds 600
  "clicked client ({0},{1}) of '{2}'" -f $pt.X, $pt.Y, $Win.Title
}

# WM_MOUSEWHEEL wants SCREEN coordinates in lParam, unlike the button messages.
function Post-ScrollWindow {
  param([Parameter(Mandatory)]$Win, [Parameter(Mandatory)][int]$X,
        [Parameter(Mandatory)][int]$Y, [int]$Notches = 3)
  if ($Notches -eq 0) { return "nothing to scroll" }
  $lp = [IntPtr]((($Win.Y + $Y) -shl 16) -bor (($Win.X + $X) -band 0xFFFF))
  $step = [int]($Notches / [Math]::Abs($Notches))    # positive scrolls up
  for ($i = 0; $i -lt [Math]::Abs($Notches); $i++) {
    [void][Win]::PostMessage($Win.Handle, 0x020A, [IntPtr](([int]($step * 120)) -shl 16), $lp)
    Start-Sleep -Milliseconds 130
  }
  Start-Sleep -Milliseconds 400
  "scrolled $Notches notches"
}

# WM_CHAR carries UTF-16 code units, so CJK goes through as-is - no IME, no SendKeys
# escaping. Click the message box first so Qt gives it focus. -Send appends Enter.
function Post-TextToWindow {
  param([Parameter(Mandatory)]$Win, [Parameter(Mandatory)][string]$Text, [switch]$Send)
  foreach ($ch in $Text.ToCharArray()) {
    [void][Win]::PostMessage($Win.Handle, 0x0102, [IntPtr][int]$ch, [IntPtr]1)
    Start-Sleep -Milliseconds 25
  }
  Start-Sleep -Milliseconds 300
  if ($Send) {
    [void][Win]::PostMessage($Win.Handle, 0x0100, [IntPtr]0x0D, [IntPtr]1)   # WM_KEYDOWN VK_RETURN
    Start-Sleep -Milliseconds 60
    [void][Win]::PostMessage($Win.Handle, 0x0101, [IntPtr]0x0D, [IntPtr]1)   # WM_KEYUP
    Start-Sleep -Milliseconds 600
  }
  "typed {0} chars into '{1}' (sent={2})" -f $Text.Length, $Win.Title, [bool]$Send
}

function Clear-LineInput {
  param([Parameter(Mandatory)]$Win, [int]$Count = 200)
  for ($i = 0; $i -lt $Count; $i++) {
    [void][Win]::PostMessage($Win.Handle, 0x0100, [IntPtr]0x08, [IntPtr]1)   # VK_BACK
    [void][Win]::PostMessage($Win.Handle, 0x0101, [IntPtr]0x08, [IntPtr]1)
    Start-Sleep -Milliseconds 15
  }
  Start-Sleep -Milliseconds 300
  "cleared input of '$($Win.Title)'"
}

# ------------------------------------------------------------------- workflows

# Double-click a chat row in the main window to pop it out into its own window.
# RowY is the row's y offset inside the main window; read it off a screenshot.
function Open-LineChat {
  param([Parameter(Mandatory)][int]$RowY, [int]$RowX = 300, [string]$ExpectTitle)
  $main = Get-LineMainWindow
  if ($ExpectTitle) {
    $existing = Get-LineWindows | Where-Object { $_.Title -eq $ExpectTitle } | Select-Object -First 1
    if ($existing) { return $existing }
  }
  $before = @(Get-LineWindows | ForEach-Object { $_.Handle })
  [void](Post-ClickWindow -Win $main -X $RowX -Y $RowY -Double)
  # LINE can take a few seconds to create the window and set its title, so poll
  # rather than sleeping once and giving up.
  $w = $null
  foreach ($poll in 1..20) {
    Start-Sleep -Milliseconds 300
    $new = Get-LineWindows | Where-Object { $before -notcontains $_.Handle }
    if ($ExpectTitle) { $new = $new | Where-Object { $_.Title -eq $ExpectTitle } }
    $w = $new | Select-Object -First 1
    if ($w) { break }
  }
  if (-not $w) { throw "No chat window opened. Check RowY against a fresh screenshot." }
  return $w
}

# --------------------------------------------------------------- chat export

# Qt popup menus are separate, untitled top-level windows, so they are invisible
# to Get-LineWindows. Find one by diffing against the windows we already know.
function Find-LinePopup {
  param([Parameter(Mandatory)]$ExcludeHandles)
  [void][Win]::SetProcessDPIAware()
  $ids = @((Get-Process -Name LINE -ErrorAction SilentlyContinue).Id)
  $acc = New-Object System.Collections.ArrayList
  $cb = [Win+EnumWindowsProc]{
    param($h, $l)
    $q = 0; [void][Win]::GetWindowThreadProcessId($h, [ref]$q)
    if ($ids -contains [int]$q -and [Win]::IsWindowVisible($h) -and $ExcludeHandles -notcontains $h) {
      $r = New-Object Win+RECT; [void][Win]::GetWindowRect($h, [ref]$r)
      $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
      if ($w -gt 60 -and $ht -gt 60) {
        [void]$acc.Add([pscustomobject]@{ Handle=$h; Title='popup'; X=$r.Left; Y=$r.Top; W=$w; H=$ht })
      }
    }
    return $true
  }
  [void][Win]::EnumWindows($cb, [IntPtr]::Zero)
  return $acc
}

# Qt will not raise a popup menu for a window that is not active, so this is the
# one step of the export that has to take focus. It takes focus only, never the
# mouse - the cursor stays wherever the user left it.
function Set-LineForeground {
  param([Parameter(Mandatory)]$Win)
  if (-not ('FgHelper' -as [type])) {
    Add-Type @"
using System; using System.Runtime.InteropServices;
public class FgHelper { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }
"@
  }
  [void][FgHelper]::SetForegroundWindow($Win.Handle)
  Start-Sleep -Milliseconds 500
}

# Open a chat's "..." menu and return the popup window.
function Open-LineChatMenu {
  param([Parameter(Mandatory)]$Win, [int]$MenuX = 531, [int]$MenuY = 87, [int]$Attempts = 3)
  $known = @(Get-LineWindows | ForEach-Object { $_.Handle })
  foreach ($try in 1..$Attempts) {
    Set-LineForeground -Win $Win
    [void](Post-ClickWindow -Win $Win -X $MenuX -Y $MenuY)
    foreach ($poll in 1..10) {
      Start-Sleep -Milliseconds 300
      $popup = Find-LinePopup -ExcludeHandles $known | Select-Object -First 1
      if ($popup) { return $popup }
    }
    Start-Sleep -Milliseconds 800
  }
  throw "The chat menu would not open after $Attempts attempts."
}

# Drive LINE's own "Save chat" export to a path of our choosing. This yields the
# real message text - no screenshots, no OCR.
#
# MenuItemY is the "Save chat" row inside the popup. A one-to-one chat's menu is
# 285x669 and puts it at y=403; a group chat's menu has more rows, so capture the
# popup once (Save-WindowShot) and pass the measured offset.
function Export-LineChat {
  param(
    [Parameter(Mandatory)]$Win,
    [Parameter(Mandatory)][string]$Path,
    [int]$MenuItemY = 403,
    [int]$MenuItemX = 140
  )
  if (-not ('Dlg' -as [type])) {
    Add-Type @"
using System; using System.Runtime.InteropServices;
public class Dlg {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr wp, string lp);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
}
"@
  }
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  if (Test-Path $Path) { Remove-Item $Path -Force }

  $popup = Open-LineChatMenu -Win $Win
  if ($popup.H -lt ($MenuItemY + 20)) {
    throw ("Menu is {0}x{1}; 'Save chat' is not at y={2}. Capture it and pass -MenuItemY." -f $popup.W, $popup.H, $MenuItemY)
  }
  [void](Post-ClickWindow -Win $popup -X $MenuItemX -Y $MenuItemY)

  # Wait for the standard Save As dialog (#32770) that LINE opens.
  $dlg = [IntPtr]::Zero
  foreach ($poll in 1..20) {
    Start-Sleep -Milliseconds 300
    $ids = @((Get-Process -Name LINE).Id)
    $found = [IntPtr]::Zero
    $cb = [Win+EnumWindowsProc]{
      param($h, $l)
      if ([Win]::IsWindowVisible($h)) {
        $q = 0; [void][Win]::GetWindowThreadProcessId($h, [ref]$q)
        if ($ids -contains [int]$q) {
          $c = New-Object System.Text.StringBuilder 200
          [void][Win]::GetClassName($h, $c, 200)
          if ($c.ToString() -eq '#32770') { $script:foundDlg = $h }
        }
      }
      return $true
    }
    $script:foundDlg = [IntPtr]::Zero
    [void][Win]::EnumWindows($cb, [IntPtr]::Zero)
    if ($script:foundDlg -ne [IntPtr]::Zero) { $dlg = $script:foundDlg; break }
  }
  if ($dlg -eq [IntPtr]::Zero) { throw "LINE did not open a Save As dialog." }

  # The dialog is a native Win32 one, so unlike LINE itself it has real UIA.
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($dlg)
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
                       [System.Windows.Automation.Condition]::TrueCondition)
  $hEdit = [IntPtr]::Zero; $hBtn = [IntPtr]::Zero
  foreach ($i in 0..($all.Count - 1)) {
    $e = $all.Item($i)
    if ($e.Current.ClassName -eq 'Edit' -and $e.Current.AutomationId -eq '1001' -and $hEdit -eq [IntPtr]::Zero) {
      $hEdit = [IntPtr]$e.Current.NativeWindowHandle
    }
    if ($e.Current.ClassName -eq 'Button' -and $e.Current.AutomationId -eq '1' -and $hBtn -eq [IntPtr]::Zero) {
      $hBtn = [IntPtr]$e.Current.NativeWindowHandle
    }
  }
  if ($hEdit -eq [IntPtr]::Zero -or $hBtn -eq [IntPtr]::Zero) {
    throw "Could not locate the filename box or Save button in the dialog."
  }

  [void][Dlg]::SendMessageW($hEdit, 0x000C, [IntPtr]::Zero, $Path)          # WM_SETTEXT
  Start-Sleep -Milliseconds 400
  [void][Dlg]::SendMessage($hBtn, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)   # BM_CLICK

  foreach ($poll in 1..20) {
    Start-Sleep -Milliseconds 300
    if (Test-Path $Path) { break }
  }
  if (-not (Test-Path $Path)) { throw "Save dialog accepted but no file appeared at $Path." }
  $f = Get-Item $Path
  "exported {0} ({1} bytes)" -f $f.FullName, $f.Length
}

# --------------------------------------------------------- session / workflows

# True when the Windows session is locked. While locked, PostMessage input and
# PrintWindow capture still work (so the desktop-app path is usable), but nothing
# can take the foreground, so SendKeys and the DevTools bridge cannot work.
# Heuristic: the lock screen is hosted by LockApp.exe, and the secure desktop
# (Ctrl+Alt+Del) leaves no foreground window at all.
function Test-SessionLocked {
  $fg = [Win]::GetForegroundWindow()
  if ($fg -eq [IntPtr]::Zero) { return $true }
  $procId = 0
  [void][Win]::GetWindowThreadProcessId($fg, [ref]$procId)
  $name = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
  return ($name -eq 'LockApp')
}

# Type a name into the chat-list search box and save a crop of the results, so the
# first hit can be checked before anything is opened. Opening a chat marks its
# messages read, so an ambiguous name (a common word, a group sharing part of the
# name) is worth this ~200-token look first.
#
# Coordinates are for the default 546px-wide chat list; if the main window is a
# different width, capture it and pass the search box position explicitly.
function Find-LineChat {
  param(
    [Parameter(Mandatory)][string]$Name,
    [string]$PreviewPath,
    [int]$SearchX = 295, [int]$SearchY = 123
  )
  $main = Get-LineMainWindow
  [void](Post-ClickWindow -Win $main -X $SearchX -Y $SearchY)
  [void](Clear-LineInput -Win $main -Count 40)
  [void](Post-TextToWindow -Win $main -Text $Name)
  Start-Sleep -Milliseconds 1500
  if ($PreviewPath) {
    return Save-WindowShot -Win (Get-LineMainWindow) -Path $PreviewPath -Crop @(90, 90, ($main.W - 90), 330)
  }
  return "searched for '$Name'"
}

# Search, open the first result as a pop-out window, and confirm its title is the
# name asked for. Returns the chat window. Reuses an already-open pop-out.
function Open-LineChatByName {
  param(
    [Parameter(Mandatory)][string]$Name,
    [int]$ResultX = 300, [int]$ResultY = 250
  )
  $existing = Get-LineWindows | Where-Object { $_.Title -eq $Name } | Select-Object -First 1
  if ($existing) { return $existing }
  [void](Find-LineChat -Name $Name)
  $w = Open-LineChat -RowY $ResultY -RowX $ResultX
  if ($w.Title -ne $Name) {
    throw ("Opened '{0}', not '{1}': the first search result is a different chat. " +
           "Run Find-LineChat -PreviewPath to see the results and pass -ResultY.") -f $w.Title, $Name
  }
  return $w
}

# Press Enter in a chat window. Deliberately NOT paired with Escape: with no popup
# open, Escape closes the pop-out chat window and the Enter then goes nowhere.
# Only press Escape when a compose screenshot actually shows the sticker-suggestion
# panel. Always confirm with Save-ComposeShot afterwards before reporting a send.
function Send-LineEnter {
  param([Parameter(Mandatory)]$Win)
  [void][Win]::PostMessage($Win.Handle, 0x0100, [IntPtr]0x0D, [IntPtr]1)   # WM_KEYDOWN VK_RETURN
  Start-Sleep -Milliseconds 60
  [void][Win]::PostMessage($Win.Handle, 0x0101, [IntPtr]0x0D, [IntPtr]1)   # WM_KEYUP
  Start-Sleep -Milliseconds 1200
  "Enter posted to '$($Win.Title)' - not yet verified"
}

# Dismiss the sticker-suggestion panel. Only call this when a screenshot shows the
# panel is open; see Send-LineEnter for why.
function Close-LineStickerSuggestion {
  param([Parameter(Mandatory)]$Win)
  [void][Win]::PostMessage($Win.Handle, 0x0100, [IntPtr]0x1B, [IntPtr]1)   # VK_ESCAPE
  [void][Win]::PostMessage($Win.Handle, 0x0101, [IntPtr]0x1B, [IntPtr]1)
  Start-Sleep -Milliseconds 600
  "Escape posted to '$($Win.Title)'"
}

# Cursor position and foreground window, to prove a run stayed out of the way.
function Get-InputState {
  [void][Win]::SetProcessDPIAware()
  $c = [System.Windows.Forms.Cursor]::Position
  [pscustomobject]@{ CursorX = $c.X; CursorY = $c.Y; Foreground = [Win]::GetForegroundWindow() }
}
