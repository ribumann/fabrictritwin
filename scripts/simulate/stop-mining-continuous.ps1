#Requires -Version 7.0
<#
.SYNOPSIS
Persist/read back an immutable D01 generation stop using the current Azure CLI login.
.DESCRIPTION
No tokens in arguments/files. No permissions, account selection, capacity, plant
lease or run records are changed. Default is read-only; -Apply persists intent,
not send settlement or Fabric completion. Supply the exact configured generation
and storage target; never remove a hold to resume.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][guid]$TenantId,
    [Parameter(Mandatory)][guid]$CallerPrincipalId,
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9_.()-]{1,90}$')][string]$ResourceGroupName,
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9]{3,24}$')][string]$StorageAccountName,
    [Parameter(Mandatory)][ValidateLength(12, 63)][ValidatePattern('^mining-state(?:-[a-z0-9]+)*\z')][string]$ContainerName,
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\z')][string]$Generation,
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\provision\runtime-arm.ps1')
$accountOutput = & az account show --subscription $SubscriptionId.ToString() --output json --only-show-errors 2>&1
if ($LASTEXITCODE -ne 0) { throw 'Cannot read the explicitly selected subscription.' }
$account = ($accountOutput -join "`n") | ConvertFrom-Json
if ($account.id -cne $SubscriptionId.ToString() -or $account.tenantId -cne $TenantId.ToString()) {
    throw 'The selected subscription/tenant does not match; no stop attempted.'
}
$storageOutput = & az storage account show --subscription $SubscriptionId.ToString() `
    --resource-group $ResourceGroupName --name $StorageAccountName --output json --only-show-errors 2>&1
if ($LASTEXITCODE -ne 0) { throw 'Cannot verify the exact selected storage account; no stop attempted.' }
$storage = ($storageOutput -join "`n") | ConvertFrom-Json
$expectedId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroupName/providers/Microsoft.Storage/storageAccounts/$StorageAccountName"
$endpoint = "https://$StorageAccountName.blob.core.windows.net/"
if ($storage.id -ine $expectedId -or $storage.primaryEndpoints.blob -cne $endpoint) {
    throw 'Storage metadata does not match the explicitly selected target; no stop attempted.'
}
$uri = "${endpoint}$ContainerName/continuous/holds/$Generation.json"
if ($Apply -and -not $PSCmdlet.ShouldProcess($uri, 'Persist immutable D01 generation stop intent')) { return }
$token = Get-RuntimeAccessToken -SubscriptionId $SubscriptionId -TenantId $TenantId -Resource 'https://storage.azure.com/'
try {
    $segments = $token.Split('.')
    if ($segments.Length -ne 3) { throw 'Invalid token shape.' }
    $payload = $segments[1].Replace('-', '+').Replace('_', '/')
    $payload = $payload.PadRight($payload.Length + ((4 - $payload.Length % 4) % 4), '=')
    $caller = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json
} catch { throw 'Cannot confirm the selected Azure CLI caller; no stop attempted. Token details suppressed.' }
if ($caller.oid -cne $CallerPrincipalId.ToString() -or $caller.tid -cne $TenantId.ToString()) {
    throw 'Azure CLI token caller/tenant does not match the explicitly approved caller; no stop attempted.'
}
$headers = @{
    Authorization = "Bearer $token"; 'x-ms-version' = '2023-11-03'
    'x-ms-date' = [DateTime]::UtcNow.ToString('R')
}
if ($Apply) {
    $writeHeaders = $headers.Clone()
    $writeHeaders['If-None-Match'] = '*'
    $writeHeaders['x-ms-blob-type'] = 'BlockBlob'
    $body = @{ version = 1; plantId = 'D01'; generation = $Generation; requestedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
    try {
        $write = Invoke-WebRequest -Method PUT -Uri $uri -Headers $writeHeaders -Body $body `
            -ContentType 'application/json' -SkipHttpErrorCheck -MaximumRedirection 0 -TimeoutSec 30 -Verbose:$false -Debug:$false
    } catch { throw 'Generation stop write outcome is unknown. Re-run read-only to reconcile; details suppressed.' }
    if ([int]$write.StatusCode -notin @(201, 412)) {
        throw "Generation stop write returned HTTP $([int]$write.StatusCode). Reconcile read-only; no retry or alternate target attempted."
    }
}
try {
    $read = Invoke-WebRequest -Method GET -Uri $uri -Headers $headers -SkipHttpErrorCheck `
        -MaximumRedirection 0 -TimeoutSec 30 -Verbose:$false -Debug:$false
} catch { throw 'Generation stop readback is unavailable; intent is unconfirmed. Details suppressed.' }
if ([int]$read.StatusCode -eq 404 -and -not $Apply) {
    return [pscustomobject]@{ Status = 'NoGenerationHold'; TargetUri = $uri; Generation = $Generation; StopRequested = $false; DeliveryCompleted = $false }
}
if ([int]$read.StatusCode -ne 200) { throw "Generation stop readback returned HTTP $([int]$read.StatusCode); intent unconfirmed." }
if ([Text.Encoding]::UTF8.GetByteCount([string]$read.Content) -gt 16384) { throw 'Invalid generation stop readback size.' }
try { $hold = ConvertFrom-Json -InputObject $read.Content -AsHashtable }
catch { throw 'Invalid generation stop readback JSON.' }
$timestamp = [DateTimeOffset]::MinValue
$requestedAt = if ($hold.requestedAt -is [DateTime]) {
    $hold.requestedAt.ToUniversalTime().ToString('o')
} else { [string]$hold.requestedAt }
if ($hold -isnot [System.Collections.IDictionary] -or
    (($hold.Keys | Sort-Object) -join ',') -cne 'generation,plantId,requestedAt,version' -or
    $hold.version -ne 1 -or $hold.plantId -cne 'D01' -or $hold.generation -cne $Generation -or
    -not [DateTimeOffset]::TryParse($requestedAt, [ref]$timestamp)) {
    throw 'Generation stop readback does not match the selected D01 generation.'
}
[pscustomobject]@{
    Status = 'StopIntentConfirmed'; TargetUri = $uri; Generation = $Generation; StopRequested = $true
    RequestedAt = $requestedAt; DeliveryCompleted = $false
}
