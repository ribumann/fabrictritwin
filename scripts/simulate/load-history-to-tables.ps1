#Requires -Version 7.0
<#
.SYNOPSIS
Runs the "load-history-to-tables" Fabric Notebook, loading every seeded athlete's OneLake
Files/ JSONL data into the Lakehouse's Delta Tables/ area.

.DESCRIPTION
Implements T060c (specs/001-triathlon-training-twin/tasks.md). This closes the gap left by T036
("Lakehouse table DDL ... is intentionally not executed") and by seed-history.ts (which only
writes JSONL files under OneLake Files/, never Delta Tables/): without running this notebook,
Direct Lake / the Power BI report / the Fabric Data Agent have zero rows to query even after a
successful seed-history run.

The notebook self-discovers every seeded athlete folder under Files/history-seeding/{Environment}/
via notebookutils.fs.ls() and loads them all in one run unless AthleteId selects a single athlete.

Run this AFTER `scripts/simulate/seed-history.ps1` has seeded at least one athlete, and AFTER
`scripts/provision/provision-fabric-items.ps1` has created the notebook item (T036).

Uses the Fabric notebook release API directly
(`POST .../notebooks/{id}/jobs/execute/instances?beta=false`) with typed top-level parameters.
The API supports service principals and managed identities when the Fabric tenant enables
"Service principals can use Fabric APIs" and the identity has workspace Contributor access.
This helper uses the explicitly selected Azure CLI identity; scheduled simulator runs acquire
their own managed-identity token, never a stored user token. A successful delegated helper run
does not prove managed-identity readiness. Idempotent: the notebook MERGEs on each table's natural
key, so re-running never duplicates rows.
Reference: https://learn.microsoft.com/rest/api/fabric/notebook/background-jobs/run-on-demand-notebook

.PARAMETER SubscriptionId
Azure subscription ID explicitly passed when acquiring the Fabric bearer token.
The signed-in CLI's default subscription is never changed.

.PARAMETER FabricWorkspaceName
Exact display name of the Fabric workspace. Defaults to `<NamePrefix>-fabric`.

.PARAMETER NamePrefix
Naming prefix used to derive default workspace/notebook display names. Defaults to `triatwin-dev`.

.PARAMETER NotebookDisplayName
Exact display name of the notebook item created by provision-fabric-items.ps1 (T060c). Defaults
to `<NamePrefix>-load-history-to-tables`.

.PARAMETER AthleteId
Optional athlete GUID to narrow the notebook run to a single seeded athlete. Leave unset (the
default) to load every athlete folder the notebook discovers under
Files/history-seeding/{Environment}/ -- this is the normal path for the daily simulator run.
Passed as a Text parameter to the notebook release API. Earlier beta endpoint/payload attempts
did not reliably inject parameters; this helper no longer uses those contracts.

.PARAMETER Environment
Logical environment name. Must match the `-Environment` already passed to seed-history.ps1.
Defaults to 'dev'. Passed as a Text parameter named environment to the notebook release API.

.PARAMETER TimeoutSeconds
Maximum time to wait for the notebook run to reach a terminal state. Defaults to 900 (15 minutes).

.OUTPUTS
JSON written to stdout describing the job instance's final status.

.EXAMPLE
./scripts/simulate/load-history-to-tables.ps1 -SubscriptionId 7e6d4db3-7e33-54a8-9961-0da1b232e787
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [string]$SubscriptionId,

    [string]$FabricWorkspaceName,
    [string]$NamePrefix = 'triatwin-dev',
    [string]$NotebookDisplayName,

    [string]$AthleteId,

    [string]$Environment = 'dev',

    [ValidateRange(1, 86400)]
    [int]$TimeoutSeconds = 900
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

