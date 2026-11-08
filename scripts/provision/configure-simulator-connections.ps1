#Requires -Version 7.0

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [string]$SubscriptionId,

    [string]$ResourceGroupName = 'rg-triathlon-twin-demo',
    [string]$FabricWorkspaceId,
    [string]$FabricWorkspaceName,
    [string]$LakehouseDisplayName,
    [string]$EventstreamDisplayName,
    [string]$EventstreamSourceName = 'triathlon_custom_endpoint',
    [string]$EventhouseDisplayName,
    [string]$EventhouseKqlDatabaseDisplayName,
    [string]$NamePrefix = 'triatwin-dev',
    [string]$Location = 'polandcentral',
    [string]$FabricLocation = 'italynorth',
    [string]$FoundryLocation = 'swedencentral',
    [string]$FabricCapacityAdminUpn = 'admin@example.invalid',
    [string]$TenantId,
    [string]$ImageTag = 'placeholder',
    [ValidateSet('live', 'synthetic')]
    [string]$DemoProfile,
    [string]$SimulatorDailyScheduleCron = '0 3 * * *',
    [string]$DefaultAthleteId
)

$ErrorActionPreference = 'Stop'
$scriptRoot = $PSScriptRoot

if ($PSBoundParameters.ContainsKey('DemoProfile') -and $DemoProfile -cnotin @('live', 'synthetic')) {
    throw '-DemoProfile must be exactly live or synthetic.'
}

if (-not $LakehouseDisplayName) {
    $LakehouseDisplayName = "$($NamePrefix.Replace('-', '_'))_lakehouse"
}
if (-not $EventstreamDisplayName) {
    $EventstreamDisplayName = "$NamePrefix-eventstream"
}
if (-not $FabricWorkspaceName) {
    $FabricWorkspaceName = "$NamePrefix-fabric"
}
if (-not $EventhouseDisplayName) {
    $EventhouseDisplayName = "$NamePrefix-eventhouse"
}
if (-not $EventhouseKqlDatabaseDisplayName) {
    $EventhouseKqlDatabaseDisplayName = "$NamePrefix-realtime"
}

function Invoke-Az {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments,

        [switch]$AsJson
    )

    $output = & az @Arguments --subscription $SubscriptionId 2>&1
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

