#Requires -Version 7.0
<#
.SYNOPSIS
Creates the Power BI report item from the committed definition, resolving the semantic model it
binds to at creation time.

.DESCRIPTION
Mirrors create-fresh-semantic-model.ps1's minimal create-item flow for the one other Fabric item
type in this workspace that provisioning never actually created live: the Report. Reads
infra/fabric/powerbi-report/create-report.request.json for its ordered part list, resolves
{{WORKSPACE_ID}}/{{NAME_PREFIX}}/{{SEMANTIC_MODEL_ITEM_ID}} placeholders (the last one is what
binds definition.pbir's byConnection reference to a specific semantic model item), base64-encodes
each part, and POSTs to /v1/workspaces/{workspaceId}/reports.

.PARAMETER SubscriptionId
Azure subscription ID to use for az CLI context.

.PARAMETER WorkspaceName
Display name of the Fabric workspace. Defaults to `<NamePrefix>-fabric`.

.PARAMETER NamePrefix
Common naming prefix used by the committed payload templates. Defaults to `triatwin-dev`.

.PARAMETER SemanticModelDisplayName
Display name of the semantic model the report should bind to. Defaults to
`<NamePrefix>-athlete-trends-semanticmodel`.

.PARAMETER DisplayName
Display name for the new report item. Defaults to `<NamePrefix>-athlete-trends-report`.

.EXAMPLE
./create-fresh-report.ps1 -SubscriptionId 7e6d4db3-7e33-54a8-9961-0da1b232e787
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [string]$SubscriptionId,

    [string]$WorkspaceName,
    [string]$NamePrefix = 'triatwin-dev',
    [string]$SemanticModelDisplayName,
    [string]$DisplayName
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($WorkspaceName)) {
    $WorkspaceName = "$NamePrefix-fabric"
}
if ([string]::IsNullOrWhiteSpace($SemanticModelDisplayName)) {
    $SemanticModelDisplayName = "$NamePrefix-athlete-trends-semanticmodel"
}
if ([string]::IsNullOrWhiteSpace($DisplayName)) {
    $DisplayName = "$NamePrefix-athlete-trends-report"
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..' '..')
$reportRoot = Join-Path $repoRoot 'infra' 'fabric' 'powerbi-report'
$templatePath = Join-Path $reportRoot 'create-report.request.json'

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

$itemsResponse = Invoke-RestMethod -Method Get -Uri "https://api.fabric.microsoft.com/v1/workspaces/$workspaceId/items" -Headers $fabricHeaders

$semanticModelItem = $itemsResponse.value | Where-Object { $_.type -eq 'SemanticModel' -and $_.displayName -ieq $SemanticModelDisplayName } | Select-Object -First 1
if (-not $semanticModelItem) {
    throw "Semantic model '$SemanticModelDisplayName' was not found in workspace '$WorkspaceName'."
}
Write-Host "  semantic model id: $($semanticModelItem.id)"

$existing = $itemsResponse.value | Where-Object { $_.type -eq 'Report' -and $_.displayName -ieq $DisplayName } | Select-Object -First 1
if ($existing) {
    throw "A Report named '$DisplayName' already exists (id $($existing.id)). Delete it first or choose a different -DisplayName."
}

$replacements = @{
    WORKSPACE_ID          = $workspaceId
    NAME_PREFIX            = $NamePrefix
    SEMANTIC_MODEL_ITEM_ID = $semanticModelItem.id
}

$template = Get-Content -Raw -Path $templatePath | ConvertFrom-Json -Depth 100
$parts = @()
foreach ($templatePart in $template.definition.parts) {
    $sourcePath = Get-DefinitionPartSourcePath -SourceRoot $reportRoot -PartPath $templatePart.path
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
Write-Host "Assembled $($parts.Count) definition parts from $reportRoot."

$createBody = [PSCustomObject]@{
    displayName = $DisplayName
    definition  = [PSCustomObject]@{ parts = $parts }
} | ConvertTo-Json -Depth 100

if (-not $PSCmdlet.ShouldProcess($DisplayName, 'Create Report item')) {
    Write-Host "What-if: would create report '$DisplayName' in workspace $workspaceId bound to semantic model $($semanticModelItem.id)."
    return
}

Write-Host "Creating report '$DisplayName' bound to semantic model $($semanticModelItem.id)..."
$createUri = "https://api.fabric.microsoft.com/v1/workspaces/$workspaceId/reports"
$createResponse = Invoke-WebRequest -Method Post -Uri $createUri -Headers ($fabricHeaders + @{ 'Content-Type' = 'application/json' }) -Body $createBody -UseBasicParsing

$reportId = $null
if ($createResponse.StatusCode -eq 201) {
    $reportId = ($createResponse.Content | ConvertFrom-Json -Depth 100).id
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
        $reportId = $finalState.id
    }
}

if (-not $reportId) {
    $itemsResponse = Invoke-RestMethod -Method Get -Uri "https://api.fabric.microsoft.com/v1/workspaces/$workspaceId/items" -Headers $fabricHeaders
    $created = $itemsResponse.value | Where-Object { $_.type -eq 'Report' -and $_.displayName -ieq $DisplayName } | Select-Object -First 1
    if (-not $created) {
        throw "Report '$DisplayName' create call completed, but the item could not be resolved afterwards."
    }
    $reportId = $created.id
}
Write-Host "Created report '$DisplayName' with id '$reportId'."

return [PSCustomObject]@{
    WorkspaceId     = $workspaceId
    ReportId        = $reportId
    SemanticModelId = $semanticModelItem.id
    DisplayName     = $DisplayName
}
