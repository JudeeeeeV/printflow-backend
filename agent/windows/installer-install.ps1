$ErrorActionPreference = 'Stop'

$archivePath = Join-Path $PSScriptRoot 'agent-package.zip'
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
    throw 'The PrintFlow Agent package is missing.'
}

$programsRoot = Join-Path $env:LOCALAPPDATA 'Programs'
$installDirectory = Join-Path $programsRoot 'PrintFlow Agent'
$resolvedProgramsRoot = [IO.Path]::GetFullPath($programsRoot).TrimEnd('\') + '\'
$resolvedInstallDirectory = [IO.Path]::GetFullPath($installDirectory).TrimEnd('\') + '\'
if (-not $resolvedInstallDirectory.StartsWith($resolvedProgramsRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The resolved installation directory is outside the current user Programs directory.'
}

$taskName = 'PrintFlow Printer Agent'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$existingAgentExecutable = Join-Path $installDirectory 'PrintFlowAgent.exe'
Get-Process -Name 'PrintFlowAgent' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $existingAgentExecutable } |
    Stop-Process -Force
$startupShortcut = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\PrintFlow Printer Agent.lnk'
Remove-Item -LiteralPath $startupShortcut -Force -ErrorAction SilentlyContinue

if (Test-Path -LiteralPath $installDirectory) {
    Remove-Item -LiteralPath $installDirectory -Recurse -Force
}
New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
Expand-Archive -LiteralPath $archivePath -DestinationPath $installDirectory -Force

$releaseConfigPath = Join-Path $installDirectory 'release-config.json'
$releaseConfig = Get-Content -LiteralPath $releaseConfigPath -Raw | ConvertFrom-Json
$agentExecutable = Join-Path $installDirectory 'PrintFlowAgent.exe'
$startupScript = Join-Path $installDirectory 'register-startup.ps1'

& $startupScript -AgentExecutable $agentExecutable -BackendUrl $releaseConfig.backendUrl

$startMenuDirectory = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\PrintFlow'
New-Item -ItemType Directory -Path $startMenuDirectory -Force | Out-Null
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path $startMenuDirectory 'Uninstall PrintFlow Printer Agent.lnk'))
$shortcut.TargetPath = 'powershell.exe'
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $installDirectory 'uninstall-agent.ps1')`""
$shortcut.WorkingDirectory = $installDirectory
$shortcut.Save()

Add-Type -AssemblyName PresentationFramework
[System.Windows.MessageBox]::Show(
    'PrintFlow Printer Agent was installed and started. Your browser should open for the one-time shop sign-in.',
    'PrintFlow Printer Agent',
    'OK',
    'Information'
) | Out-Null
