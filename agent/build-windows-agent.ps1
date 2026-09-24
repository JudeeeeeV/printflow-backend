param(
    [string]$BackendUrl = 'https://printflow-backend-wen3.onrender.com',
    [string]$Version = '0.1.7'
)

$ErrorActionPreference = 'Stop'
$agentRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$backendRoot = [IO.Path]::GetFullPath((Join-Path $agentRoot '..'))
$buildRoot = [IO.Path]::GetFullPath((Join-Path $agentRoot 'build'))
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $agentRoot 'release'))

function Assert-AgentChildPath([string]$PathToCheck) {
    $resolved = [IO.Path]::GetFullPath($PathToCheck)
    $prefix = $agentRoot.TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside the agent workspace: $resolved"
    }
}

function Set-WindowsGuiSubsystem([string]$ExecutablePath) {
    $bytes = [IO.File]::ReadAllBytes($ExecutablePath)
    $peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
    $subsystemOffset = $peOffset + 24 + 68
    if ($subsystemOffset + 1 -ge $bytes.Length) {
        throw "Invalid Windows executable: $ExecutablePath"
    }
    $bytes[$subsystemOffset] = 2
    $bytes[$subsystemOffset + 1] = 0
    [IO.File]::WriteAllBytes($ExecutablePath, $bytes)
}

Assert-AgentChildPath $buildRoot
Assert-AgentChildPath $releaseRoot
if (Test-Path -LiteralPath $buildRoot) { Remove-Item -LiteralPath $buildRoot -Recurse -Force }
if (Test-Path -LiteralPath $releaseRoot) { Remove-Item -LiteralPath $releaseRoot -Recurse -Force }
New-Item -ItemType Directory -Path $buildRoot, $releaseRoot -Force | Out-Null

$backend = [Uri]$BackendUrl
if ($backend.Scheme -ne 'https' -and $backend.Host -notin @('localhost', '127.0.0.1')) {
    throw 'A non-local PrintFlow backend must use HTTPS.'
}

$bundlePath = Join-Path $buildRoot 'agent-bundle.cjs'
$esbuild = Join-Path $backendRoot 'node_modules\.bin\esbuild.cmd'
& $esbuild (Join-Path $agentRoot 'index.js') `
    '--bundle' `
    '--platform=node' `
    '--format=cjs' `
    '--target=node24' `
    '--external:pdf-to-printer' `
    "--outfile=$bundlePath"
if ($LASTEXITCODE -ne 0) { throw 'Agent bundling failed.' }

$blobPath = Join-Path $buildRoot 'agent-preparation.blob'
$seaConfigPath = Join-Path $buildRoot 'sea-config.json'
@{
    main = $bundlePath
    output = $blobPath
    disableExperimentalSEAWarning = $true
    useCodeCache = $false
} | ConvertTo-Json | Set-Content -LiteralPath $seaConfigPath -Encoding UTF8

& node --experimental-sea-config $seaConfigPath
if ($LASTEXITCODE -ne 0) { throw 'Node single-executable blob generation failed.' }

$stagingRoot = Join-Path $buildRoot 'package'
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
$agentExecutable = Join-Path $stagingRoot 'PrintFlowAgent.exe'
Copy-Item -LiteralPath (Get-Command node).Source -Destination $agentExecutable

