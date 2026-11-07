<#
.SYNOPSIS
    Root Pester test runner for the Triathlon Training Twin repository.
.DESCRIPTION
    Invokes the Pester 5 test suite under tests/pester/ using the shared
    PesterConfiguration.psd1. Used locally and by scripts/validate/smoke-test.ps1
    and .github/workflows/smoke-test.yml (Principle IV thin trigger).
.EXAMPLE
    ./tests/pester/Run-Tests.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

if (-not (Get-Module -ListAvailable -Name Pester | Where-Object { $_.Version -ge [version]'5.0.0' })) {
    throw "Pester 5+ is required. Install with: Install-Module -Name Pester -MinimumVersion 5.0.0 -Scope CurrentUser -Force"
}

Import-Module Pester -MinimumVersion 5.0.0

$configPath = Join-Path $PSScriptRoot 'PesterConfiguration.psd1'
$configData = Import-PowerShellDataFile -Path $configPath
$config = New-PesterConfiguration -Hashtable $configData

Invoke-Pester -Configuration $config