function Get-FabricAuthHeaders {
    # Same convention as provision-fabric-items.ps1's Get-FabricAuthHeaders.
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

function Get-FabricWorkspaceByName {
    param(
        [string]$WorkspaceName,
        [hashtable]$Headers
    )

    $requestUri = 'https://api.fabric.microsoft.com/v1/workspaces?roles=Admin'
    $found = @()

    do {
        $response = Invoke-RestMethod -Method Get -Uri $requestUri -Headers $Headers
        $pageMatches = @($response.value | Where-Object { $_.displayName -ieq $WorkspaceName })
        if ($pageMatches.Count -gt 0) {
            $found += $pageMatches
        }

        $requestUri = $response.continuationUri
    } while ($requestUri)

    if ($found.Count -gt 1) {
        throw "Multiple Fabric workspaces named '$WorkspaceName' are visible to the current principal. Refusing to guess which one to reuse."
    }

    if ($found.Count -eq 0) {
        return $null
    }

    return $found[0]
}

function Get-FabricItemByDisplayName {
    param(
        [string]$WorkspaceId,
        [string]$DisplayName,
        [hashtable]$Headers,
        [string]$ExpectedType
    )

    $requestUri = "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/items"
    $found = @()

    do {
        $response = Invoke-RestMethod -Method Get -Uri $requestUri -Headers $Headers
        $pageMatches = @($response.value | Where-Object { $_.displayName -ieq $DisplayName })
        if ($pageMatches.Count -gt 0) {
            $found += $pageMatches
        }

        $requestUri = $response.continuationUri
    } while ($requestUri)

    if ($ExpectedType) {
        $found = @($found | Where-Object { $_.type -ieq $ExpectedType })
    }

    if ($found.Count -gt 1) {
        throw "Multiple Fabric items named '$DisplayName' are visible in workspace '$WorkspaceId'. Refusing to guess which one to reuse."
    }

    if ($found.Count -eq 0) {
        return $null
    }

    return $found[0]
}

function Grant-FabricWorkspaceRoleAssignment {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [string]$WorkspaceId,
        [string]$PrincipalId,
        [string]$PrincipalDisplayName,
        [string]$Role,
        [hashtable]$Headers
    )

    $existingUri = "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/roleAssignments"
    $requestUri = $existingUri
    $alreadyGranted = @()
    do {
        $existing = Invoke-RestMethod -Method Get -Uri $requestUri -Headers $Headers
        $alreadyGranted += @($existing.value | Where-Object { $_.principal.id -ieq $PrincipalId })
        $requestUri = $existing.continuationUri
    } while ($requestUri)

    if ($alreadyGranted.Count -gt 0) {
        $roleRanks = @{ Viewer = 0; Contributor = 1; Member = 2; Admin = 3 }
        $existingRole = [string]$alreadyGranted[0].role
        if (-not $roleRanks.ContainsKey($existingRole) -or $roleRanks[$existingRole] -lt $roleRanks[$Role]) {
            throw "$PrincipalDisplayName has Fabric workspace role '$existingRole', but '$Role' or higher is required by this deployment. Update the existing assignment explicitly before retrying."
        }
        Write-Host "  $PrincipalDisplayName already has Fabric workspace role '$($alreadyGranted[0].role)' -- skipping."
        return $false
    }

    if (-not $PSCmdlet.ShouldProcess("$PrincipalDisplayName in workspace $WorkspaceId", "Grant Fabric workspace role '$Role'")) {
        return $false
    }

    $body = @{
        principal = @{
            id   = $PrincipalId
            type = 'ServicePrincipal'
        }
        role      = $Role
    } | ConvertTo-Json -Compress

    Invoke-RestMethod -Method Post -Uri $existingUri -Headers $Headers -Body $body -ContentType 'application/json' | Out-Null
    Write-Host "  Granted '$Role' Fabric workspace role to $PrincipalDisplayName ($PrincipalId)." -ForegroundColor Green
    return $true
}

Write-Host '=== configure-simulator-connections.ps1 (T059b) ===' -ForegroundColor Cyan
Write-Host "ResourceGroupName : $ResourceGroupName"
Write-Host "NamePrefix        : $NamePrefix"
Write-Host ''

Write-Host "Verifying az CLI access to subscription $SubscriptionId without changing the default context..."
$account = Invoke-Az -Arguments @('account', 'show', '-o', 'json') -AsJson
if ($account.id -ne $SubscriptionId) { throw 'Azure returned a different subscription than requested.' }
if ($TenantId -and $account.tenantId -ne $TenantId) { throw 'The selected subscription belongs to a different tenant.' }
if (-not $TenantId) { $TenantId = $account.tenantId }
Write-Host "Using subscription: $SubscriptionId"

Write-Host ''
Write-Host '--- Step 1/4: Resolve Fabric workspace and item IDs ---'
$fabricHeaders = Get-FabricAuthHeaders

if (-not $FabricWorkspaceId) {
    $workspace = Get-FabricWorkspaceByName -WorkspaceName $FabricWorkspaceName -Headers $fabricHeaders
    if (-not $workspace) {
        throw "Fabric workspace '$FabricWorkspaceName' was not found. Run provision-fabric-items.ps1 (T036) first, or pass -FabricWorkspaceId explicitly."
    }
    $FabricWorkspaceId = $workspace.id
}
Write-Host "FabricWorkspaceId : $FabricWorkspaceId"

$lakehouseItem = Get-FabricItemByDisplayName -WorkspaceId $FabricWorkspaceId -DisplayName $LakehouseDisplayName -Headers $fabricHeaders -ExpectedType 'Lakehouse'
if (-not $lakehouseItem) {
    throw "Lakehouse item '$LakehouseDisplayName' was not found in workspace '$FabricWorkspaceId'. Run provision-fabric-items.ps1 (T036) first."
}
Write-Host "LakehouseItemId   : $($lakehouseItem.id)"

