#Requires -Version 7.0
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$id = [guid]::NewGuid().ToString('N')
$output = Join-Path ([System.IO.Path]::GetTempPath()) "image-context-$id"
$probeRoot = Join-Path $repoRoot ".env.image-context-$id"
$probeSource = Join-Path $repoRoot "apps/simulator/src/.env.image-context-$id"
$probeKey = Join-Path $repoRoot "apps/simulator/src/image-context-$id.pem"
$probes = @($probeRoot, $probeSource, $probeKey)

Push-Location $repoRoot
try {
    foreach ($probe in $probes) { Set-Content -LiteralPath $probe -Value 'synthetic exclusion probe, not a credential' }
    docker buildx build --file tests/containers/context.Containerfile --output "type=local,dest=$output" .
    if ($LASTEXITCODE -ne 0) { throw 'Docker context export failed.' }
    $context = Join-Path $output 'context'
    $files = @(Get-ChildItem -LiteralPath $context -File -Recurse -Force)
    foreach ($file in $files) {
        $relative = [System.IO.Path]::GetRelativePath($context, $file.FullName).Replace('\', '/')
        if ($relative -notmatch '^(package(-lock)?\.json|tsconfig\.base\.json|apps/[^/]+/(package\.json|tsconfig\.json|src/.+))$' -or
            $relative -match '(^|/)(\.env[^/]*|\.npmrc|\.git|node_modules|dist)(/|$)|\.(pem|key|pfx|p12|log)$') {
            throw "Unexpected file included in Docker context: $relative"
        }
    }
    foreach ($required in @('package.json', 'package-lock.json', 'tsconfig.base.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $context $required))) { throw "Missing build input: $required" }
    }
    foreach ($app in @('simulator', 'cockpit', 'streaming-backend', 'mcp-tools', 'console')) {
        foreach ($required in @('package.json', 'tsconfig.json', 'src/index.ts')) {
            if (-not (Test-Path -LiteralPath (Join-Path $context "apps/$app/$required"))) {
                throw "Missing workspace build input: $app/$required"
            }
        }
    }
    Write-Host "Verified $($files.Count) allowlisted build inputs and synthetic secret exclusions."
}
finally {
    Pop-Location
    foreach ($probe in $probes) {
        if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Force }
    }
    if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Recurse -Force }
}
