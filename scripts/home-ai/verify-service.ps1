[CmdletBinding()]
param(
  [string]$TaskName = 'Pixel Office',
  [int]$Port = 0,
  [string]$LogPath = (Join-Path $env:USERPROFILE '.pixel-agents\pixel-office.log')
)

$ErrorActionPreference = 'Stop'
$script:Checks = New-Object 'System.Collections.Generic.List[object]'
$script:PortToCheck = 3100
$portReady = $false

function Add-Check {
  param(
    [string]$Name,
    [bool]$Passed,
    [string]$Details = ''
  )

  $null = $script:Checks.Add([pscustomobject]@{ Name = $Name; Passed = $Passed })
  $status = if ($Passed) { 'PASS' } else { 'FAIL' }
  if ($Details) {
    Write-Host ("{0}: {1} ({2})" -f $status, $Name, $Details)
  } else {
    Write-Host ("{0}: {1}" -f $status, $Name)
  }
}

function Resolve-Port {
  if ($Port -eq 0) {
    $configPath = Join-Path $env:USERPROFILE '.pixel-agents\home-ai.json'
    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
      $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json -ErrorAction Stop
      if ($null -ne $config.listen -and $null -ne $config.listen.port) {
        $resolved = [int]$config.listen.port
      } else {
        $resolved = 3100
      }
    } else {
      $resolved = 3100
    }
  } else {
    $resolved = $Port
  }

  if ($resolved -lt 1 -or $resolved -gt 65535) {
    throw 'Invalid listening port.'
  }
  return $resolved
}

