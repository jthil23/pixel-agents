# scripts/home-ai/install.ps1 — run from an elevated PowerShell (firewall rule needs admin)
param(
  [switch]$ResetLayout
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'install.ps1 must run from an elevated PowerShell (Run as administrator): it registers a scheduled task and a firewall rule.'
}

$config = Join-Path $env:USERPROFILE '.pixel-agents\home-ai.json'
$configData = if (Test-Path $config) { Get-Content $config -Raw | ConvertFrom-Json } else { $null }
$passcodeSet = [bool]$configData.passcodeHash
if (-not $passcodeSet) {
  throw "No passcode in $config. Run 'node dist\cli.js set-passcode' from the repo root first, then rerun install.ps1."
}
$port = if ($null -ne $configData.listen -and $null -ne $configData.listen.port) { [int]$configData.listen.port } else { 3100 }

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$node = (Get-Command node -ErrorAction Stop).Source
$log = Join-Path $env:USERPROFILE '.pixel-agents\pixel-office.log'
$state = Join-Path $env:USERPROFILE '.pixel-agents'
New-Item -ItemType Directory -Force -Path $state | Out-Null

# Preserve Layout-editor changes unless the file is missing, not a home-ai layout, or reset was requested.
$layout = Join-Path $state 'layout.json'
$installLayout = $ResetLayout -or -not (Test-Path $layout)
if (-not $installLayout) {
  try {
    $existingLayout = Get-Content $layout -Raw | ConvertFrom-Json -ErrorAction Stop
    $hasMailroom = @($existingLayout.areas | Where-Object { $_.label -eq 'Mailroom' }).Count -gt 0 -or
      @($existingLayout.areaTiles | Where-Object { $_ -eq 'Mailroom' }).Count -gt 0
    $installLayout = -not $hasMailroom
  } catch {
    $installLayout = $true
  }
}
if ($installLayout) {
  if (Test-Path $layout) { Copy-Item $layout "$layout.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" }
  Copy-Item (Join-Path $root 'dist\assets\home-ai-layout.json') $layout -Force
} else {
  Write-Host 'Keeping existing home-ai layout'
}

# Scheduled task: node.exe is the task's own process (supervised), hidden via S4U, one instance only.
$action = New-ScheduledTaskAction -Execute $node -Argument "dist\cli.js --home-ai --log `"$log`"" -WorkingDirectory $root
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# An empty repetition duration means indefinite recurrence; StartWhenAvailable catches a repetition missed during reboot, including while logged off under S4U.
$watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Pixel Office' -Action $action -Trigger @($logonTrigger, $watchdogTrigger) -Principal $principal -Settings $settings -Description 'Pixel Office (home-ai) LAN dashboard' -Force | Out-Null

# Firewall: LAN (Private profile) only; keep it aligned with listen.port.
$firewallRule = Get-NetFirewallRule -DisplayName 'Pixel Office (Private)' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $firewallRule) {
  New-NetFirewallRule -DisplayName 'Pixel Office (Private)' -Direction Inbound -Protocol TCP -LocalPort $port -Profile Private -Action Allow | Out-Null
} else {
  $portFilter = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $firewallRule
  if (@($portFilter.LocalPort) -notcontains "$port") {
    Set-NetFirewallPortFilter -InputObject $portFilter -LocalPort $port | Out-Null
  }
}
Write-Host 'Pixel Office firewall allows TCP port' $port 'on the Private profile.'
Start-ScheduledTask -TaskName 'Pixel Office'
Write-Host 'Pixel Office installed. Log:' (Join-Path $state 'pixel-office.log')
