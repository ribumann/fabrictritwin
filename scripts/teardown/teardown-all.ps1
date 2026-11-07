#Requires -Version 7.0

[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)]
    [string]$SubscriptionId,

    [Parameter(Mandatory)]
    [string]$ResourceGroupName,

    [Parameter(Mandatory)]
    [string]$FabricWorkspaceName,

    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Invoke-Az {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments,

        [switch]$AsJson
    )

    $output = & az @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "az $($Arguments -join ' ') failed (exit $LASTEXITCODE):`n$($output -join [Environment]::NewLine)"
    }

    if ($AsJson) {
        if ([string]::IsNullOrWhiteSpace(($output -join ''))) {
            return $null
        }

        return ($output -join [Environment]::NewLine) | ConvertFrom-Json
    }

    return $output
}

function Assert-AzureContext {
    param([string]$SubscriptionId)

    Write-Host "Verifying az CLI login and setting subscription to $SubscriptionId..."
    $account = Invoke-Az -Arguments @('account', 'show', '-o', 'json') -AsJson
    if ($account.id -ne $SubscriptionId) {
        Invoke-Az -Arguments @('account', 'set', '--subscription', $SubscriptionId) | Out-Null
    }
    Write-Host "Using subscription: $SubscriptionId"
}

function Get-FabricAuthHeaders {
    $accessToken = ((Invoke-Az -Arguments @(
                'account', 'get-access-token',
                '--resource', 'https://api.fabric.microsoft.com',
                '--query', 'accessToken',
                '-o', 'tsv'
            )) -join '').Trim()

    if ([string]::IsNullOrWhiteSpace($accessToken)) {
        throw 'Failed to acquire a Fabric API access token from `az account get-access-token`.'
    }

    return @{
        Authorization = "Bearer $accessToken"
        Accept        = 'application/json'
    }
}

function Invoke-FabricRestMethod {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('Get', 'Delete')]
        [string]$Method,

        [Parameter(Mandatory)]
        [string]$Uri,

        [Parameter(Mandatory)]
        [hashtable]$Headers
    )

    try {
        return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers -ErrorAction Stop
    }
    catch {
        $statusCode = $null
        if ($_.Exception.PSObject.Properties.Name -contains 'Response' -and $null -ne $_.Exception.Response) {
            try {
                $statusCode = [int]$_.Exception.Response.StatusCode
            }
            catch {
                $statusCode = $null
            }
        }

        if ($Method -eq 'Delete' -and $statusCode -eq 404) {
            return $null
        }

        $details = if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
            $_.ErrorDetails.Message
        }
        else {
            $_.Exception.Message
        }

        throw "Fabric API $Method $Uri failed$($(if ($statusCode) { " (HTTP $statusCode)" } else { '' })): $details"
    }
}

function Get-FabricWorkspaceByName {
    param(
        [string]$WorkspaceName,
        [hashtable]$Headers
    )

    $requestUri = 'https://api.fabric.microsoft.com/v1/workspaces?roles=Admin'
    $matches = @()

    do {
        $response = Invoke-FabricRestMethod -Method Get -Uri $requestUri -Headers $Headers
        $pageMatches = @($response.value | Where-Object { $_.displayName -ieq $WorkspaceName })
        if ($pageMatches.Count -gt 0) {
            $matches += $pageMatches
        }

        $requestUri = $response.continuationUri
    } while ($requestUri)

    if ($matches.Count -gt 1) {
        throw "Multiple Fabric workspaces named '$WorkspaceName' are visible to the current principal. Refusing to guess which one to delete."
    }

    if ($matches.Count -eq 0) {
        return $null
    }

    return $matches[0]
}

function Test-ResourceGroupExists {
    param([string]$ResourceGroupName)

    # Mirrors provision-azure-resources.ps1's exact `az group exists` idiom: it always exits 0
    # and prints true/false, unlike `az group show` which throws for a missing group.
    return ((Invoke-Az -Arguments @('group', 'exists', '--name', $ResourceGroupName)) -join '' -eq 'true')
}

