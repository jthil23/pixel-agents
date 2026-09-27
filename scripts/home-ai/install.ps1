# scripts/home-ai/install.ps1 — run from an elevated PowerShell (firewall rule needs admin)
$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'install.ps1 must run from an elevated PowerShell (Run as administrator): it registers a scheduled task and a firewall rule.'
}

$config = Join-Path $env:USERPROFILE '.pixel-agents\home-ai.json'
$passcodeSet = (Test-Path $config) -and [bool](Get-Content $config -Raw | ConvertFrom-Json).passcodeHash
if (-not $passcodeSet) {
  throw "No passcode in $config. Run 'node dist\cli.js set-passcode' from the repo root first, then rerun install.ps1."
}

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$node = (Get-Command node -ErrorAction Stop).Source
$log = Join-Path $env:USERPROFILE '.pixel-agents\pixel-office.log'
$state = Join-Path $env:USERPROFILE '.pixel-agents'
New-Item -ItemType Directory -Force -Path $state | Out-Null

# Layout: install once, keeping a backup of any existing layout.
$layout = Join-Path $state 'layout.json'
if (Test-Path $layout) { Copy-Item $layout "$layout.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" }
Copy-Item (Join-Path $root 'dist\assets\home-ai-layout.json') $layout -Force

# Scheduled task: node.exe is the task's own process (supervised), hidden via S4U, one instance only.
$action = New-ScheduledTaskAction -Execute $node -Argument "dist\cli.js --home-ai --log `"$log`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Pixel Office' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Pixel Office (home-ai) LAN dashboard' -Force | Out-Null

# Firewall: LAN (Private profile) only.
if (-not (Get-NetFirewallRule -DisplayName 'Pixel Office (Private)' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'Pixel Office (Private)' -Direction Inbound -Protocol TCP -LocalPort 3100 -Profile Private -Action Allow | Out-Null
}
Start-ScheduledTask -TaskName 'Pixel Office'
Write-Host 'Pixel Office installed. Log:' (Join-Path $state 'pixel-office.log')
