#Requires -Version 7.0
<#
.SYNOPSIS
Verifies or creates the public Mining catalog, DirectLake model, and native Data Agent in the approved isolated workspace.
.DESCRIPTION
Verify is read-only. Apply is explicit, limited to workspace 4a809e56-42a8-4c30-a84f-83a47dd8793f,
and creates only the schema-enabled Mining Lakehouse, public catalog tables, semantic model, and Data Agent.
It never changes workspace capacity, identities, roles, or shared/TriTwin items.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$TargetPath,
    [Parameter(Mandatory)][string]$CatalogReceiptPath,
    [Parameter(Mandatory)][string]$NativeReceiptPath,
    [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspaceId = [guid]'4a809e56-42a8-4c30-a84f-83a47dd8793f'

foreach ($path in @($TargetPath, $CatalogReceiptPath, $NativeReceiptPath)) {
    if (-not [IO.Path]::IsPathFullyQualified($path) -or
        -not (Test-Path -LiteralPath (Split-Path $path -Parent) -PathType Container)) {
        throw 'Target and receipt paths must be absolute and their parent directories must exist.'
    }
}
if (-not (Test-Path -LiteralPath $TargetPath -PathType Leaf)) { throw 'TargetPath must name an existing file.' }
if ($CatalogReceiptPath -ceq $NativeReceiptPath) { throw 'Catalog and native item receipts must use different paths.' }
if ($Apply -and -not $PSCmdlet.ShouldProcess(
        "$workspaceId", 'Materialize the public Mining catalog and create/publish Mining-only Fabric items')) {
    return [pscustomobject]@{ Status = 'WhatIf'; WorkspaceId = $workspaceId.ToString() }
}

$target = Get-Content -LiteralPath $TargetPath -Raw | ConvertFrom-Json -AsHashtable
$targetFields = @('TenantId', 'SubscriptionId', 'WorkspaceId', 'CallerObjectId')
if (@(Compare-Object -ReferenceObject $targetFields -DifferenceObject @($target.Keys) -CaseSensitive).Count -gt 0) {
    throw 'Target file must contain only TenantId, SubscriptionId, WorkspaceId, and CallerObjectId.'
}
foreach ($field in $targetFields) {
    $value = [guid]::Empty
    if (-not $target.Contains($field) -or
        -not [guid]::TryParseExact([string]$target[$field], 'D', [ref]$value) -or $value -eq [guid]::Empty) {
        throw "Target file requires a valid exact $field GUID."
    }
    $target[$field] = $value.ToString()
}
if ($target.WorkspaceId -ine $workspaceId.ToString()) {
    throw 'Target must identify the approved isolated workspace.'
}

Import-Module (Join-Path $PSScriptRoot '..\mining-ontology\MiningOntology.psm1') -Force
$fabricAccessToken = Get-MiningValidatedAccessToken `
    -TenantId $target.TenantId -CallerObjectId $target.CallerObjectId `
    -CallerApplicationId '40eca1a3-d05c-4cdf-9770-b59969b4fff2' `
    -Resource 'https://api.fabric.microsoft.com'
Import-Module (Join-Path $PSScriptRoot 'MiningIsolatedItems.psm1') -Force
$bootstrapClient = @{
    request = {
        param($Method, $Uri, $Body)
        $handler = [Net.Http.HttpClientHandler]::new()
        $handler.AllowAutoRedirect = $false
        $http = [Net.Http.HttpClient]::new($handler)
        $http.Timeout = [TimeSpan]::FromSeconds(60)
        $message = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($Method), $Uri)
        $message.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $fabricAccessToken)
        $null = $message.Headers.TryAddWithoutValidation('Accept', 'application/json')
        if ($null -ne $Body) {
            $message.Content = [Net.Http.StringContent]::new([string]$Body, [Text.Encoding]::UTF8, 'application/json')
        }
        try {
            $response = $http.SendAsync($message).GetAwaiter().GetResult()
            try {
                $responseBytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
                $headers = @{}
                foreach ($header in $response.Headers) { $headers[$header.Key] = $header.Value -join ',' }
                foreach ($header in $response.Content.Headers) { $headers[$header.Key] = $header.Value -join ',' }
                $contentType = $response.Content.Headers.ContentType
                $responseBody = if ($responseBytes.Length -eq 0) { $null } else {
                    $responseText = [Text.Encoding]::UTF8.GetString($responseBytes)
                    if ($contentType -and $contentType.MediaType -match '(^|[+/])json$') {
                        $responseText | ConvertFrom-Json -AsHashtable -Depth 100
                    } else { $responseText }
                }
                return @{ statusCode = [int]$response.StatusCode; headers = $headers; body = $responseBody }
            } finally { $response.Dispose() }
        } finally { $message.Dispose(); $http.Dispose() }
    }.GetNewClosure()
    sleep = { param($Seconds) Start-Sleep -Seconds $Seconds }
}

$lakehouse = Ensure-MiningIsolatedLakehouse -WorkspaceId $workspaceId `
    -ReceiptPath $NativeReceiptPath -Client $bootstrapClient -Apply:$Apply
$resolvedTarget = $lakehouse.Target
$resolvedTarget.TenantId = $target.TenantId
$resolvedTarget.SubscriptionId = $target.SubscriptionId
$resolvedTarget.CallerObjectId = $target.CallerObjectId

$sourceClient = New-MiningLiveClient $resolvedTarget
$catalogMode = if ($Apply -and -not (Test-Path -LiteralPath $CatalogReceiptPath)) { 'Apply' } else { 'Verify' }
$catalog = Invoke-MiningCatalogLoad `
    -CatalogPath (Join-Path $PSScriptRoot '..\..\apps\simulator\src\mining\plant-catalog.json') `
    -Target $resolvedTarget -ReceiptPath $CatalogReceiptPath -Mode $catalogMode -Client $sourceClient

$nativeClient = @{
    request = {
        param($Method, $Uri, $Body)
        $requestBody = if ($null -eq $Body) { $null } else { $Body | ConvertFrom-Json -AsHashtable -Depth 100 }
        $result = & $sourceClient.request @{
            method = $Method; uri = $Uri; audience = 'Fabric'; body = $requestBody
            headers = @{}; responseType = 'Json'; contentType = 'application/json'
        }
        return @{ statusCode = $result.statusCode; headers = $result.headers; body = $result.body }
    }.GetNewClosure()
    sleep = $sourceClient.sleep
}
$result = Invoke-MiningIsolatedNativeItems -WorkspaceId $workspaceId `
    -LakehouseId ([guid]$resolvedTarget.StaticLakehouseId) `
    -ReceiptPath $NativeReceiptPath -Client $nativeClient -Apply:$Apply
$result | Add-Member -NotePropertyName CatalogStatus -NotePropertyValue $catalog.status
$result | Add-Member -NotePropertyName LakehouseStatus -NotePropertyValue $lakehouse.Status
$result
