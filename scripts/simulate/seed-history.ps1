#Requires -Version 7.0
<#
.SYNOPSIS
Seeds the 16-week Triathlon Training Twin history for one athlete.

.DESCRIPTION
Implements T058 (specs/001-triathlon-training-twin/tasks.md). This script is the workstation/CI
entry point for User Story 1 history seeding and intentionally calls the simulator's Node CLI
directly, not the Streaming Backend API. The underlying CLI/service owns idempotency: rerunning
for an athlete that already has seeded history returns the existing seed status instead of
duplicating data.

.PARAMETER AthleteId
Athlete GUID whose history should be seeded.

.PARAMETER Environment
Logical environment name forwarded to the simulator CLI. Defaults to 'dev'.

.OUTPUTS
JSON written to stdout describing the seed result.

.EXAMPLE
./scripts/simulate/seed-history.ps1 -AthleteId 11111111-1111-4111-8111-111111111111
#>
[CmdletBinding()]
param(
    [string]$AthleteId,
    [string]$Environment = 'dev'
)

$ErrorActionPreference = 'Stop'

function Get-RepositoryRoot {
    return (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
}

function Get-SeedHistoryCliPath {
    param(
        [Parameter(Mandatory)]
        [string]$RepositoryRoot
    )

    $cliPath = Join-Path $RepositoryRoot 'apps' 'simulator' 'dist' 'cli' 'seed-history-cli.js'
    if (-not (Test-Path $cliPath)) {
        throw "Simulator seed-history CLI not found at '$cliPath'. Run 'npm install' and 'npm run build' in apps/simulator first."
    }

    return $cliPath
}

function Invoke-SeedHistoryCli {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$CliPath,

        [Parameter(Mandatory)]
        [string]$AthleteId,

        [Parameter(Mandatory)]
        [string]$Environment
    )

    $output = & node $CliPath '--athlete-id' $AthleteId '--environment' $Environment 2>&1
    return [PSCustomObject]@{
        ExitCode = $LASTEXITCODE
        StdOut   = ($output -join [Environment]::NewLine)
    }
}

function Invoke-SeedHistory {
    [CmdletBinding()]
    param(
        [string]$AthleteId,
        [string]$Environment = 'dev'
    )

    if ([string]::IsNullOrWhiteSpace($AthleteId)) {
        throw 'Parameter -AthleteId is required.'
    }

    $repositoryRoot = Get-RepositoryRoot
    $cliPath = Get-SeedHistoryCliPath -RepositoryRoot $repositoryRoot
    $cliResult = Invoke-SeedHistoryCli -CliPath $cliPath -AthleteId $AthleteId -Environment $Environment

    if ($cliResult.ExitCode -ne 0) {
        throw "seed-history CLI failed with exit code $($cliResult.ExitCode).`n$($cliResult.StdOut)"
    }

    try {
        return $cliResult.StdOut | ConvertFrom-Json -Depth 100
    }
    catch {
        throw "seed-history CLI did not return valid JSON.`n$($cliResult.StdOut)"
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $result = Invoke-SeedHistory -AthleteId $AthleteId -Environment $Environment
    $result | ConvertTo-Json -Depth 100
}
