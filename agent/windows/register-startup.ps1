param(
    [Parameter(Mandatory = $true)]
    [string]$AgentExecutable,

    [Parameter(Mandatory = $true)]
    [string]$BackendUrl
)

$ErrorActionPreference = 'Stop'
$resolvedExecutable = (Resolve-Path -LiteralPath $AgentExecutable).Path
$backend = [Uri]$BackendUrl
if ($backend.Scheme -ne 'https' -and $backend.Host -notin @('localhost', '127.0.0.1')) {
    throw 'A non-local PrintFlow backend must use HTTPS.'
}

$agentData = Join-Path $env:APPDATA 'PrintFlow Agent'
New-Item -ItemType Directory -Path $agentData -Force | Out-Null
@{ backendUrl = $backend.AbsoluteUri.TrimEnd('/') } |
    ConvertTo-Json |
    Set-Content -LiteralPath (Join-Path $agentData 'agent-config.json') -Encoding UTF8

$taskName = 'PrintFlow Printer Agent'
$action = New-ScheduledTaskAction -Execute $resolvedExecutable
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 10 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description 'Starts the PrintFlow Printer Agent for the current Windows user.' `
    -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Write-Output 'PrintFlow Printer Agent startup registration completed.'
