#Requires -Version 7.0

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [string]$SubscriptionId,

    [string]$ResourceGroupName = 'rg-triathlon-twin-demo',
    [string]$Location = 'polandcentral',
    [string]$FabricLocation = 'italynorth',
    [string]$FoundryLocation = 'swedencentral',
    [string]$FabricWorkspaceName,
    [string]$NamePrefix = 'triatwin-dev',
    [string]$FabricCapacityAdminUpn = 'admin@example.invalid',
    [string]$TenantId,
    [string]$ImageTag = 'placeholder',
    [ValidateSet('live', 'synthetic')]
    [string]$DemoProfile,
    [string]$SimulatorDailyScheduleCron = '0 3 * * *',
    [string]$DefaultAthleteId,
    [switch]$SkipSimulatorConnectionsConfig,
    [switch]$ConfigureRuntime,
    [string]$FabricDataAgentId,
    [string]$FabricConnectionId,
    [string]$FabricConnectionName = 'athlete-fabric-data',
    [string]$ModelDeploymentName,
    [string[]]$AuthorizedUserObjectIds = @(),
    [object]$AssistantAuthResult,
    [object]$PowerBiEmbeddingResult,
    [switch]$ConfigurePowerBiEmbedding,
    [string]$PowerBiReportId,
    [string[]]$PowerBiAllowedPrincipalIds = @(),
    [switch]$ApprovePowerBiTenantSettings
)

$ErrorActionPreference = 'Stop'
$scriptRoot = $PSScriptRoot

if ($ConfigureRuntime -and (-not $TenantId -or -not $DefaultAthleteId)) {
    throw '-ConfigureRuntime requires explicit -TenantId and -DefaultAthleteId; the current CLI user is never treated as an authorized athlete.'
}
if ($ConfigurePowerBiEmbedding -and (-not $TenantId -or -not $PowerBiReportId -or $PowerBiAllowedPrincipalIds.Count -eq 0)) {
    throw '-ConfigurePowerBiEmbedding requires explicit -TenantId, -PowerBiReportId, and -PowerBiAllowedPrincipalIds.'
}
foreach ($requiredCompanion in @(
    $(if ($ConfigureRuntime -and $AuthorizedUserObjectIds.Count -gt 0) { 'configure-assistant-auth.ps1' }),
    $(if ($ConfigurePowerBiEmbedding) { 'configure-powerbi-embedding.ps1' })
)) {
    if ($requiredCompanion -and -not (Test-Path (Join-Path $scriptRoot $requiredCompanion))) {
        throw "Required companion '$requiredCompanion' is missing. Integrate the credential-setup workstream before running this option."
    }
}

Write-Host '=== provision-all.ps1 (T037): Azure resources, Fabric items, simulator connections ===' -ForegroundColor Cyan
Write-Host ''

