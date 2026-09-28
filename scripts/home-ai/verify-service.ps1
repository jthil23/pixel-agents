[CmdletBinding()]
param(
  [string]$TaskName = 'Pixel Office',
  [int]$Port = 0,
  [string]$LogPath = (Join-Path $env:USERPROFILE '.pixel-agents\pixel-office.log')
)

$ErrorActionPreference = 'Stop'
$script:Checks = New-Object 'System.Collections.Generic.List[object]'
$script:PortToCheck = 3100
$logMarkers = [pscustomobject]@{ HaToken = $false; Running = $false }
$portReady = $false
function Get-LogLength {
  if (-not (Test-Path -LiteralPath $LogPath -PathType Leaf)) { return 0L }
  return [long](Get-Item -LiteralPath $LogPath).Length
}

function Test-LogContainsAfter {
  param(
    [string]$Text,
    [long]$Offset
  )

  if (-not (Test-Path -LiteralPath $LogPath -PathType Leaf)) { return $false }
  $stream = $null
  $reader = $null
  try {
    $stream = [System.IO.File]::Open($LogPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    if ($stream.Length -le $Offset) { return $false }
    $null = $stream.Seek($Offset, [System.IO.SeekOrigin]::Begin)
    $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $true)
    $stream = $null
    $content = $reader.ReadToEnd()
    return $content.IndexOf($Text, [StringComparison]::OrdinalIgnoreCase) -ge 0
  } catch {
    return $false
  } finally {
    if ($null -ne $reader) { $reader.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
  }
}

function Wait-ForLogMarkers {
  param(
    [long]$Offset,
    [int]$TimeoutSeconds = 15
  )

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $haToken = Test-LogContainsAfter -Text 'HA token' -Offset $Offset
    $running = Test-LogContainsAfter -Text 'Pixel Office running' -Offset $Offset
    if ($haToken -and $running) {
      return [pscustomobject]@{ HaToken = $true; Running = $true }
    }
    if ([DateTime]::UtcNow -ge $deadline) { break }
    Start-Sleep -Seconds 1
  } while ($true)
  return [pscustomobject]@{ HaToken = $haToken; Running = $running }
}

function Get-FailureDetails {
  param(
    [string]$ErrorMessage,
    [string]$Fallback
  )
  if ($ErrorMessage) { return $ErrorMessage }
  return $Fallback
}

function Test-TaskWatchdog {
  param([string]$TaskName)

  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $watchdogs = @($task.Triggers | Where-Object {
    $_.CimClass.CimClassName -eq 'MSFT_TaskTimeTrigger' -and
    $_.Repetition.Interval -eq 'PT1M' -and
    [string]::IsNullOrEmpty([string]$_.Repetition.Duration)
  })
  return $watchdogs.Count -gt 0 -and [bool]$task.Settings.StartWhenAvailable
}


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


