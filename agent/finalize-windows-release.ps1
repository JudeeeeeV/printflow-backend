param(
    [string]$ReleaseDirectory = (Join-Path $PSScriptRoot 'release')
)

$ErrorActionPreference = 'Stop'
$releaseRoot = [IO.Path]::GetFullPath($ReleaseDirectory)
$metadataPath = Join-Path $releaseRoot 'release.json'

if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
    throw "Release metadata was not found: $metadataPath"
}

$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
$installerPath = [IO.Path]::GetFullPath((Join-Path $releaseRoot $metadata.fileName))
$releasePrefix = $releaseRoot.TrimEnd('\') + '\'
if (-not $installerPath.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Release metadata references an installer outside the release directory.'
}
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
    throw "Installer was not found: $installerPath"
}

$metadata.sha256 = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
$metadata.builtAt = (Get-Date).ToUniversalTime().ToString('o')
$metadata | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding UTF8

Write-Output "Release metadata finalized: $metadataPath"
Write-Output "SHA-256: $($metadata.sha256)"
