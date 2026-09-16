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

$startupDirectory = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
New-Item -ItemType Directory -Path $startupDirectory -Force | Out-Null
$startupShortcut = Join-Path $startupDirectory 'PrintFlow Printer Agent.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($startupShortcut)
$shortcut.TargetPath = $resolvedExecutable
$shortcut.WorkingDirectory = Split-Path -Parent $resolvedExecutable
$shortcut.Description = 'Starts the PrintFlow Printer Agent for this Windows account.'
$shortcut.Save()

if (-not (Test-Path -LiteralPath $startupShortcut -PathType Leaf)) {
    throw 'The PrintFlow Printer Agent startup shortcut could not be created.'
}

Start-Process -FilePath $resolvedExecutable -WorkingDirectory (Split-Path -Parent $resolvedExecutable)
Write-Output 'PrintFlow Printer Agent startup registration completed.'