function Get-FabricAuthHeaders {
    param([Parameter(Mandatory)][string]$SubscriptionId)

    $accessToken = ((Invoke-Az -Arguments @(
                'account', 'get-access-token',
                '--subscription', $SubscriptionId,
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
        [Parameter(Mandatory)]
        [string]$WorkspaceName,

        [Parameter(Mandatory)]
        [hashtable]$Headers
    )

    $response = Invoke-RestMethod -Method Get -Uri 'https://api.fabric.microsoft.com/v1/workspaces' -Headers $Headers
    $matches = @($response.value | Where-Object { $_.displayName -eq $WorkspaceName })
    if ($matches.Count -eq 0) {
        throw "No Fabric workspace named '$WorkspaceName' is visible to the caller. Run provision-fabric-items.ps1 first."
    }
    if ($matches.Count -gt 1) {
        throw "Multiple Fabric workspaces named '$WorkspaceName' are visible. Refusing to guess which one to use."
    }

    return $matches[0]
}

function Get-FabricItemByDisplayName {
    param(
        [Parameter(Mandatory)]
        [string]$WorkspaceId,

        [Parameter(Mandatory)]
        [string]$DisplayName,

        [Parameter(Mandatory)]
        [hashtable]$Headers,

        [string]$ExpectedType
    )

    $response = Invoke-RestMethod -Method Get -Uri "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/items" -Headers $Headers
    $matches = @($response.value | Where-Object { $_.displayName -eq $DisplayName -and (-not $ExpectedType -or $_.type -eq $ExpectedType) })
    if ($matches.Count -eq 0) {
        throw "No Fabric item named '$DisplayName' (type '$ExpectedType') was found in workspace '$WorkspaceId'. Run provision-fabric-items.ps1 first."
    }
    if ($matches.Count -gt 1) {
        throw "Multiple Fabric items named '$DisplayName' are visible in workspace '$WorkspaceId'. Refusing to guess which one to use."
    }

    return $matches[0]
}

function Get-FabricResponseHeaderValue {
    param(
        $Headers,
        [string]$Name
    )

    if (-not $Headers) {
        return $null
    }

    foreach ($key in $Headers.Keys) {
        if ($key -ieq $Name) {
            $value = $Headers[$key]
            if ($value -is [array]) {
                return $value[0]
            }
            return $value
        }
    }

    return $null
}

function Invoke-RunNotebookJob {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)]
        [string]$WorkspaceId,

        [Parameter(Mandatory)]
        [string]$NotebookId,

        [Parameter(Mandatory)]
        [hashtable]$Headers,

        [string]$AthleteId,

        [string]$Environment
    )

    if (-not $PSCmdlet.ShouldProcess($NotebookId, 'Run Fabric notebook job')) {
        return $null
    }

    # beta=false selects the MI-supported release contract, including top-level typed parameters.
    $parameters = @()
    if ($AthleteId) { $parameters += @{ name = 'athlete_id'; value = $AthleteId; type = 'Text' } }
    if ($Environment) { $parameters += @{ name = 'environment'; value = $Environment; type = 'Text' } }
    $body = @{ parameters = $parameters; executionData = @{ compute = 'Spark' } } | ConvertTo-Json -Depth 10

    $response = Invoke-WebRequest `
        -Method Post `
        -Uri "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/notebooks/$NotebookId/jobs/execute/instances?beta=false" `
        -Headers $Headers `
        -ContentType 'application/json' `
        -Body $body

    if ($response.StatusCode -ne 202) {
        throw "Expected HTTP 202 Accepted from RunNotebook, got $($response.StatusCode)."
    }

    $location = Get-FabricResponseHeaderValue -Headers $response.Headers -Name 'Location'
    if (-not $location) {
        throw 'RunNotebook response did not include a Location header to poll for job status.'
    }

    $retryAfter = Get-FabricResponseHeaderValue -Headers $response.Headers -Name 'Retry-After'
    return [PSCustomObject]@{
        Uri = $location
        InitialDelaySeconds = if ($retryAfter) { [Math]::Max(0, [int]$retryAfter) } else { 0 }
    }
}

function Wait-FabricJobInstance {
    param(
        [Parameter(Mandatory)]
        [string]$JobInstanceUri,

        [Parameter(Mandatory)]
        [hashtable]$Headers,

        [int]$TimeoutSeconds = 900,

        [int]$InitialDelaySeconds = 0,

        [int]$PollIntervalSeconds = 10
    )

    $elapsed = 0
    $instance = $null
    if ($InitialDelaySeconds -gt 0) {
        $elapsed = [Math]::Min($InitialDelaySeconds, $TimeoutSeconds)
        Start-Sleep -Seconds $elapsed
    }
    while ($elapsed -lt $TimeoutSeconds) {
        $instance = Invoke-RestMethod -Method Get -Uri $JobInstanceUri -Headers $Headers
        Write-Host "  [$($elapsed)s] status: $($instance.status)"
        if ($instance.status -in @('Completed', 'Failed', 'Cancelled', 'Deduped')) {
            break
        }
        Start-Sleep -Seconds $PollIntervalSeconds
        $elapsed += $PollIntervalSeconds
    }

    if (-not $instance -or $instance.status -notin @('Completed', 'Failed', 'Cancelled', 'Deduped')) {
        throw "Timed out after ${TimeoutSeconds}s waiting for notebook job instance to reach a terminal state (last status: '$($instance.status)')."
    }

    if ($instance.status -ne 'Completed') {
        $failureDetail = if ($instance.failureReason) { ($instance.failureReason | ConvertTo-Json -Compress -Depth 10) } else { '(no failure detail returned)' }
        throw "Notebook job instance finished with status '$($instance.status)': $failureDetail"
    }

    return $instance
}

function Invoke-LoadHistoryToTables {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)]
        [string]$SubscriptionId,

        [string]$FabricWorkspaceName,
        [string]$NamePrefix = 'triatwin-dev',
        [string]$NotebookDisplayName,

        [string]$AthleteId,

        [string]$Environment = 'dev',

        [int]$TimeoutSeconds = 900
    )

    $resolvedWorkspaceName = if ($FabricWorkspaceName) { $FabricWorkspaceName } else { "$NamePrefix-fabric" }
    $resolvedNotebookName = if ($NotebookDisplayName) { $NotebookDisplayName } else { "$NamePrefix-load-history-to-tables" }

    $headers = Get-FabricAuthHeaders -SubscriptionId $SubscriptionId

    Write-Host "Resolving Fabric workspace '$resolvedWorkspaceName'..."
    $workspace = Get-FabricWorkspaceByName -WorkspaceName $resolvedWorkspaceName -Headers $headers

    Write-Host "Resolving notebook '$resolvedNotebookName' in workspace '$($workspace.id)'..."
    $notebook = Get-FabricItemByDisplayName -WorkspaceId $workspace.id -DisplayName $resolvedNotebookName -Headers $headers -ExpectedType 'Notebook'

    $athleteDescription = if ($AthleteId) { "athlete '$AthleteId'" } else { 'every seeded athlete' }
    Write-Host "Running notebook '$($notebook.id)' for $athleteDescription (environment '$Environment')..."
    $submission = Invoke-RunNotebookJob -WorkspaceId $workspace.id -NotebookId $notebook.id -Headers $headers -AthleteId $AthleteId -Environment $Environment

    if (-not $submission) {
        Write-Host 'What-if: notebook run was not submitted.'
        return [PSCustomObject]@{
            WorkspaceId = $workspace.id
            NotebookId  = $notebook.id
            AthleteId   = $AthleteId
            Environment = $Environment
            Status      = 'WhatIfSkipped'
        }
    }

    Write-Host "Waiting for notebook job instance to complete (timeout: ${TimeoutSeconds}s)..."
    $instance = Wait-FabricJobInstance -JobInstanceUri $submission.Uri -Headers $headers -TimeoutSeconds $TimeoutSeconds -InitialDelaySeconds $submission.InitialDelaySeconds

    Write-Host "Notebook run completed for $athleteDescription."
    return [PSCustomObject]@{
        WorkspaceId  = $workspace.id
        NotebookId   = $notebook.id
        AthleteId    = $AthleteId
        Environment  = $Environment
        Status       = $instance.status
        JobInstance  = $instance
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $result = Invoke-LoadHistoryToTables `
        -SubscriptionId $SubscriptionId `
        -FabricWorkspaceName $FabricWorkspaceName `
        -NamePrefix $NamePrefix `
        -NotebookDisplayName $NotebookDisplayName `
        -AthleteId $AthleteId `
        -Environment $Environment `
        -TimeoutSeconds $TimeoutSeconds
    $result | ConvertTo-Json -Depth 100
}