$eventstreamItem = Get-FabricItemByDisplayName -WorkspaceId $FabricWorkspaceId -DisplayName $EventstreamDisplayName -Headers $fabricHeaders -ExpectedType 'Eventstream'
if (-not $eventstreamItem) {
    throw "Eventstream item '$EventstreamDisplayName' was not found in workspace '$FabricWorkspaceId'. Run provision-fabric-items.ps1 (T036) first."
}
Write-Host "EventstreamItemId : $($eventstreamItem.id)"

$eventhouseItem = Get-FabricItemByDisplayName -WorkspaceId $FabricWorkspaceId -DisplayName $EventhouseDisplayName -Headers $fabricHeaders -ExpectedType 'Eventhouse'
if (-not $eventhouseItem) {
    throw "Eventhouse item '$EventhouseDisplayName' was not found in workspace '$FabricWorkspaceId'. Run provision-fabric-items.ps1 (T036) first."
}
Write-Host "EventhouseItemId  : $($eventhouseItem.id)"

$kqlDatabaseItem = Get-FabricItemByDisplayName -WorkspaceId $FabricWorkspaceId -DisplayName $EventhouseKqlDatabaseDisplayName -Headers $fabricHeaders -ExpectedType 'KQLDatabase'
if (-not $kqlDatabaseItem) {
    throw "KQL database item '$EventhouseKqlDatabaseDisplayName' was not found in workspace '$FabricWorkspaceId'. Run provision-fabric-items.ps1 (T036) first."
}
Write-Host "KqlDatabaseItemId : $($kqlDatabaseItem.id)"

$eventhouseDetailUri = "https://api.fabric.microsoft.com/v1/workspaces/$FabricWorkspaceId/eventhouses/$($eventhouseItem.id)"
$eventhouseDetail = Invoke-RestMethod -Method Get -Uri $eventhouseDetailUri -Headers $fabricHeaders
$eventhouseQueryUri = $eventhouseDetail.properties.queryServiceUri
if ([string]::IsNullOrWhiteSpace($eventhouseQueryUri)) {
    throw "Eventhouse '$EventhouseDisplayName' (id '$($eventhouseItem.id)') returned no properties.queryServiceUri. Cannot resolve EVENTHOUSE_QUERY_URI."
}
if ($kqlDatabaseItem.id -notin @($eventhouseDetail.properties.databasesItemIds)) {
    throw "KQL database '$EventhouseKqlDatabaseDisplayName' does not belong to Eventhouse '$EventhouseDisplayName'. Cannot pair the database with this query endpoint."
}
Write-Host "EventhouseQueryUri: $eventhouseQueryUri"

Write-Host ''
Write-Host '--- Step 2/4: Grant Fabric-item-querying managed identities a Fabric workspace role ---'
# Retain this demo's workspace-level Contributor policy for its Fabric data-plane identities.
# Azure RBAC on the managed identity alone does not grant access to Fabric items.
$fabricQueryingIdentityNames = @(
    "$NamePrefix-id-streaming-backend",
    "$NamePrefix-id-simulator",
    "$NamePrefix-id-mcp-tools"
)
$grantedWorkspaceRoleAssignments = @()
foreach ($identityName in $fabricQueryingIdentityNames) {
    $identityPrincipalId = ((Invoke-Az -Arguments @(
                'identity', 'show',
                '--name', $identityName,
                '--resource-group', $ResourceGroupName,
                '--query', 'principalId',
                '-o', 'tsv'
            )) -join '').Trim()

    if ([string]::IsNullOrWhiteSpace($identityPrincipalId)) {
        throw "Managed identity '$identityName' was not found in resource group '$ResourceGroupName'. Run provision-azure-resources.ps1 first."
    }

    $granted = Grant-FabricWorkspaceRoleAssignment -WorkspaceId $FabricWorkspaceId -PrincipalId $identityPrincipalId -PrincipalDisplayName $identityName -Role 'Contributor' -Headers $fabricHeaders
    if ($granted) {
        $grantedWorkspaceRoleAssignments += $identityName
    }
}

