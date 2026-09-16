$ErrorActionPreference = 'Stop'
$taskName = 'PrintFlow Printer Agent'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
$startupShortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\PrintFlow Printer Agent.lnk'
Remove-Item -LiteralPath $startupShortcut -Force -ErrorAction SilentlyContinue

$agentData = Join-Path $env:APPDATA 'PrintFlow Agent'
$startMenuDirectory = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\PrintFlow'
$installDirectory = Join-Path (Join-Path $env:LOCALAPPDATA 'Programs') 'PrintFlow Agent'

$allowedDataRoot = [IO.Path]::GetFullPath($env:APPDATA).TrimEnd('\') + '\'
$resolvedAgentData = [IO.Path]::GetFullPath($agentData).TrimEnd('\') + '\'
if ($resolvedAgentData.StartsWith($allowedDataRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $agentData)) {
    Remove-Item -LiteralPath $agentData -Recurse -Force
}
if (Test-Path -LiteralPath $startMenuDirectory) {
    Remove-Item -LiteralPath $startMenuDirectory -Recurse -Force
}

$cleanupCommand = "Start-Sleep -Seconds 2; if (Test-Path -LiteralPath '$($installDirectory.Replace("'", "''"))') { Remove-Item -LiteralPath '$($installDirectory.Replace("'", "''"))' -Recurse -Force }"
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile', '-NonInteractive', '-Command', $cleanupCommand

Add-Type -AssemblyName PresentationFramework
[System.Windows.MessageBox]::Show(
    'PrintFlow Printer Agent was removed from this Windows account.',
    'PrintFlow Printer Agent',
    'OK',
    'Information'
) | Out-Null
