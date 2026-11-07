#Requires -Version 7.0
<#
.SYNOPSIS
Creates a brand-new Fabric semantic model item from the committed TMDL definition, bypassing any
tainted datasource history a previous item might carry.

.DESCRIPTION
`Ensure-FabricItem` (provision-fabric-items.ps1) is intentionally create-only and idempotent by
display name -- it will never recreate an item once one with that name exists. This script is a
narrow escape hatch for the one failure mode that requires an actual fresh item: a semantic
model whose `updateDefinition` history left permanent "ghost" datasources bound to it (Power BI
Service's DMTS_MonikerWithUnboundDataSources tracking is additive and is never cleaned up by a
later updateDefinition, even once the M/DAX code no longer references the old paths). Rather than
duplicating `Ensure-FabricItem`'s templating logic by dot-sourcing the entire
provision-fabric-items.ps1 (which would also execute its full top-level provisioning run), this
script reimplements just the minimal request-assembly + create-item + optional-refresh flow needed
for a single SemanticModel item, reusing the exact same
infra/fabric/powerbi-semantic-model/create-semantic-model.request.json part list and
{{WORKSPACE_ID}}/{{LAKEHOUSE_ITEM_ID}} placeholder convention as update-semantic-model-definition.ps1.

.PARAMETER SubscriptionId
Azure subscription ID to use for az CLI context.

.PARAMETER WorkspaceName
Display name of the Fabric workspace. Defaults to `<NamePrefix>-fabric`.

.PARAMETER NamePrefix
Common naming prefix used by the committed payload templates. Defaults to `triatwin-dev`.

.PARAMETER DisplayName
Display name for the new semantic model item to create (must not already exist).

.PARAMETER SkipRefresh
Skip the post-create dataset refresh.

.EXAMPLE
./create-fresh-semantic-model.ps1 -SubscriptionId 7e6d4db3-7e33-54a8-9961-0da1b232e787 -DisplayName triatwin-dev-athlete-trends-semanticmodel-v3
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [string]$SubscriptionId,

    [string]$WorkspaceName,
    [string]$NamePrefix = 'triatwin-dev',

    [Parameter(Mandatory)]
    [string]$DisplayName,

    [switch]$SkipRefresh
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($WorkspaceName)) {
    $WorkspaceName = "$NamePrefix-fabric"
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..' '..')
$semanticModelRoot = Join-Path $repoRoot 'infra' 'fabric' 'powerbi-semantic-model'
$templatePath = Join-Path $semanticModelRoot 'create-semantic-model.request.json'

function Invoke-Az {
    param([string[]]$Arguments, [switch]$AsJson)
    $output = & az @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "az $($Arguments -join ' ') failed: $($output -join [Environment]::NewLine)"
    }
    if ($AsJson) {
        return ($output -join [Environment]::NewLine) | ConvertFrom-Json -Depth 100
    }
    return $output
}

function Get-DefinitionPartSourcePath {
    param([string]$SourceRoot, [string]$PartPath)
    if ($PartPath -eq '.platform') {
        return Join-Path $SourceRoot '.platform.json'
    }
    return Join-Path $SourceRoot ($PartPath -replace '/', '\')
}

function ConvertTo-Utf8Base64 {
    param([string]$Text)
    return [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Text))
}

function Resolve-PlaceholderText {
    param([string]$Text, [hashtable]$Replacements)
    $result = $Text
    foreach ($key in $Replacements.Keys) {
        $result = $result.Replace("{{$key}}", [string]$Replacements[$key])
    }
    return $result
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
    return @{ Authorization = "Bearer $accessToken"; Accept = 'application/json' }
}

function Get-PowerBiAuthHeaders {
    $accessToken = ((Invoke-Az -Arguments @(
                'account', 'get-access-token',
                '--resource', 'https://analysis.windows.net/powerbi/api',
                '--query', 'accessToken',
                '-o', 'tsv'
            )) -join '').Trim()
    if ([string]::IsNullOrWhiteSpace($accessToken)) {
        throw 'Failed to acquire a Power BI API access token from `az account get-access-token`.'
    }
    return @{ Authorization = "Bearer $accessToken" }
}

