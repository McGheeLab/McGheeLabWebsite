# uninstall.ps1 — removes Scientia In Situ from this computer (V3.928). The notebook folder and the lab's copy are kept.
#   From the app (Settings → The lab → Remove…): the app has disconnected this computer and is exiting (-FromApp).
#   From the Start menu: this script asks the running app to disconnect this computer from the lab cloud first.
param([switch]$FromApp)
$ErrorActionPreference = 'Continue'
$Root = Join-Path $env:LOCALAPPDATA 'ScientiaInSitu'
$Port = 8766

if (-not $FromApp) {
  try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/lab/disconnect" -ContentType 'application/json' -Body '{}' -TimeoutSec 20 | Out-Null } catch {}
  try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/lab/quit" -ContentType 'application/json' -Body '{}' -TimeoutSec 5 | Out-Null } catch {}
}
Start-Sleep -Seconds 2
# anything still running from the installed app
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" | Where-Object { $_.CommandLine -like "*ScientiaInSitu\app*" } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }

Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'ScientiaInSitu' -ErrorAction SilentlyContinue
Remove-Item -Path 'HKCU:\Software\Classes\scientia' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path ([Environment]::GetFolderPath('Programs')) 'Scientia In Situ') -Recurse -Force -ErrorAction SilentlyContinue

# the private Python, if the installer put one there
$setup = Join-Path $Root 'python-setup.exe'
if (Test-Path $setup) { Start-Process -FilePath $setup -ArgumentList '/quiet', '/uninstall' -Wait -ErrorAction SilentlyContinue }

$nb = $null
try { $nb = (Get-Content (Join-Path $env:APPDATA 'ScientiaInSitu\config.json') -Raw | ConvertFrom-Json).notebook } catch {}
# the folder itself, once this script has ended
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "timeout /t 3 >nul & rmdir /s /q `"$Root`"" -WindowStyle Hidden
Add-Type -AssemblyName PresentationFramework
[System.Windows.MessageBox]::Show("Scientia In Situ was removed from this computer.`n`nYour notebook folder is kept" + $(if ($nb) { ":`n$nb" } else { '.' }) + "`nThe lab keeps its copy of your notes.", 'Scientia In Situ') | Out-Null