function Confirm-TeardownIntent {
    param(
        [string]$ResourceGroupName,
        [switch]$Force
    )

    if ($WhatIfPreference) {
        Write-Host 'What-if mode: skipping the typed confirmation prompt.'
        return
    }

    if ($Force) {
        Write-Host 'Force specified: bypassing the typed confirmation prompt.'
        return
    }

    $confirmation = Read-Host -Prompt "Type the resource group name '$ResourceGroupName' to confirm teardown"
    if ($confirmation -cne $ResourceGroupName) {
        throw "Confirmation failed. Expected '$ResourceGroupName' but received '$confirmation'. No deletions were attempted."
    }
}

Write-Host '=== teardown-all.ps1 (T046) ==='
Write-Host "ResourceGroupName   : $ResourceGroupName"
Write-Host "FabricWorkspaceName : $FabricWorkspaceName"
Write-Host ''

Assert-AzureContext -SubscriptionId $SubscriptionId

Write-Host "Checking whether resource group '$ResourceGroupName' exists..."
$resourceGroupExists = Test-ResourceGroupExists -ResourceGroupName $ResourceGroupName
if ($resourceGroupExists) {
    Write-Host "Resource group '$ResourceGroupName' exists."
}
else {
    Write-Host "Resource group '$ResourceGroupName' does not exist. Azure deletion step will be a no-op."
}

Write-Host "Resolving Fabric workspace '$FabricWorkspaceName' by name..."
$fabricHeaders = Get-FabricAuthHeaders
$workspace = Get-FabricWorkspaceByName -WorkspaceName $FabricWorkspaceName -Headers $fabricHeaders
if ($workspace) {
    Write-Host "Found Fabric workspace '$FabricWorkspaceName' with id '$($workspace.id)'."
}
else {
    Write-Host "Fabric workspace '$FabricWorkspaceName' was not found. Fabric deletion step will be a no-op."
}

if (-not $resourceGroupExists -and -not $workspace) {
    Write-Host 'Nothing to delete. Teardown already complete.'
    return [PSCustomObject]@{
        SubscriptionId         = $SubscriptionId
        FabricWorkspaceName    = $FabricWorkspaceName
        FabricWorkspaceId      = $null
        FabricWorkspaceDeleted = $false
        ResourceGroupName      = $ResourceGroupName
        ResourceGroupDeleted   = $false
    }
}

Confirm-TeardownIntent -ResourceGroupName $ResourceGroupName -Force:$Force

$fabricWorkspaceDeleted = $false
if ($workspace) {
    if ($PSCmdlet.ShouldProcess($FabricWorkspaceName, "Delete Fabric workspace '$($workspace.id)'")) {
        Write-Host "Deleting Fabric workspace '$FabricWorkspaceName'..."
        Invoke-FabricRestMethod -Method Delete -Uri "https://api.fabric.microsoft.com/v1/workspaces/$($workspace.id)" -Headers $fabricHeaders | Out-Null
        $fabricWorkspaceDeleted = $true
        Write-Host "Fabric workspace '$FabricWorkspaceName' delete request completed."
    }
}

$resourceGroupDeleted = $false
if ($resourceGroupExists) {
    if ($PSCmdlet.ShouldProcess($ResourceGroupName, 'Delete Azure resource group')) {
        Write-Host "Deleting resource group '$ResourceGroupName'..."
        Invoke-Az -Arguments @('group', 'delete', '--name', $ResourceGroupName, '--yes') | Out-Null
        $resourceGroupDeleted = $true
        Write-Host "Resource group '$ResourceGroupName' deleted."
    }
}

$result = [PSCustomObject]@{
    SubscriptionId         = $SubscriptionId
    FabricWorkspaceName    = $FabricWorkspaceName
    FabricWorkspaceId      = if ($workspace) { $workspace.id } else { $null }
    FabricWorkspaceDeleted = $fabricWorkspaceDeleted
    ResourceGroupName      = $ResourceGroupName
    ResourceGroupDeleted   = $resourceGroupDeleted
}

Write-Host ''
Write-Host 'Teardown summary:'
$result | Format-List | Out-String | Write-Host

return $result
