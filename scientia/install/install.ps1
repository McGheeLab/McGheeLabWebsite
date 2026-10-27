# install.ps1 — Scientia In Situ on this Windows computer, for this user only (V3.928). No administrator needed.
#   • the app goes to %LOCALAPPDATA%\ScientiaInSitu\app (an older copy there is replaced; notes are never here)
#   • Python: one already on this computer (3.9+, with tkinter for the folder dialog), else the official installer,
#     silently, into %LOCALAPPDATA%\ScientiaInSitu\python
#   • starts with Windows (HKCU\...\Run), so this computer and the lab cloud stay in step from login to shutdown
#   • scientia:// links start it (the lab site's "Open on my computer" button), and a Start menu entry opens it
#   • the notebook folder stays where it is (%APPDATA%\ScientiaInSitu\config.json); a new user gets Documents\Scientia Notebook
# Uninstall: Settings → The lab → Remove Scientia from this computer, or "Uninstall Scientia" in the Start menu.
param([string]$From = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PyVersion = '3.13.1'
$Root = Join-Path $env:LOCALAPPDATA 'ScientiaInSitu'
$App = Join-Path $Root 'app'
$Cfg = Join-Path $env:APPDATA 'ScientiaInSitu'
$Port = 8766

function Say($m) { Write-Host "  $m" }
function Ping-App { try { $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/lab/ping" -TimeoutSec 2; return ($r.app -eq 'scientia-in-situ') } catch { return $false } }

Write-Host ''
Write-Host 'Scientia In Situ — installing for' $env:USERNAME
if (-not (Test-Path (Join-Path $From 'app\serve.py'))) {
  Write-Host ''
  Write-Host '  The installer cannot see its files. Right-click the downloaded zip → Extract All…, then run "Install Scientia" from the extracted folder.' -ForegroundColor Yellow
  exit 2
}

# 1. stop a copy of the app that is already running (this one, or an older launch.bat)
try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/lab/quit" -TimeoutSec 3 | Out-Null; Start-Sleep -Seconds 1 } catch {}
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { try { Stop-Process -Id $_.OwningProcess -Force } catch {} }

# 2. the app
Say 'Copying the app…'
New-Item -ItemType Directory -Force $App | Out-Null
Get-ChildItem $App -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -notin @('images', 'recordings', 'backup') } | Remove-Item -Recurse -Force
Copy-Item (Join-Path $From 'app\*') $App -Recurse -Force
Copy-Item (Join-Path $From 'uninstall.ps1') (Join-Path $Root 'uninstall.ps1') -Force
Get-ChildItem $Root -Recurse -File | Unblock-File -ErrorAction SilentlyContinue

# 3. Python
function Find-Python {
  $cands = @()
  $own = Join-Path $Root 'python\pythonw.exe'; if (Test-Path $own) { $cands += $own }
  try { $p = (& py -3 -c "import sys; print(sys.executable)" 2>$null); if ($p) { $cands += (Join-Path (Split-Path $p) 'pythonw.exe') } } catch {}
  try { $p = (Get-Command python.exe -ErrorAction SilentlyContinue).Source; if ($p -and $p -notmatch 'WindowsApps') { $cands += (Join-Path (Split-Path $p) 'pythonw.exe') } } catch {}
  foreach ($c in $cands) {
    if (-not (Test-Path $c)) { continue }
    $exe = Join-Path (Split-Path $c) 'python.exe'
    try { $ok = (& $exe -c "import sys, tkinter; print(1 if sys.version_info >= (3, 9) else 0)" 2>$null); if ($ok -eq '1') { return $c } } catch {}
  }
  return $null
}
$Pyw = Find-Python
if (-not $Pyw) {
  Say "Installing Python $PyVersion for Scientia (once, about a minute)…"
  $setup = Join-Path $Root 'python-setup.exe'
  Invoke-WebRequest -Uri "https://www.python.org/ftp/python/$PyVersion/python-$PyVersion-amd64.exe" -OutFile $setup
  $pyArgs = @('/quiet', 'InstallAllUsers=0', "TargetDir=$(Join-Path $Root 'python')", 'Include_launcher=0', 'Include_test=0', 'Include_doc=0', 'Include_dev=0', 'Include_pip=0', 'Shortcuts=0', 'AssociateFiles=0', 'PrependPath=0')
  $p = Start-Process -FilePath $setup -ArgumentList $pyArgs -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "Python setup ended with code $($p.ExitCode)" }
  $Pyw = Join-Path $Root 'python\pythonw.exe'
}
Say "Python: $Pyw"
Set-Content -Path (Join-Path $Root 'python.txt') -Value $Pyw -Encoding UTF8

# 4. the notebook folder (kept if one is chosen already)
New-Item -ItemType Directory -Force $Cfg | Out-Null
$cfgFile = Join-Path $Cfg 'config.json'
$nb = $null
if (Test-Path $cfgFile) { try { $nb = (Get-Content $cfgFile -Raw | ConvertFrom-Json).notebook } catch {} }
if (-not $nb -or -not (Test-Path $nb)) {
  $nb = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Scientia Notebook'
  New-Item -ItemType Directory -Force $nb | Out-Null
  @{ notebook = $nb; recent = @($nb) } | ConvertTo-Json | Set-Content -Path $cfgFile -Encoding UTF8
}
Say "Notebook folder: $nb"

# 5. starts with Windows; scientia:// links; Start menu
$service = "`"$Pyw`" `"$(Join-Path $App 'service.py')`""
New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'ScientiaInSitu' -Value $service -PropertyType String -Force | Out-Null
$k = 'HKCU:\Software\Classes\scientia'
New-Item -Path "$k\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path $k -Name '(default)' -Value 'URL:Scientia In Situ'
New-ItemProperty -Path $k -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
Set-ItemProperty -Path "$k\shell\open\command" -Name '(default)' -Value "`"$Pyw`" `"$(Join-Path $App 'open_local.py')`" `"%1`""
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Scientia In Situ'
New-Item -ItemType Directory -Force $menu | Out-Null
Set-Content -Path (Join-Path $menu 'Scientia In Situ.url') -Value "[InternetShortcut]`r`nURL=scientia://open`r`n" -Encoding ASCII
$sh = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $menu 'Uninstall Scientia.lnk'))
$sh.TargetPath = 'powershell.exe'; $sh.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $Root 'uninstall.ps1')`""; $sh.Save()

# 6. start it now, then open it
Say 'Starting Scientia…'
Start-Process -FilePath $Pyw -ArgumentList "`"$(Join-Path $App 'service.py')`"" -WindowStyle Hidden
for ($i = 0; $i -lt 40 -and -not (Ping-App); $i++) { Start-Sleep -Milliseconds 500 }
if (-not (Ping-App)) { Write-Host '  Scientia did not start. See' (Join-Path $Root 'service.log') -ForegroundColor Yellow; exit 1 }
$st = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/lab/ping" -TimeoutSec 3
$open = if ($st.connected) { "http://localhost:$Port/scientia.html" } else { "http://localhost:$Port/scientia.html#/connect" }
Start-Process $open
Write-Host ''
Write-Host '  Done. Scientia starts with Windows from now on; the lab site''s "Open on my computer" opens it.' -ForegroundColor Green