$currentStep = 'provision-azure-resources.ps1 (T035)'
try {
    Write-Host "--- Step 1/3: $currentStep ---" -ForegroundColor Cyan
    $azureParams = @{
        SubscriptionId         = $SubscriptionId
        ResourceGroupName      = $ResourceGroupName
        Location               = $Location
        FabricLocation         = $FabricLocation
        FoundryLocation        = $FoundryLocation
        NamePrefix             = $NamePrefix
        FabricCapacityAdminUpn = $FabricCapacityAdminUpn
        ImageTag               = $ImageTag
        SimulatorDailyScheduleCron = $SimulatorDailyScheduleCron
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
    $azureResult = & (Join-Path $scriptRoot 'provision-azure-resources.ps1') @azureParams
}
catch {
    Write-Error "provision-all.ps1 failed at step '$currentStep': $($_.Exception.Message)"
    exit 1
}

$currentStep = 'provision-fabric-items.ps1 (T036)'
try {
    Write-Host ''
    Write-Host "--- Step 2/3: $currentStep ---" -ForegroundColor Cyan
    $fabricParams = @{
        SubscriptionId         = $SubscriptionId
        ResourceGroupName      = $ResourceGroupName
        FabricCapacityName     = $azureResult.FabricCapacityName
        NamePrefix             = $NamePrefix
        FabricCapacityAdminUpn = $FabricCapacityAdminUpn
    }
    if ($FabricWorkspaceName) {
        $fabricParams['FabricWorkspaceName'] = $FabricWorkspaceName
    }
    $fabricResult = & (Join-Path $scriptRoot 'provision-fabric-items.ps1') @fabricParams
}
catch {
    Write-Error "provision-all.ps1 failed at step '$currentStep': $($_.Exception.Message)"
    exit 1
}

$simulatorConnectionsResult = $null
if (-not $SkipSimulatorConnectionsConfig) {
    $currentStep = 'configure-simulator-connections.ps1 (T059b)'
    try {
        Write-Host ''
        Write-Host "--- Step 3/3: $currentStep ---" -ForegroundColor Cyan
        $connectionsParams = @{
            SubscriptionId             = $SubscriptionId
            ResourceGroupName          = $ResourceGroupName
            FabricWorkspaceId          = $fabricResult.FabricWorkspaceId
            NamePrefix                 = $NamePrefix
            Location                   = $Location
            FabricLocation             = $FabricLocation
            FoundryLocation            = $FoundryLocation
            FabricCapacityAdminUpn     = $FabricCapacityAdminUpn
            ImageTag                   = $ImageTag
            SimulatorDailyScheduleCron = $SimulatorDailyScheduleCron
        }
        if ($TenantId) {
            $connectionsParams['TenantId'] = $TenantId
        }
        if ($PSBoundParameters.ContainsKey('DemoProfile')) {
            $connectionsParams['DemoProfile'] = $DemoProfile
        }
        if ($DefaultAthleteId) {
            $connectionsParams['DefaultAthleteId'] = $DefaultAthleteId
        }
        $simulatorConnectionsResult = & (Join-Path $scriptRoot 'configure-simulator-connections.ps1') @connectionsParams
    }
    catch {
        Write-Error "provision-all.ps1 failed at step '$currentStep': $($_.Exception.Message)"
        exit 1
    }
}
else {
    Write-Host ''
    Write-Host '--- Step 3/3: configure-simulator-connections.ps1 (T059b) skipped (-SkipSimulatorConnectionsConfig) ---' -ForegroundColor Yellow
}

$runtimeResult = $null
if ($ConfigureRuntime -and $AuthorizedUserObjectIds.Count -gt 0) {
    $authParams = @{
        SubscriptionId = $SubscriptionId; TenantId = $TenantId
        ResourceGroupName = $ResourceGroupName; NamePrefix = $NamePrefix
        AuthorizedUserObjectIds = $AuthorizedUserObjectIds; AthleteId = $DefaultAthleteId
    }
    $AssistantAuthResult = & (Join-Path $scriptRoot 'configure-assistant-auth.ps1') @authParams
}
if ($ConfigurePowerBiEmbedding) {
    $powerBiParams = @{
        SubscriptionId = $SubscriptionId; TenantId = $TenantId; ResourceGroupName = $ResourceGroupName
        CockpitAppName = "$NamePrefix-cockpit"; WorkspaceId = $fabricResult.FabricWorkspaceId
        ReportId = $PowerBiReportId; AllowedPrincipalIds = $PowerBiAllowedPrincipalIds
        ApproveTenantSettings = [bool]$ApprovePowerBiTenantSettings
    }
    $PowerBiEmbeddingResult = & (Join-Path $scriptRoot 'configure-powerbi-embedding.ps1') @powerBiParams
    if ($PowerBiEmbeddingResult.Status -eq 'TenantSettingsRequired') {
        Write-Warning 'Power BI requires tenant-admin action. See PowerBiEmbedding.RequiredTenantSettings in the returned result.'
    }
}
if ($ConfigureRuntime) {
    if (-not $FabricDataAgentId) {
        $dataAgents = @($fabricResult.Items | Where-Object { $_.LogicalName -eq 'DataAgent' })
        if ($dataAgents.Count -eq 1) { $FabricDataAgentId = $dataAgents[0].Id }
    }
    if (-not $FabricDataAgentId) { throw 'Supply -FabricDataAgentId for the published native Data Agent.' }
    $runtimeParams = @{
        SubscriptionId = $SubscriptionId; TenantId = $TenantId
        ResourceGroupName = $ResourceGroupName; NamePrefix = $NamePrefix
        FabricWorkspaceId = $fabricResult.FabricWorkspaceId; FabricDataAgentId = $FabricDataAgentId
        AthleteId = $DefaultAthleteId; FabricConnectionName = $FabricConnectionName
        AssistantAuthResult = $AssistantAuthResult; PowerBiEmbeddingResult = $PowerBiEmbeddingResult
    }
    if ($FabricConnectionId) { $runtimeParams.FabricConnectionId = $FabricConnectionId }
    if ($ModelDeploymentName) { $runtimeParams.ModelDeploymentName = $ModelDeploymentName }
    $runtimeResult = & (Join-Path $scriptRoot 'configure-runtime-connections.ps1') @runtimeParams
}

$result = [PSCustomObject]@{
    AzureResources        = $azureResult
    FabricItems           = $fabricResult
    SimulatorConnections  = $simulatorConnectionsResult
    AssistantAuth         = $AssistantAuthResult
    PowerBiEmbedding      = $PowerBiEmbeddingResult
    RuntimeConnections    = $runtimeResult
}

Write-Host ''
Write-Host 'provision-all.ps1 complete -- Azure resources, Fabric items, and simulator connections provisioned.' -ForegroundColor Green

return $result