$postject = Join-Path $backendRoot 'node_modules\.bin\postject.cmd'
& $postject $agentExecutable NODE_SEA_BLOB $blobPath `
    '--sentinel-fuse' 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
if ($LASTEXITCODE -ne 0) { throw 'Agent executable injection failed.' }
Set-WindowsGuiSubsystem $agentExecutable

$printerModuleTarget = Join-Path $stagingRoot 'node_modules\pdf-to-printer'
New-Item -ItemType Directory -Path (Split-Path $printerModuleTarget) -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $backendRoot 'node_modules\pdf-to-printer') -Destination $printerModuleTarget -Recurse
Copy-Item -LiteralPath (Join-Path $agentRoot 'windows\register-startup.ps1') -Destination $stagingRoot
Copy-Item -LiteralPath (Join-Path $agentRoot 'windows\uninstall-agent.ps1') -Destination $stagingRoot
@{
    backendUrl = $backend.AbsoluteUri.TrimEnd('/')
    version = $Version
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stagingRoot 'release-config.json') -Encoding UTF8

$archivePath = Join-Path $buildRoot 'agent-package.zip'
Compress-Archive -Path (Join-Path $stagingRoot '*') -DestinationPath $archivePath -CompressionLevel Optimal

$installerName = "PrintFlowAgent-$Version-Setup.exe"
$installerPath = Join-Path $releaseRoot $installerName
$installerFiles = Join-Path $buildRoot 'installer'
New-Item -ItemType Directory -Path $installerFiles -Force | Out-Null
Copy-Item -LiteralPath $archivePath -Destination $installerFiles
Copy-Item -LiteralPath (Join-Path $agentRoot 'windows\installer-install.ps1') -Destination $installerFiles
'@echo off' + [Environment]::NewLine + 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer-install.ps1"' | Set-Content -LiteralPath (Join-Path $installerFiles 'install.cmd') -Encoding ASCII

$iexpressSucceeded = $false
$iexpress = Get-Command iexpress.exe -ErrorAction SilentlyContinue
if ($iexpress) {
    $sourceDirectory = $installerFiles.TrimEnd('\') + '\'
    $sedPath = Join-Path $buildRoot 'installer.sed'
    @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles
[SourceFiles]
SourceFiles0=%SourceFiles0%
[SourceFiles0]
%FILE0%=
%FILE1%=
%FILE2%=
[Strings]
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName="$installerPath"
FriendlyName="PrintFlow Printer Agent $Version"
AppLaunched="install.cmd"
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles0="$sourceDirectory"
FILE0="agent-package.zip"
FILE1="installer-install.ps1"
FILE2="install.cmd"
"@ | Set-Content -LiteralPath $sedPath -Encoding ASCII
    & $iexpress.Source /N /Q $sedPath
    $iexpressSucceeded = Test-Path -LiteralPath $installerPath
}

$bootstrapSucceeded = $false
if (-not $iexpressSucceeded) {
    $compilerCandidates = @(
        'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe',
        'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe'
    )
    $compiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if ($compiler) {
        & $compiler `
            '/nologo' `
            '/target:winexe' `
            '/optimize+' `
            '/platform:anycpu' `
            "/out:$installerPath" `
            '/reference:System.Windows.Forms.dll' `
            "/resource:$archivePath,PrintFlow.AgentPackage" `
            "/resource:$(Join-Path $agentRoot 'windows\installer-install.ps1'),PrintFlow.InstallScript" `
            (Join-Path $agentRoot 'windows\InstallerBootstrap.cs')
        $bootstrapSucceeded = $LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $installerPath)
    }
}

if (-not $iexpressSucceeded -and -not $bootstrapSucceeded) {
    Write-Warning 'IExpress packaging was unavailable; using the larger self-contained installer fallback.'
    $installerBundle = Join-Path $buildRoot 'installer-bundle.cjs'
    & $esbuild (Join-Path $agentRoot 'windows\installer-main.js') `
        '--bundle' `
        '--platform=node' `
        '--format=cjs' `
        '--target=node24' `
        "--outfile=$installerBundle"
    if ($LASTEXITCODE -ne 0) { throw 'Installer bundling failed.' }

    $installerBlob = Join-Path $buildRoot 'installer-preparation.blob'
    $installerSeaConfig = Join-Path $buildRoot 'installer-sea-config.json'
    @{
        main = $installerBundle
        output = $installerBlob
        disableExperimentalSEAWarning = $true
        useCodeCache = $false
        assets = @{
            'agent-package.zip' = $archivePath
            'installer-install.ps1' = (Join-Path $agentRoot 'windows\installer-install.ps1')
        }
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $installerSeaConfig -Encoding UTF8

    & node --experimental-sea-config $installerSeaConfig
    if ($LASTEXITCODE -ne 0) { throw 'Installer blob generation failed.' }
    Copy-Item -LiteralPath (Get-Command node).Source -Destination $installerPath
    & $postject $installerPath NODE_SEA_BLOB $installerBlob `
        '--sentinel-fuse' 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
    if ($LASTEXITCODE -ne 0) { throw 'Installer executable injection failed.' }
    Set-WindowsGuiSubsystem $installerPath
}

$hash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
@{
    version = $Version
    fileName = $installerName
    sha256 = $hash
    backendUrl = $backend.AbsoluteUri.TrimEnd('/')
    builtAt = (Get-Date).ToUniversalTime().ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $releaseRoot 'release.json') -Encoding UTF8

Write-Output "Installer: $installerPath"
Write-Output "SHA-256: $hash"