function Wait-FabricLongRunningOperation {
    param(
        [Parameter(Mandatory)][string]$OperationId,
        [int]$InitialRetryAfterSeconds = 5,
        [Parameter(Mandatory)][hashtable]$Headers
    )
    $stateUri = "https://api.fabric.microsoft.com/v1/operations/$OperationId"
    $retryAfterSeconds = if ($InitialRetryAfterSeconds -gt 0) { $InitialRetryAfterSeconds } else { 5 }
    $maxAttempts = 60
    $attempt = 0
    $state = $null
    do {
        Start-Sleep -Seconds $retryAfterSeconds
        $attempt++
        $state = Invoke-RestMethod -Method Get -Uri $stateUri -Headers $Headers -ErrorAction Stop
    } while ($state.status -notin @('Succeeded', 'Failed') -and $attempt -lt $maxAttempts)

    if ($state.status -ne 'Succeeded') {
        $errorDetail = if ($state.error) { ($state.error | ConvertTo-Json -Compress -Depth 10) } else { "(last status: $($state.status))" }
        throw "Fabric long-running operation '$OperationId' did not succeed: $errorDetail"
    }
    return $state
}

Write-Host "Verifying az CLI login and setting subscription to $SubscriptionId..."
$account = Invoke-Az -Arguments @('account', 'show', '-o', 'json') -AsJson
if ($account.id -ne $SubscriptionId) {
    Invoke-Az -Arguments @('account', 'set', '--subscription', $SubscriptionId) | Out-Null
}

$fabricHeaders = Get-FabricAuthHeaders

Write-Host "Looking up Fabric workspace '$WorkspaceName'..."
$workspacesResponse = Invoke-RestMethod -Method Get -Uri 'https://api.fabric.microsoft.com/v1/workspaces?roles=Admin' -Headers $fabricHeaders
$workspace = $workspacesResponse.value | Where-Object { $_.displayName -ieq $WorkspaceName } | Select-Object -First 1
if (-not $workspace) {
    throw "Fabric workspace '$WorkspaceName' was not found (or is not visible to the current principal)."
}
$workspaceId = $workspace.id
Write-Host "  workspace id: $workspaceId"

Write-Host "Looking up Lakehouse item (needed to resolve LAKEHOUSE_ITEM_ID in expressions.tmdl)..."
$itemsResponse = Invoke-RestMethod -Method Get -Uri "https://api.fabric.microsoft.com/v1/workspaces/$workspaceId/items" -Headers $fabricHeaders
$lakehouseItem = $itemsResponse.value | Where-Object { $_.type -eq 'Lakehouse' } | Select-Object -First 1
if (-not $lakehouseItem) {
    throw "No Lakehouse item was found in workspace '$WorkspaceName'."
}
Write-Host "  lakehouse id: $($lakehouseItem.id)"

$existing = $itemsResponse.value | Where-Object { $_.type -eq 'SemanticModel' -and $_.displayName -ieq $DisplayName } | Select-Object -First 1
if ($existing) {
    throw "A SemanticModel named '$DisplayName' already exists (id $($existing.id)). Delete it first or choose a different -DisplayName."
}

$replacements = @{
    WORKSPACE_ID      = $workspaceId
    LAKEHOUSE_ITEM_ID = $lakehouseItem.id
}

$template = Get-Content -Raw -Path $templatePath | ConvertFrom-Json -Depth 100
$parts = @()
foreach ($templatePart in $template.definition.parts) {
    $sourcePath = Get-DefinitionPartSourcePath -SourceRoot $semanticModelRoot -PartPath $templatePart.path
    if (-not (Test-Path $sourcePath)) {
        throw "Definition-part source file for path '$($templatePart.path)' was not found at '$sourcePath'."
    }
    $sourceText = Resolve-PlaceholderText -Text ([System.IO.File]::ReadAllText($sourcePath)) -Replacements $replacements
    $parts += [PSCustomObject]@{
        path        = $templatePart.path
        payload     = ConvertTo-Utf8Base64 -Text $sourceText
        payloadType = 'InlineBase64'
    }
}
Write-Host "Assembled $($parts.Count) definition parts from $semanticModelRoot."

$createBody = [PSCustomObject]@{
    displayName = $DisplayName
    definition  = [PSCustomObject]@{ parts = $parts }
} | ConvertTo-Json -Depth 100