function Get-PortSnapshot {
  $connections = @(Get-NetTCPConnection -State Listen -LocalPort $script:PortToCheck -ErrorAction SilentlyContinue)
  $pids = @($connections | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)
  $homeAiPid = $null
  if ($pids.Count -eq 1) {
    $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$($pids[0])" -ErrorAction SilentlyContinue
    if ($null -ne $process -and $null -ne $process.CommandLine -and
      $process.CommandLine.IndexOf('--home-ai', [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $homeAiPid = [int]$pids[0]
    }
  }
  return [pscustomobject]@{ ListenerPids = $pids; HomeAiPid = $homeAiPid }
}

function Wait-ForHomeAiListener {
  param(
    [int]$TimeoutSeconds,
    [int]$PollSeconds,
    [int]$ExpectedPid = 0,
    [int]$DifferentFromPid = 0
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $snapshot = Get-PortSnapshot
    if ($snapshot.ListenerPids.Count -eq 1 -and $null -ne $snapshot.HomeAiPid -and
      ($ExpectedPid -eq 0 -or $snapshot.HomeAiPid -eq $ExpectedPid) -and
      ($DifferentFromPid -eq 0 -or $snapshot.HomeAiPid -ne $DifferentFromPid)) {
      return $snapshot
    }
    if ([DateTime]::UtcNow -ge $deadline) { break }
    Start-Sleep -Seconds $PollSeconds
  } while ($true)
  return $null
}

function Wait-ForNoListener {
  param(
    [int]$TimeoutSeconds,
    [int]$PollSeconds
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $snapshot = Get-PortSnapshot
    if ($snapshot.ListenerPids.Count -eq 0) { return $true }
    if ([DateTime]::UtcNow -ge $deadline) { break }
    Start-Sleep -Seconds $PollSeconds
  } while ($true)
  return $false
}

function Test-LogContains {
  param([string]$Text)

  if (-not (Test-Path -LiteralPath $LogPath -PathType Leaf)) { return $false }
  try {
    return [bool](Select-String -LiteralPath $LogPath -SimpleMatch -Pattern $Text -Quiet -ErrorAction Stop)
  } catch {
    return $false
  }
}

try {
  try {
    $script:PortToCheck = Resolve-Port
    $portReady = $true
    Add-Check -Name 'Configured port' -Passed $true -Details ("TCP {0}" -f $script:PortToCheck)
  } catch {
    Add-Check -Name 'Configured port' -Passed $false -Details 'Could not read a valid listen.port value.'
  }

  if ($portReady) {
    $initial = $null
    try {
      $initial = Get-PortSnapshot
      if ($initial.ListenerPids.Count -eq 0) {
        Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        $initial = Wait-ForHomeAiListener -TimeoutSeconds 30 -PollSeconds 1
      }
    } catch {
      $initial = $null
    }

    $oneListener = $null -ne $initial -and $initial.ListenerPids.Count -eq 1
    $homeAiOwner = $oneListener -and $null -ne $initial.HomeAiPid
    Add-Check -Name ("Exactly one listener on TCP {0}" -f $script:PortToCheck) -Passed $oneListener
    Add-Check -Name 'Listener process command line contains --home-ai' -Passed $homeAiOwner

    if ($homeAiOwner) {
      $initialPid = [int]$initial.HomeAiPid

      $duplicateStartOk = $false
      try {
        Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        $duplicate = Wait-ForHomeAiListener -TimeoutSeconds 15 -PollSeconds 1 -ExpectedPid $initialPid
        $duplicateStartOk = $null -ne $duplicate
      } catch { }
      Add-Check -Name 'Duplicate start keeps one listener and the same PID' -Passed $duplicateStartOk

      $stopped = $false
      try {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        $stopped = Wait-ForNoListener -TimeoutSeconds 15 -PollSeconds 1
      } catch { }
      Add-Check -Name 'Stop leaves zero listeners' -Passed $stopped

      $started = $null
      try {
        Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        $started = Wait-ForHomeAiListener -TimeoutSeconds 30 -PollSeconds 1 -DifferentFromPid $initialPid
      } catch { }
      $newPid = $null -ne $started
      Add-Check -Name 'Start restores one listener with a new PID' -Passed $newPid

      $recovered = $null
      if ($newPid) {
        $killedPid = [int]$started.HomeAiPid
        try {
          Stop-Process -Id $killedPid -Force -ErrorAction Stop
          $recovered = Wait-ForHomeAiListener -TimeoutSeconds 90 -PollSeconds 5 -DifferentFromPid $killedPid
        } catch { }
      }
      Add-Check -Name 'Killed service recovers within 90 seconds (5-second polling)' -Passed ($null -ne $recovered)
    } else {
      Add-Check -Name 'Duplicate start keeps one listener and the same PID' -Passed $false -Details 'Not run: no single --home-ai listener was verified.'
      Add-Check -Name 'Stop leaves zero listeners' -Passed $false -Details 'Not run: no single --home-ai listener was verified.'
      Add-Check -Name 'Start restores one listener with a new PID' -Passed $false -Details 'Not run: no single --home-ai listener was verified.'
      Add-Check -Name 'Killed service recovers within 90 seconds (5-second polling)' -Passed $false -Details 'Not run: no single --home-ai listener was verified.'
    }
  } else {
    Add-Check -Name 'Exactly one listener on configured port' -Passed $false -Details 'Not run: port configuration is unavailable.'
    Add-Check -Name 'Listener process command line contains --home-ai' -Passed $false -Details 'Not run: port configuration is unavailable.'
    Add-Check -Name 'Duplicate start keeps one listener and the same PID' -Passed $false -Details 'Not run: port configuration is unavailable.'
    Add-Check -Name 'Stop leaves zero listeners' -Passed $false -Details 'Not run: port configuration is unavailable.'
    Add-Check -Name 'Start restores one listener with a new PID' -Passed $false -Details 'Not run: port configuration is unavailable.'
    Add-Check -Name 'Killed service recovers within 90 seconds (5-second polling)' -Passed $false -Details 'Not run: port configuration is unavailable.'
  }
} catch {
  Add-Check -Name 'Verification sequence completed' -Passed $false -Details 'Unexpected error stopped the service checks.'
} finally {
  $serviceRunning = $false
  if ($portReady) {
    try {
      $state = Get-PortSnapshot
      if ($state.ListenerPids.Count -eq 0) {
        $state = Wait-ForHomeAiListener -TimeoutSeconds 5 -PollSeconds 1
        if ($null -eq $state) {
          Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
          $state = Wait-ForHomeAiListener -TimeoutSeconds 90 -PollSeconds 5
        }
      }
      $serviceRunning = $null -ne $state -and $state.ListenerPids.Count -eq 1 -and $null -ne $state.HomeAiPid
    } catch { }
  }
  Add-Check -Name 'Service is running at end' -Passed $serviceRunning
}

Add-Check -Name "Log contains 'HA token'" -Passed (Test-LogContains -Text 'HA token')
Add-Check -Name "Log contains 'Pixel Office running'" -Passed (Test-LogContains -Text 'Pixel Office running')

$passedCount = @($script:Checks | Where-Object { $_.Passed }).Count
$failedCount = $script:Checks.Count - $passedCount
Write-Host ("Summary: {0} passed, {1} failed." -f $passedCount, $failedCount)
if ($failedCount -gt 0) { exit 1 }
exit 0