Write-Host ''
Write-Host '--- Step 3/4: Resolve Eventstream CustomEndpoint source connection ---'
$topologyUri = "https://api.fabric.microsoft.com/v1/workspaces/$FabricWorkspaceId/eventstreams/$($eventstreamItem.id)/topology"
$topology = Invoke-RestMethod -Method Get -Uri $topologyUri -Headers $fabricHeaders
$source = @($topology.sources | Where-Object { $_.name -ieq $EventstreamSourceName }) | Select-Object -First 1
if (-not $source) {
    throw "Eventstream source '$EventstreamSourceName' was not found in the topology of Eventstream '$($eventstreamItem.id)'. Available source names: $(($topology.sources | ForEach-Object { $_.name }) -join ', ')"
}
Write-Host "EventstreamSourceId : $($source.id)"

$connectionUri = "https://api.fabric.microsoft.com/v1/workspaces/$FabricWorkspaceId/eventstreams/$($eventstreamItem.id)/sources/$($source.id)/connection"
$connection = Invoke-RestMethod -Method Get -Uri $connectionUri -Headers $fabricHeaders
if ($connection.type -ne 'CustomEndpoint' -or -not $connection.accessKeys -or -not $connection.accessKeys.primaryConnectionString) {
    throw "Eventstream source connection for '$EventstreamSourceName' did not return the expected CustomEndpoint accessKeys.primaryConnectionString shape (got type '$($connection.type)'). Cannot resolve a usable SAS connection string."
}
Write-Host "EventHubNamespace   : $($connection.fullyQualifiedNamespace)"
Write-Host "EventHubName        : $($connection.eventHubName)"
Write-Host '(SAS connection string resolved -- value intentionally not logged.)'

Write-Host ''
Write-Host '--- Step 4/4: Second-pass Bicep deployment via provision-azure-resources.ps1 ---'
$azureParams = @{
    SubscriptionId                      = $SubscriptionId
    ResourceGroupName                   = $ResourceGroupName
    Location                            = $Location
    FabricLocation                      = $FabricLocation
    FoundryLocation                     = $FoundryLocation
    NamePrefix                          = $NamePrefix
    FabricCapacityAdminUpn              = $FabricCapacityAdminUpn
    ImageTag                            = $ImageTag
    SimulatorDailyScheduleCron          = $SimulatorDailyScheduleCron
    LakehouseOneLakeFileSystem          = $FabricWorkspaceId
    LakehouseOneLakePath                = $lakehouseItem.id
    EventstreamEventHubConnectionString = $connection.accessKeys.primaryConnectionString
    EventhouseQueryUri                  = $eventhouseQueryUri
    EventhouseDatabaseName              = $kqlDatabaseItem.displayName
}
if ($TenantId) {
    $azureParams['TenantId'] = $TenantId
}
if ($PSBoundParameters.ContainsKey('DemoProfile')) {
    $azureParams['DemoProfile'] = $DemoProfile
}
if ($DefaultAthleteId) {
    $azureParams['DefaultAthleteId'] = $DefaultAthleteId
}

if ($PSCmdlet.ShouldProcess($ResourceGroupName, 'Redeploy infra/bicep/main.bicep with resolved Lakehouse/Eventstream/Eventhouse configuration')) {
    $azureResult = & (Join-Path $scriptRoot 'provision-azure-resources.ps1') @azureParams
}
else {
    $azureResult = & (Join-Path $scriptRoot 'provision-azure-resources.ps1') @azureParams -WhatIf
}

$result = [PSCustomObject]@{
    FabricWorkspaceId                 = $FabricWorkspaceId
    LakehouseItemId                    = $lakehouseItem.id
    EventstreamItemId                  = $eventstreamItem.id
    EventstreamSourceId                = $source.id
    EventHubFullyQualifiedNamespace    = $connection.fullyQualifiedNamespace
    EventHubName                       = $connection.eventHubName
    EventhouseItemId                   = $eventhouseItem.id
    EventhouseQueryUri                 = $eventhouseQueryUri
    EventhouseDatabaseName             = $kqlDatabaseItem.displayName
    GrantedWorkspaceRoleAssignments    = $grantedWorkspaceRoleAssignments
    AzureResources                     = $azureResult
}

Write-Host ''
Write-Host 'configure-simulator-connections.ps1 complete.' -ForegroundColor Green

return $result