if (-not $PSCmdlet.ShouldProcess($DisplayName, 'Create fresh SemanticModel item')) {
    Write-Host "What-if: would create semantic model '$DisplayName' in workspace $workspaceId."
    return
}

Write-Host "Creating semantic model '$DisplayName'..."
$createUri = "https://api.fabric.microsoft.com/v1/workspaces/$workspaceId/semanticModels"
$createResponse = Invoke-WebRequest -Method Post -Uri $createUri -Headers ($fabricHeaders + @{ 'Content-Type' = 'application/json' }) -Body $createBody -UseBasicParsing

$semanticModelId = $null
if ($createResponse.StatusCode -eq 201) {
    $semanticModelId = ($createResponse.Content | ConvertFrom-Json -Depth 100).id
}
elseif ($createResponse.StatusCode -eq 202) {
    $operationId = $createResponse.Headers['x-ms-operation-id']
    if ($operationId -is [System.Array]) { $operationId = $operationId[0] }
    $retryAfter = $createResponse.Headers['Retry-After']
    if ($retryAfter -is [System.Array]) { $retryAfter = $retryAfter[0] }
    $retryAfterSeconds = 5
    if ($retryAfter) { [void][int]::TryParse($retryAfter, [ref]$retryAfterSeconds) }
    Write-Host "Create returned 202 Accepted (operation $operationId); polling to completion..."
    $finalState = Wait-FabricLongRunningOperation -OperationId $operationId -InitialRetryAfterSeconds $retryAfterSeconds -Headers $fabricHeaders
    if ($finalState.PSObject.Properties.Name -contains 'id') {
        $semanticModelId = $finalState.id
    }
}

if (-not $semanticModelId) {
    $itemsResponse = Invoke-RestMethod -Method Get -Uri "https://api.fabric.microsoft.com/v1/workspaces/$workspaceId/items" -Headers $fabricHeaders
    $created = $itemsResponse.value | Where-Object { $_.type -eq 'SemanticModel' -and $_.displayName -ieq $DisplayName } | Select-Object -First 1
    if (-not $created) {
        throw "Semantic model '$DisplayName' create call completed, but the item could not be resolved afterwards."
    }
    $semanticModelId = $created.id
}
Write-Host "Created semantic model '$DisplayName' with id '$semanticModelId'."

$result = [PSCustomObject]@{
    WorkspaceId        = $workspaceId
    SemanticModelId    = $semanticModelId
    DisplayName        = $DisplayName
    RefreshStatus      = $null
    RefreshErrorDetail = $null
}

if ($SkipRefresh) {
    return $result
}

Write-Host 'Triggering a full dataset refresh so Direct Lake frames + the DAX calculated table processes...'
$powerBiHeaders = Get-PowerBiAuthHeaders
$refreshUri = "https://api.powerbi.com/v1.0/myorg/groups/$workspaceId/datasets/$semanticModelId/refreshes"
Invoke-WebRequest -Method Post -Uri $refreshUri -Headers ($powerBiHeaders + @{ 'Content-Type' = 'application/json' }) -Body '{"type":"full"}' -UseBasicParsing | Out-Null

$refreshStatus = $null
$maxAttempts = 24
for ($attempt = 0; $attempt -lt $maxAttempts; $attempt++) {
    Start-Sleep -Seconds 5
    $refreshes = Invoke-RestMethod -Uri "$refreshUri`?`$top=1" -Headers $powerBiHeaders
    $refreshStatus = $refreshes.value[0].status
    Write-Host "  refresh status: $refreshStatus"
    if ($refreshStatus -in @('Completed', 'Failed')) { break }
}

$result.RefreshStatus = $refreshStatus
if ($refreshStatus -eq 'Failed') {
    $latestRefresh = $refreshes.value[0]
    $result.RefreshErrorDetail = $latestRefresh.serviceExceptionJson
    Write-Warning "Dataset refresh failed: $($latestRefresh.serviceExceptionJson)"
}
elseif ($refreshStatus -ne 'Completed') {
    Write-Warning "Dataset refresh did not reach a terminal state within $($maxAttempts * 5)s (last status: $refreshStatus)."
}

return $result