try {
  try {
    $script:PortToCheck = Resolve-Port
    $portReady = $true
    Add-Check -Name 'Configured port' -Passed $true -Details ("TCP {0}" -f $script:PortToCheck)
  } catch {
    Add-Check -Name 'Configured port' -Passed $false -Details 'Could not read a valid listen.port value.'
  }

  $watchdogReady = $false
  $watchdogError = ''
  try {
    $watchdogReady = Test-TaskWatchdog -TaskName $TaskName
  } catch { $watchdogError = $_.Exception.Message }
  $watchdogDetails = if ($watchdogReady) { '' } elseif ($watchdogError) { "Re-run install.ps1 elevated. $watchdogError" } else { 'Re-run install.ps1 elevated to add the indefinite one-minute trigger and StartWhenAvailable.' }
  Add-Check -Name 'Task has an indefinite one-minute watchdog and StartWhenAvailable' -Passed $watchdogReady -Details $watchdogDetails

  if ($portReady) {
    $initial = $null
    $initialError = ''
    try {
      $initial = Get-PortSnapshot
      if ($initial.ListenerPids.Count -eq 0) {
        Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        $initial = Wait-ForHomeAiListener -TimeoutSeconds 30 -PollSeconds 1
      }
    } catch {
      $initialError = $_.Exception.Message
      $initial = $null
    }

    $oneListener = $null -ne $initial -and $initial.ListenerPids.Count -eq 1
    $homeAiOwner = $oneListener -and $null -ne $initial.HomeAiPid
    $listenerDetails = if ($oneListener) { '' } else { Get-FailureDetails -ErrorMessage $initialError -Fallback 'Expected exactly one listener.' }
    $ownerDetails = if ($homeAiOwner) { '' } else { Get-FailureDetails -ErrorMessage $initialError -Fallback 'Listener command line did not contain --home-ai.' }
    Add-Check -Name ("Exactly one listener on TCP {0}" -f $script:PortToCheck) -Passed $oneListener -Details $listenerDetails
    Add-Check -Name 'Listener process command line contains --home-ai' -Passed $homeAiOwner -Details $ownerDetails

    if ($homeAiOwner) {
      $initialPid = [int]$initial.HomeAiPid

      $duplicateStartOk = $false
      $duplicateError = ''
      try {
        Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        Start-Sleep -Seconds 5
        $duplicate = Get-PortSnapshot
        $homeAiProcesses = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object {
          $null -ne $_.CommandLine -and
            $_.CommandLine.IndexOf('--home-ai', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            $_.CommandLine.IndexOf($LogPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
        })
        $duplicateStartOk = $duplicate.ListenerPids.Count -eq 1 -and
          $duplicate.HomeAiPid -eq $initialPid -and
          $homeAiProcesses.Count -eq 1 -and
          [int]$homeAiProcesses[0].ProcessId -eq $initialPid
      } catch { $duplicateError = $_.Exception.Message }
      $duplicateDetails = if ($duplicateStartOk) { '' } else { Get-FailureDetails -ErrorMessage $duplicateError -Fallback 'Expected one listener and exactly one --home-ai process using this log path, with the original PID after 5 seconds.' }
      Add-Check -Name 'Duplicate start keeps one listener and the same PID after 5 seconds' -Passed $duplicateStartOk -Details $duplicateDetails

      $stopped = $false
      $stopError = ''
      try {
        $nextRunTime = (Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop).NextRunTime
        $now = Get-Date
        if ($nextRunTime -is [DateTime] -and $nextRunTime -le $now.AddSeconds(20)) {
          $waitSeconds = [int][Math]::Ceiling(($nextRunTime.AddSeconds(2) - (Get-Date)).TotalSeconds)
          if ($waitSeconds -gt 0) { Start-Sleep -Seconds $waitSeconds }
        }
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        $stopped = Wait-ForNoListener -TimeoutSeconds 15 -PollSeconds 1
      } catch { $stopError = $_.Exception.Message }
      $stopDetails = if ($stopped) { '' } else { Get-FailureDetails -ErrorMessage $stopError -Fallback 'Timed out waiting for all listeners to stop.' }
      Add-Check -Name 'Stop leaves zero listeners' -Passed $stopped -Details $stopDetails

      $started = $null
      $startError = ''
      try {
        Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        $started = Wait-ForHomeAiListener -TimeoutSeconds 30 -PollSeconds 1 -DifferentFromPid $initialPid
      } catch { $startError = $_.Exception.Message }
      $newPid = $null -ne $started
      $startDetails = if ($newPid) { '' } else { Get-FailureDetails -ErrorMessage $startError -Fallback 'Timed out waiting for one listener with a new PID.' }
      Add-Check -Name 'Start restores one listener with a new PID' -Passed $newPid -Details $startDetails

      $recovered = $null
      $killError = ''
      if ($newPid) {
        $killedPid = [int]$started.HomeAiPid
        try {
          $logOffset = Get-LogLength
          Stop-Process -Id $killedPid -Force -ErrorAction Stop
          $recovered = Wait-ForHomeAiListener -TimeoutSeconds 90 -PollSeconds 5 -DifferentFromPid $killedPid
          if ($null -ne $recovered) {
            $logMarkers = Wait-ForLogMarkers -Offset $logOffset -TimeoutSeconds 15
          }
        } catch { $killError = $_.Exception.Message }
      }
      $recoveryDetails = if ($null -ne $recovered) { '' } else { Get-FailureDetails -ErrorMessage $killError -Fallback 'Timed out waiting for the killed process to recover.' }
      Add-Check -Name 'Killed service recovers within 90 seconds (5-second polling)' -Passed ($null -ne $recovered) -Details $recoveryDetails
    } else {
      Add-Check -Name 'Duplicate start keeps one listener and the same PID after 5 seconds' -Passed $false -Details 'Not run: no single --home-ai listener was verified.'
      Add-Check -Name 'Stop leaves zero listeners' -Passed $false -Details 'Not run: no single --home-ai listener was verified.'
      Add-Check -Name 'Start restores one listener with a new PID' -Passed $false -Details 'Not run: no single --home-ai listener was verified.'
      Add-Check -Name 'Killed service recovers within 90 seconds (5-second polling)' -Passed $false -Details 'Not run: no single --home-ai listener was verified.'
    }
  } else {
    Add-Check -Name 'Exactly one listener on configured port' -Passed $false -Details 'Not run: port configuration is unavailable.'
    Add-Check -Name 'Listener process command line contains --home-ai' -Passed $false -Details 'Not run: port configuration is unavailable.'
    Add-Check -Name 'Duplicate start keeps one listener and the same PID after 5 seconds' -Passed $false -Details 'Not run: port configuration is unavailable.'
    Add-Check -Name 'Stop leaves zero listeners' -Passed $false -Details 'Not run: port configuration is unavailable.'
    Add-Check -Name 'Start restores one listener with a new PID' -Passed $false -Details 'Not run: port configuration is unavailable.'
    Add-Check -Name 'Killed service recovers within 90 seconds (5-second polling)' -Passed $false -Details 'Not run: port configuration is unavailable.'
  }
} catch {
  Add-Check -Name 'Verification sequence completed' -Passed $false -Details 'Unexpected error stopped the service checks.'
} finally {
  $serviceRunning = $false
  $serviceError = ''
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
    } catch { $serviceError = $_.Exception.Message }
  }
  $serviceDetails = if ($serviceRunning) { '' } else { Get-FailureDetails -ErrorMessage $serviceError -Fallback 'No single --home-ai listener was available at the end.' }
  Add-Check -Name 'Service is running at end' -Passed $serviceRunning -Details $serviceDetails
  $haTokenDetails = if ($logMarkers.HaToken) { '' } else { 'Marker not found in log data appended after the kill.' }
  $runningDetails = if ($logMarkers.Running) { '' } else { 'Marker not found in log data appended after the kill.' }
  Add-Check -Name "Log contains 'HA token' after process recovery" -Passed $logMarkers.HaToken -Details $haTokenDetails
  Add-Check -Name "Log contains 'Pixel Office running' after process recovery" -Passed $logMarkers.Running -Details $runningDetails
}
$passedCount = @($script:Checks | Where-Object { $_.Passed }).Count
$failedCount = $script:Checks.Count - $passedCount
Write-Host ("Summary: {0} passed, {1} failed." -f $passedCount, $failedCount)
if ($failedCount -gt 0) { exit 1 }
exit 0
