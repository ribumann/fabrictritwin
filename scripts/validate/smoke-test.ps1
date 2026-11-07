#Requires -Version 7.0
<#
.SYNOPSIS
Runs integration smoke checks against already-provisioned Triathlon Training Twin
infrastructure (Eventstream ingest, Eventhouse query, Key Vault access, deployed
Container Apps health endpoints, Fabric item existence).

.DESCRIPTION
Implements T045 (specs/001-triathlon-training-twin/tasks.md) per
contracts/powershell-scripts-contract.md's `smoke-test.ps1` entry. This is the
Infrastructure-First checkpoint gate (Constitution Principle II): no Phase 3+
(application code) task may begin until this script exits `0`.

Thin wrapper (Principle IV): invokes Pester 5.6.1 specifically (see the version-pinning
comment near the Import-Module call for why an exact version, not just >=5.0.0, is
required) against tests/pester/Smoke-Test.Tests.ps1 only (via its 'Integration' tag), passing
-ResourceGroupName/-FabricWorkspaceName through as Pester container data. Every other
file under tests/pester/ is a mocked unit test (excluded here by tag, and excluded from
this file's own scope by only targeting the one smoke-test file) and is run separately by
tests/pester/Run-Tests.ps1.

Assumes the caller (workstation `az login` session, or a GitHub Actions OIDC step) already
has an active `az` CLI context with the correct subscription selected -- unlike
provision-azure-resources.ps1/provision-fabric-items.ps1, this script takes no
-SubscriptionId parameter per the committed contract, since it only performs read-only
connectivity checks against resources that must already exist.

.PARAMETER ResourceGroupName
Resource group containing the provisioned Azure resources. Defaults to
'rg-triathlon-twin-demo'.

.PARAMETER FabricWorkspaceName
Exact display name of the provisioned Fabric workspace. Defaults to `<NamePrefix>-fabric`.

.PARAMETER NamePrefix
Resource name prefix used to derive expected Fabric item display names. Defaults to
'triatwin-dev'.

.OUTPUTS
None. Writes a Pester result summary to the host and to
tests/pester/TestResults/smoke-test-results.xml.

.EXAMPLE
./smoke-test.ps1
Runs all smoke checks against the default resource group/workspace naming.

.EXAMPLE
./smoke-test.ps1 -ResourceGroupName rg-triathlon-twin-demo -FabricWorkspaceName triatwin-dev-fabric
#>
[CmdletBinding()]
param(
    [string]$ResourceGroupName = 'rg-triathlon-twin-demo',
    [string]$FabricWorkspaceName,
    [string]$NamePrefix = 'triatwin-dev'
)

$ErrorActionPreference = 'Stop'

# Pinned to an exact Pester 5.x version rather than `-MinimumVersion 5.0.0`, deliberately.
# This file (unlike every other Pester test in tests/pester/, which mocks all external
# calls) makes real `az` CLI invocations from inside BeforeAll/It blocks. Pester 6.1.0 has
# a confirmed framework regression that throws a misleading
# `InvalidOperationException: A 'break' or 'continue' statement with a label that does not
# match any enclosing loop escaped from your code` whenever an external process is invoked
# from a user-defined function called inside BeforeAll/It (see
# https://github.com/pester/Pester/issues/2669) -- completely masking real results. This
# was root-caused via isolated repro (identical logic fails under 6.1.0, passes cleanly
# under 5.6.1) rather than assumed. `-MinimumVersion 5.0.0` would silently resolve to the
# highest installed 5.x-or-above version, which is 6.1.0 in most dev environments today, so
# an exact `-RequiredVersion` is used here to guarantee the known-good version is loaded.
$requiredPesterVersion = '5.6.1'
if (-not (Get-Module -ListAvailable -Name Pester | Where-Object { $_.Version -eq [version]$requiredPesterVersion })) {
    throw "Pester $requiredPesterVersion is required (an exact version, not just >=5.0.0 -- see the comment above this check for why). Install with: Install-Module -Name Pester -RequiredVersion $requiredPesterVersion -Scope CurrentUser -Force -SkipPublisherCheck"
}

Import-Module Pester -RequiredVersion $requiredPesterVersion -Force

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
$testFilePath = Join-Path $repoRoot 'tests' 'pester' 'Smoke-Test.Tests.ps1'
if (-not (Test-Path $testFilePath)) {
    throw "Smoke test file not found at '$testFilePath'. Run this script from a checkout of the fabrictritwin repository."
}

Write-Host '=== smoke-test.ps1 (T045): Infrastructure-First checkpoint gate ===' -ForegroundColor Cyan
Write-Host "ResourceGroupName   : $ResourceGroupName"
Write-Host "FabricWorkspaceName : $(if ($FabricWorkspaceName) { $FabricWorkspaceName } else { "$NamePrefix-fabric (default)" })"
Write-Host "NamePrefix          : $NamePrefix"
Write-Host ''

$containerData = @{
    ResourceGroupName   = $ResourceGroupName
    FabricWorkspaceName = $FabricWorkspaceName
    NamePrefix          = $NamePrefix
}
$container = New-PesterContainer -Path $testFilePath -Data $containerData

$config = New-PesterConfiguration
$config.Run.Container = $container
$config.Run.PassThru = $true
$config.Filter.Tag = 'Integration'
$config.Output.Verbosity = 'Detailed'
$config.TestResult.Enabled = $true
$config.TestResult.OutputPath = Join-Path $repoRoot 'tests' 'pester' 'TestResults' 'smoke-test-results.xml'
$config.TestResult.OutputFormat = 'NUnitXml'

$result = Invoke-Pester -Configuration $config

Write-Host ''
if ($result.FailedCount -gt 0) {
    Write-Host "smoke-test.ps1 FAILED: $($result.FailedCount) of $($result.TotalCount) checks failed." -ForegroundColor Red
    foreach ($failed in $result.Failed) {
        Write-Host "  - $($failed.ExpandedPath): $($failed.ErrorRecord -join '; ')" -ForegroundColor Red
    }
    exit 1
}

Write-Host "smoke-test.ps1 PASSED: $($result.PassedCount) of $($result.TotalCount) checks passed ($($result.SkippedCount) inconclusive/skipped)." -ForegroundColor Green
exit 0
