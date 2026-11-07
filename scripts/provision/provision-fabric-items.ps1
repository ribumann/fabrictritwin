#Requires -Version 7.0

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [string]$SubscriptionId,

    [string]$ResourceGroupName = 'rg-triathlon-twin-demo',
    [string]$FabricCapacityName,
    [string]$FabricWorkspaceName,
    [string]$NamePrefix = 'triatwin-dev',
    [string]$FabricCapacityAdminUpn = 'admin@example.invalid',
    [string]$OperationsRecipientUpn,
    [string]$TeamsTeamId = '00000000-0000-0000-0000-000000000000',
    [string]$TeamsChannelId = '19:00000000000000000000000000000000@thread.tacv2',
    [string]$OpsNotebookItemId = '00000000-0000-0000-0000-000000000000',
    [string]$PowerAutomateActionId,
    [string]$AzureEventHubConnectionId
)

$ErrorActionPreference = 'Stop'
$script:RootCmdlet = $PSCmdlet

function Get-DefaultFabricCapacityName {
    param([string]$NamePrefix)

    $capacityName = ($NamePrefix.ToLowerInvariant() -replace '-', '') + 'fabriccap'
    if ($capacityName.Length -gt 63) {
        return $capacityName.Substring(0, 63)
    }

    return $capacityName
}

if ([string]::IsNullOrWhiteSpace($FabricCapacityName)) {
    $FabricCapacityName = Get-DefaultFabricCapacityName -NamePrefix $NamePrefix
}

if ([string]::IsNullOrWhiteSpace($FabricWorkspaceName)) {
    $FabricWorkspaceName = "$NamePrefix-fabric"
}

if ([string]::IsNullOrWhiteSpace($OperationsRecipientUpn)) {
    $OperationsRecipientUpn = $FabricCapacityAdminUpn
}

if ([string]::IsNullOrWhiteSpace($PowerAutomateActionId)) {
    $hashBytes = [System.Security.Cryptography.MD5]::HashData([System.Text.Encoding]::UTF8.GetBytes("$NamePrefix::POWER_AUTOMATE_ACTION_ID"))
    $hex = [System.BitConverter]::ToString($hashBytes).Replace('-', '').ToLowerInvariant()
    $PowerAutomateActionId = ([guid]::ParseExact($hex, 'N')).Guid
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
$infraFabricRoot = Join-Path $repoRoot 'infra' 'fabric'
$resumeCapacityScriptPath = Join-Path $repoRoot 'scripts' 'fabric' 'resume-capacity.ps1'
$workspaceRoot = Join-Path $infraFabricRoot 'workspace'
$eventhouseRoot = Join-Path $infraFabricRoot 'eventhouse'
$eventstreamRoot = Join-Path $infraFabricRoot 'eventstream'
$lakehouseRoot = Join-Path $infraFabricRoot 'lakehouse'
$notebooksRoot = Join-Path $infraFabricRoot 'notebooks'
$powerBISemanticModelRoot = Join-Path $infraFabricRoot 'powerbi-semantic-model'
$powerBIReportRoot = Join-Path $infraFabricRoot 'powerbi-report'
$digitalTwinRoot = Join-Path $infraFabricRoot 'digital-twin-builder'
$activatorRoot = Join-Path $infraFabricRoot 'activator'
$dataAgentRoot = Join-Path $infraFabricRoot 'fabric-data-agent'
$operationsAgentRoot = Join-Path $infraFabricRoot 'fabric-operations-agent'

foreach ($requiredPath in @(
        $resumeCapacityScriptPath,
        (Join-Path $workspaceRoot 'create-workspace.request.json'),
        (Join-Path $workspaceRoot 'assign-to-capacity.request.json'),
        (Join-Path $eventhouseRoot 'create-eventhouse.request.json'),
        (Join-Path $eventhouseRoot 'create-kql-database.request.json'),
        (Join-Path $eventstreamRoot 'create-eventstream.request.json'),
        (Join-Path $lakehouseRoot 'create-lakehouse.request.json'),
        (Join-Path $powerBISemanticModelRoot 'create-semantic-model.request.json'),
        (Join-Path $powerBIReportRoot 'create-report.request.json'),
        (Join-Path $digitalTwinRoot 'create-digital-twin-builder.request.json'),
        (Join-Path $digitalTwinRoot 'create-ontology.request.json'),
        (Join-Path $activatorRoot 'create-reflex.request.json'),
        (Join-Path $dataAgentRoot 'create-data-agent.request.json'),
        (Join-Path $operationsAgentRoot 'create-operations-agent.compat.request.json'),
        (Join-Path $operationsAgentRoot 'create-operations-agent.request.json')
    )) {
    if (-not (Test-Path $requiredPath)) {
        throw "Required provisioning artifact not found at '$requiredPath'. Run this script from a checkout of the fabrictritwin repository."
    }
}

$script:Warnings = [System.Collections.Generic.List[string]]::new()

function Add-ProvisioningWarning {
    param([string]$Message)

    Write-Warning $Message
    $script:Warnings.Add($Message) | Out-Null
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

function Assert-AzureContext {
    param([string]$SubscriptionId)

    Write-Host "Verifying az CLI access to subscription $SubscriptionId without changing the default context..."
    $account = Invoke-Az -Arguments @('account', 'show', '-o', 'json') -AsJson
    if ($account.id -ne $SubscriptionId) { throw 'Azure returned a different subscription than requested.' }
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

function Get-FabricResponseHeaderValue {
    # -ResponseHeadersVariable populates a Dictionary[string, IEnumerable[string]] whose key
    # casing mirrors whatever the server sent (observed as lower-case, e.g.
    # 'x-ms-operation-id', for Fabric's LRO headers) -- so this looks up case-insensitively
    # rather than assuming a specific casing.
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

function Wait-FabricLongRunningOperation {
    # Implements the Fabric LRO polling contract documented at
    # https://learn.microsoft.com/rest/api/fabric/articles/long-running-operation: an
    # initial 202 Accepted response carries 'x-ms-operation-id' (and 'Retry-After')
    # response headers; poll GET /v1/operations/{id} until status is Succeeded/Failed,
    # then GET /v1/operations/{id}/result for the final created/updated resource (if any).
    param(
        [Parameter(Mandatory)]
        [string]$OperationId,

        [int]$InitialRetryAfterSeconds = 5,

        [Parameter(Mandatory)]
        [hashtable]$Headers
    )

    $stateUri = "https://api.fabric.microsoft.com/v1/operations/$OperationId"
    $retryAfterSeconds = if ($InitialRetryAfterSeconds -gt 0) { $InitialRetryAfterSeconds } else { 5 }
    # 60 attempts at the observed ~20s Retry-After matches the ~20 minute wait Microsoft's
    # own documented LRO example uses for a single item-creation operation.
    $maxAttempts = 60
    $attempt = 0
    $state = $null

    do {
        Start-Sleep -Seconds $retryAfterSeconds
        $attempt++
        $state = Invoke-RestMethod -Method Get -Uri $stateUri -Headers $Headers -ErrorAction Stop
    } while ($state.status -notin @('Succeeded', 'Failed') -and $attempt -lt $maxAttempts)

    if ($state.status -eq 'Failed') {
        $errorDetail = if ($state.error) { ($state.error | ConvertTo-Json -Compress -Depth 10) } else { '(no error detail returned)' }
        throw "Fabric long-running operation '$OperationId' failed: $errorDetail"
    }

    if ($state.status -ne 'Succeeded') {
        throw "Fabric long-running operation '$OperationId' did not reach a terminal state within $maxAttempts polling attempts (last status: '$($state.status)')."
    }

    # Not every LRO has a result payload (e.g. some delete operations complete with none);
    # a failure fetching the result here is treated as "no result", not a hard error, since
    # the operation itself already reported Succeeded above.
    try {
        return Invoke-RestMethod -Method Get -Uri "$stateUri/result" -Headers $Headers -ErrorAction Stop
    }
    catch {
        return $null
    }
}

function Test-IsItemDisplayNameNotAvailableYetError {
    param(
        [int]$StatusCode,
        [string]$Details
    )

    return $StatusCode -eq 409 -and $Details -match '(?i)ItemDisplayNameNotAvailableYet'
}

function Invoke-FabricRestMethod {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('Get', 'Post', 'Delete')]
        [string]$Method,

        [Parameter(Mandatory)]
        [string]$Uri,

        [Parameter(Mandatory)]
        [hashtable]$Headers,

        [string]$Body,

        # Retry policy for the transient HTTP 409 ItemDisplayNameNotAvailableYet error that
        # Fabric can return on item-create (POST) calls. Bounded so a genuinely stuck name
        # (or an unrelated persistent 409) still fails the script rather than hanging forever.
        [int[]]$DisplayNameRetryDelaysSeconds = @(15, 30, 60, 120, 180)
    )

    $attempt = 0
    while ($true) {
        try {
            $responseHeaders = $null
            $invokeParams = @{
                Method                  = $Method
                Uri                     = $Uri
                Headers                 = $Headers
                ErrorAction             = 'Stop'
                ResponseHeadersVariable = 'responseHeaders'
            }

            if ($PSBoundParameters.ContainsKey('Body')) {
                $invokeParams.Body = $Body
                $invokeParams.ContentType = 'application/json'
            }

            $response = Invoke-RestMethod @invokeParams

            $operationId = Get-FabricResponseHeaderValue -Headers $responseHeaders -Name 'x-ms-operation-id'
            if ($operationId) {
                $retryAfterRaw = Get-FabricResponseHeaderValue -Headers $responseHeaders -Name 'Retry-After'
                $retryAfterSeconds = 5
                if ($retryAfterRaw) { [void][int]::TryParse($retryAfterRaw, [ref]$retryAfterSeconds) }

                Write-Host "Fabric API $Method $Uri returned an async operation ($operationId); polling until it completes (initial Retry-After: ${retryAfterSeconds}s)..."
                $response = Wait-FabricLongRunningOperation -OperationId $operationId -InitialRetryAfterSeconds $retryAfterSeconds -Headers $Headers
            }

            return [PSCustomObject]@{
                Body    = $response
                Headers = $responseHeaders
            }
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

            $details = if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
                $_.ErrorDetails.Message
            }
            else {
                $_.Exception.Message
            }

            if ($Method -eq 'Post' -and (Test-IsItemDisplayNameNotAvailableYetError -StatusCode $statusCode -Details $details) -and $attempt -lt $DisplayNameRetryDelaysSeconds.Count) {
                $delaySeconds = $DisplayNameRetryDelaysSeconds[$attempt]
                $attempt++
                Write-Host "Fabric API $Method $Uri returned HTTP 409 ItemDisplayNameNotAvailableYet (transient, isRetriable) -- waiting ${delaySeconds}s then retrying (attempt $attempt of $($DisplayNameRetryDelaysSeconds.Count))..."
                Start-Sleep -Seconds $delaySeconds
                continue
            }

            throw "Fabric API $Method $Uri failed$($(if ($statusCode) { " (HTTP $statusCode)" } else { '' })): $details"
        }
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
        $pageMatches = @($response.Body.value | Where-Object { $_.displayName -ieq $WorkspaceName })
        if ($pageMatches.Count -gt 0) {
            $matches += $pageMatches
        }

        $requestUri = $response.Body.continuationUri
    } while ($requestUri)

    if ($matches.Count -gt 1) {
        throw "Multiple Fabric workspaces named '$WorkspaceName' are visible to the current principal. Refusing to guess which one to reuse."
    }

    if ($matches.Count -eq 0) {
        return $null
    }

    return $matches[0]
}

function Get-FabricItemByDisplayName {
    param(
        [string]$WorkspaceId,
        [string]$DisplayName,
        [hashtable]$Headers,
        [string]$ExpectedType
    )

    $requestUri = "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/items"
    $matches = @()

    do {
        $response = Invoke-FabricRestMethod -Method Get -Uri $requestUri -Headers $Headers
        $pageMatches = @($response.Body.value | Where-Object { $_.displayName -ieq $DisplayName })
        if ($pageMatches.Count -gt 0) {
            $matches += $pageMatches
        }

        $requestUri = $response.Body.continuationUri
    } while ($requestUri)

    if ($matches.Count -gt 1 -and $ExpectedType) {
        $matches = @($matches | Where-Object { $_.type -ieq $ExpectedType })
    }

    if ($matches.Count -gt 1) {
        throw "Multiple Fabric items named '$DisplayName' are visible in workspace '$WorkspaceId'. Refusing to guess which one to reuse."
    }

    if ($matches.Count -eq 0) {
        return $null
    }

    return $matches[0]
}

function Get-FabricCapacityByDisplayName {
    param(
        [string]$CapacityName,
        [hashtable]$Headers
    )

    $requestUri = 'https://api.fabric.microsoft.com/v1/capacities'
    $matches = @()

    do {
        $response = Invoke-FabricRestMethod -Method Get -Uri $requestUri -Headers $Headers
        $pageMatches = @($response.Body.value | Where-Object { $_.displayName -ieq $CapacityName })
        if ($pageMatches.Count -gt 0) {
            $matches += $pageMatches
        }

        $requestUri = $response.Body.continuationUri
    } while ($requestUri)

    if ($matches.Count -gt 1) {
        throw "Multiple Fabric capacities named '$CapacityName' are visible to the current principal. Refusing to guess which one to use."
    }

    if ($matches.Count -eq 0) {
        throw "No Fabric capacity named '$CapacityName' is visible to the current principal via GET https://api.fabric.microsoft.com/v1/capacities. Confirm the capacity exists and the caller has at least Viewer access to it."
    }

    return $matches[0]
}

function New-DeterministicGuid {
    param([string]$Seed)

    $hashBytes = [System.Security.Cryptography.MD5]::HashData([System.Text.Encoding]::UTF8.GetBytes($Seed))
    $hex = [System.BitConverter]::ToString($hashBytes).Replace('-', '').ToLowerInvariant()
    return [guid]::ParseExact($hex, 'N')
}

function ConvertTo-UpperSnakeCase {
    param([string]$Value)

    return (($Value -replace '[^A-Za-z0-9]+', '_').Trim('_')).ToUpperInvariant()
}

function New-EventstreamConnectionName {
    param(
        [string]$NamePrefix,
        [string]$Suffix
    )

    $normalized = (($NamePrefix -replace '[^A-Za-z0-9-]', '-') + '-' + ($Suffix -replace '[^A-Za-z0-9-]', '-')).Trim('-')
    $hash = (New-DeterministicGuid -Seed "$NamePrefix::$Suffix").Guid.Replace('-', '').Substring(0, 6)
    $maxStemLength = 40 - $hash.Length - 1
    if ($normalized.Length -gt $maxStemLength) {
        $normalized = $normalized.Substring(0, $maxStemLength).TrimEnd('-')
    }

    return "$normalized-$hash"
}

function Resolve-TemplateText {
    param(
        [Parameter(Mandatory)]
        [string]$Text,

        [Parameter(Mandatory)]
        [hashtable]$Replacements,

        [Parameter(Mandatory)]
        [string]$SourceDescription,

        [string[]]$AllowedUnresolvedPlaceholders = @()
    )

    $result = $Text
    $placeholderNames = [regex]::Matches($Text, '\{\{([A-Z0-9_]+)\}\}') |
        ForEach-Object { $_.Groups[1].Value } |
        Sort-Object -Unique

    foreach ($placeholderName in $placeholderNames) {
        $token = "{{${placeholderName}}}"

        if ($Replacements.ContainsKey($placeholderName) -and $null -ne $Replacements[$placeholderName]) {
            $result = $result.Replace($token, [string]$Replacements[$placeholderName])
            continue
        }

        if ($AllowedUnresolvedPlaceholders -contains $placeholderName) {
            continue
        }

        if ($placeholderName -match '_ID$') {
            $generatedGuid = (New-DeterministicGuid -Seed "$($Replacements.NAME_PREFIX)::$placeholderName").Guid
            $Replacements[$placeholderName] = $generatedGuid
            $result = $result.Replace($token, $generatedGuid)
            continue
        }

        throw "Template '$SourceDescription' contains unresolved placeholder '$token'."
    }

    return $result
}

function Get-DefinitionPartSourcePath {
    param(
        [string]$SourceRoot,
        [string]$PartPath
    )

    if ($PartPath -eq '.platform') {
        return Join-Path $SourceRoot '.platform.json'
    }

    return Join-Path $SourceRoot ($PartPath -replace '/', '\')
}

function ConvertTo-Utf8Base64 {
    param([string]$Text)

    return [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Text))
}

function ConvertTo-JsonEscapedSingleLine {
    param([string]$Text)

    return ((ConvertTo-Json $Text -Compress) -replace '^"|"$', '')
}

function Get-ActivatorEscapedReplacements {
    param(
        [string]$InstancesRoot,
        [hashtable]$Replacements
    )

    $result = @{}
    $stemOverrides = @{
        'nutrition-fueling-shortfall' = 'FUELING_SHORTFALL'
        'missed-session-gap'          = 'MISSED_SESSION'
        'race-pace-drift'             = 'RACE_PACE_DRIFT'
        'sustained-high-hr'           = 'SUSTAINED_HIGH_HR'
        'unsafe-acwr'                 = 'UNSAFE_ACWR'
    }

    foreach ($file in Get-ChildItem -Path $InstancesRoot -Filter '*.json' -File) {
        $fileStem = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
        if ($fileStem.StartsWith('sourceevent-')) {
            $logicalStem = $fileStem.Substring('sourceevent-'.Length)
        }
        elseif ($fileStem.StartsWith('rule-')) {
            $logicalStem = $fileStem.Substring('rule-'.Length)
        }
        else {
            continue
        }

        $placeholderStem = if ($stemOverrides.ContainsKey($logicalStem)) {
            $stemOverrides[$logicalStem]
        }
        else {
            ConvertTo-UpperSnakeCase -Value $logicalStem
        }

        if ($fileStem.StartsWith('sourceevent-')) {
            $placeholderName = "${placeholderStem}_SOURCE_EVENT_INSTANCE_ESCAPED"
        }
        else {
            $placeholderName = "${placeholderStem}_RULE_INSTANCE_ESCAPED"
        }

        $resolvedText = Resolve-TemplateText `
            -Text ([System.IO.File]::ReadAllText($file.FullName)) `
            -Replacements $Replacements `
            -SourceDescription $file.FullName

        $result[$placeholderName] = ConvertTo-JsonEscapedSingleLine -Text $resolvedText
    }

    return $result
}

function New-RequestBodyFromTemplate {
    param(
        [string]$TemplatePath,
        [hashtable]$Replacements,
        [string]$DefinitionSourceRoot,
        [hashtable]$DefinitionSourceOverrides = @{},
        [string[]]$AllowedUnresolvedPlaceholders = @(),
        [string]$DisplayNameOverride
    )

    $templateText = [System.IO.File]::ReadAllText($TemplatePath)
    $templateAllowedPlaceholders = @($AllowedUnresolvedPlaceholders)
    $templateAllowedPlaceholders += (
        [regex]::Matches($templateText, '\{\{([A-Z0-9_]+(?:_B64|_ESCAPED))\}\}') |
            ForEach-Object { $_.Groups[1].Value }
    )

    $resolvedTemplateText = Resolve-TemplateText `
        -Text $templateText `
        -Replacements $Replacements `
        -SourceDescription $TemplatePath `
        -AllowedUnresolvedPlaceholders ($templateAllowedPlaceholders | Sort-Object -Unique)

    $requestBody = $resolvedTemplateText | ConvertFrom-Json -Depth 100
    if ($DisplayNameOverride) {
        $requestBody.displayName = $DisplayNameOverride
    }

    if ($requestBody.PSObject.Properties.Name -contains 'definition' -and $requestBody.definition -and $requestBody.definition.parts) {
        foreach ($part in @($requestBody.definition.parts)) {
            if ($part.payloadType -ne 'InlineBase64') {
                continue
            }

            if ($part.payload -match '^\{\{([A-Z0-9_]+)\}\}$') {
                $placeholderName = $Matches[1]
                $sourcePath = if ($DefinitionSourceOverrides.ContainsKey($placeholderName)) {
                    $DefinitionSourceOverrides[$placeholderName]
                }
                else {
                    Get-DefinitionPartSourcePath -SourceRoot $DefinitionSourceRoot -PartPath $part.path
                }

                if (-not (Test-Path $sourcePath)) {
                    throw "Definition-part source file for placeholder '$placeholderName' was not found at '$sourcePath'."
                }

                $sourceText = [System.IO.File]::ReadAllText($sourcePath)
                $resolvedSourceText = Resolve-TemplateText `
                    -Text $sourceText `
                    -Replacements $Replacements `
                    -SourceDescription $sourcePath `
                    -AllowedUnresolvedPlaceholders $AllowedUnresolvedPlaceholders

                $part.payload = ConvertTo-Utf8Base64 -Text $resolvedSourceText
            }
        }
    }

    return $requestBody | ConvertTo-Json -Depth 100
}

function New-ItemStatus {
    param(
        [string]$LogicalName,
        [string]$DisplayName,
        [string]$ItemId,
        [string]$ItemType,
        [string]$Status
    )

    return [PSCustomObject]@{
        LogicalName = $LogicalName
        DisplayName = $DisplayName
        Id          = $ItemId
        Type        = $ItemType
        Status      = $Status
    }
}

function Ensure-FabricWorkspace {
    param(
        [string]$WorkspaceName,
        [string]$CapacityId,
        [hashtable]$Headers,
        [hashtable]$Replacements
    )

    $workspace = Get-FabricWorkspaceByName -WorkspaceName $WorkspaceName -Headers $Headers
    if ($workspace) {
        Write-Host "Fabric workspace '$WorkspaceName' already exists with id '$($workspace.id)' -- reusing."
        return [PSCustomObject]@{
            Id     = $workspace.id
            Status = 'Existing'
        }
    }

    if (-not $script:RootCmdlet.ShouldProcess($WorkspaceName, 'Create Fabric workspace')) {
        Write-Host "What-if: would create Fabric workspace '$WorkspaceName'."
        return [PSCustomObject]@{
            Id     = $null
            Status = 'WhatIfSkipped'
        }
    }

    $requestBody = New-RequestBodyFromTemplate `
        -TemplatePath (Join-Path $workspaceRoot 'create-workspace.request.json') `
        -Replacements $Replacements `
        -DisplayNameOverride $WorkspaceName

    $response = Invoke-FabricRestMethod -Method Post -Uri 'https://api.fabric.microsoft.com/v1/workspaces' -Headers $Headers -Body $requestBody
    $workspace = Get-FabricWorkspaceByName -WorkspaceName $WorkspaceName -Headers $Headers
    if (-not $workspace -and $response.Body -and $response.Body.id) {
        $workspace = [PSCustomObject]@{
            id          = $response.Body.id
            displayName = $WorkspaceName
        }
    }

    if (-not $workspace) {
        throw "Fabric workspace '$WorkspaceName' create call completed, but the workspace could not be resolved afterwards."
    }

    Write-Host "Created Fabric workspace '$WorkspaceName' with id '$($workspace.id)'."
    return [PSCustomObject]@{
        Id     = $workspace.id
        Status = 'Created'
    }
}

function Invoke-AssignWorkspaceToCapacity {
    param(
        [string]$WorkspaceId,
        [string]$CapacityId,
        [hashtable]$Headers,
        [hashtable]$Replacements
    )

    if (-not $WorkspaceId) {
        Write-Host 'Skipping workspace-to-capacity assignment because no workspace ID is available (likely -WhatIf mode).'
        return
    }

    if (-not $script:RootCmdlet.ShouldProcess($WorkspaceId, "Assign Fabric workspace to capacity '$CapacityId'")) {
        return
    }

    $requestBody = New-RequestBodyFromTemplate `
        -TemplatePath (Join-Path $workspaceRoot 'assign-to-capacity.request.json') `
        -Replacements $Replacements

    Invoke-FabricRestMethod `
        -Method Post `
        -Uri "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/assignToCapacity" `
        -Headers $Headers `
        -Body $requestBody | Out-Null

    Write-Host "Workspace '$WorkspaceId' assigned/reconciled to capacity '$CapacityId'."
}

function Ensure-FabricItem {
    param(
        [string]$LogicalName,
        [string]$DisplayName,
        [string]$WorkspaceId,
        [string]$ExpectedType,
        [string]$CreateUri,
        [string]$TemplatePath,
        [string]$DefinitionSourceRoot,
        [hashtable]$Replacements,
        [hashtable]$Headers,
        [hashtable]$DefinitionSourceOverrides = @{},
        [string[]]$AllowedUnresolvedPlaceholders = @(),

        # When the item already exists, push the template's `definition` (config/content
        # parts) live via updateDefinition instead of silently skipping. This is what makes
        # re-running this script idempotently pick up config-file changes (e.g. Data Agent
        # datasource/fewshots/stage_config edits) on an already-provisioned environment,
        # rather than requiring a manual one-off REST call every time. Only meaningful for
        # item types that support updateDefinition and whose create template has a
        # `definition` block (e.g. DataAgent) -- items without one are left as create-only.
        [switch]$UpdateDefinitionIfExists
    )

    if (-not $WorkspaceId) {
        Write-Host "Skipping $LogicalName because no workspace ID is available (likely -WhatIf mode before workspace creation)."
        return (New-ItemStatus -LogicalName $LogicalName -DisplayName $DisplayName -ItemId $null -ItemType $ExpectedType -Status 'WhatIfSkipped')
    }

    $existing = Get-FabricItemByDisplayName -WorkspaceId $WorkspaceId -DisplayName $DisplayName -Headers $Headers -ExpectedType $ExpectedType
    if ($existing) {
        if (-not $UpdateDefinitionIfExists) {
            Write-Host "$LogicalName '$DisplayName' already exists with id '$($existing.id)' -- skipping."
            return (New-ItemStatus -LogicalName $LogicalName -DisplayName $DisplayName -ItemId $existing.id -ItemType $existing.type -Status 'Existing')
        }

        if (-not $script:RootCmdlet.ShouldProcess($DisplayName, "Update $LogicalName definition")) {
            Write-Host "What-if: would update $LogicalName '$DisplayName' (id '$($existing.id)') definition."
            return (New-ItemStatus -LogicalName $LogicalName -DisplayName $DisplayName -ItemId $existing.id -ItemType $existing.type -Status 'WhatIfSkipped')
        }

        $requestBodyJson = New-RequestBodyFromTemplate `
            -TemplatePath $TemplatePath `
            -Replacements $Replacements `
            -DefinitionSourceRoot $DefinitionSourceRoot `
            -DefinitionSourceOverrides $DefinitionSourceOverrides `
            -AllowedUnresolvedPlaceholders $AllowedUnresolvedPlaceholders
        $requestBody = $requestBodyJson | ConvertFrom-Json -Depth 100

        if (-not ($requestBody.PSObject.Properties.Name -contains 'definition') -or -not $requestBody.definition) {
            Write-Host "$LogicalName '$DisplayName' create template has no 'definition' block -- nothing to update; skipping."
            return (New-ItemStatus -LogicalName $LogicalName -DisplayName $DisplayName -ItemId $existing.id -ItemType $existing.type -Status 'Existing')
        }

        $updateBody = @{ definition = $requestBody.definition } | ConvertTo-Json -Depth 100
        Invoke-FabricRestMethod `
            -Method Post `
            -Uri "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/items/$($existing.id)/updateDefinition" `
            -Headers $Headers `
            -Body $updateBody | Out-Null

        Write-Host "Updated $LogicalName '$DisplayName' (id '$($existing.id)') definition."
        return (New-ItemStatus -LogicalName $LogicalName -DisplayName $DisplayName -ItemId $existing.id -ItemType $existing.type -Status 'Updated')
    }

    if (-not $script:RootCmdlet.ShouldProcess($DisplayName, "Create $LogicalName")) {
        Write-Host "What-if: would create $LogicalName '$DisplayName'."
        return (New-ItemStatus -LogicalName $LogicalName -DisplayName $DisplayName -ItemId $null -ItemType $ExpectedType -Status 'WhatIfSkipped')
    }

    $requestBody = New-RequestBodyFromTemplate `
        -TemplatePath $TemplatePath `
        -Replacements $Replacements `
        -DefinitionSourceRoot $DefinitionSourceRoot `
        -DefinitionSourceOverrides $DefinitionSourceOverrides `
        -AllowedUnresolvedPlaceholders $AllowedUnresolvedPlaceholders

    $response = Invoke-FabricRestMethod -Method Post -Uri $CreateUri -Headers $Headers -Body $requestBody
    $created = Get-FabricItemByDisplayName -WorkspaceId $WorkspaceId -DisplayName $DisplayName -Headers $Headers -ExpectedType $ExpectedType
    if (-not $created -and $response.Body -and $response.Body.id) {
        $created = [PSCustomObject]@{
            id          = $response.Body.id
            displayName = $DisplayName
            type        = $ExpectedType
        }
    }

    if (-not $created) {
        throw "$LogicalName '$DisplayName' create call completed, but the item could not be resolved afterwards."
    }

    Write-Host "Created $LogicalName '$DisplayName' with id '$($created.id)'."
    return (New-ItemStatus -LogicalName $LogicalName -DisplayName $DisplayName -ItemId $created.id -ItemType $created.type -Status 'Created')
}

function Test-IsSchemaValidationStyleError {
    param([string]$Message)

    return $Message -match '(?i)schema|validation|invalid|badrequest|definition|customendpoint|operationsagentv1\.json|configurations\.json'
}

function Test-IsFeatureNotAvailableError {
    param([string]$Message)

    return $Message -match '(?i)FeatureNotAvailable'
}

function Test-IsReflexKqlSourceUnsupportedError {
    param([string]$Message)

    return $Message -match '(?i)Activator_Alm_UserError' -and $Message -match '(?i)importArtifactRequest'
}

function Test-IsShortcutTargetNotFoundError {
    param([string]$Message)

    return $Message -match '(?i)RequestBodyValidationFailed' -and $Message -match "(?i)Target path doesn't exist"
}

function Test-IsShortcutAlreadyExistsError {
    param([string]$Message)

    return $Message -match '(?i)FailureToReserveTableShortcutName' -or $Message -match '(?i)already exists' -or $Message -match '(?i)Conflict'
}

function Ensure-LakehouseKqlShortcut {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [string]$WorkspaceId,
        [string]$KqlDatabaseItemId,
        [string]$LakehouseItemId,
        [string]$ShortcutName,
        [string]$LakehouseTablePath,
        [hashtable]$Headers
    )

    if (-not $PSCmdlet.ShouldProcess($ShortcutName, 'Create KQL database table shortcut')) {
        return 'Planned'
    }
    $body = @{
        name   = $ShortcutName
        target = @{
            oneLake = @{
                workspaceId = $WorkspaceId
                itemId      = $LakehouseItemId
                path        = $LakehouseTablePath
            }
        }
        enableQueryAcceleration = $false
    } | ConvertTo-Json -Depth 5

    try {
        Invoke-FabricRestMethod -Method Post -Uri "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/kqlDatabases/$KqlDatabaseItemId/shortcuts" -Headers $Headers -Body $body | Out-Null
        Write-Host "Created KQL database table shortcut '$ShortcutName' -> $LakehouseTablePath."
        return 'Created'
    } catch {
        if (Test-IsShortcutAlreadyExistsError -Message $_.Exception.Message) {
            Write-Host "KQL database table shortcut '$ShortcutName' already exists; skipping (idempotent)."
            return 'AlreadyExists'
        }
        if (Test-IsShortcutTargetNotFoundError -Message $_.Exception.Message) {
            Add-ProvisioningWarning "KQL database table shortcut '$ShortcutName' was skipped because Lakehouse path '$LakehouseTablePath' doesn't exist yet -- this is expected before scripts/simulate/load-history-to-tables.ps1 has run at least once (T060c's notebook materializes the Delta tables from seeded history). Re-run this script (or just re-run this shortcut step) after seed history has loaded; it is idempotent."
            return 'SkippedTargetNotFound'
        }
        throw
    }
}

function Ensure-ReflexItem {
    param(
        [string]$WorkspaceId,
        [string]$DisplayName,
        [string]$ActivatorRoot,
        [hashtable]$Replacements,
        [hashtable]$Headers
    )

    if (-not $WorkspaceId) {
        Write-Host "Skipping Reflex because no workspace ID is available (likely -WhatIf mode before workspace creation)."
        return (New-ItemStatus -LogicalName 'Reflex' -DisplayName $DisplayName -ItemId $null -ItemType 'Reflex' -Status 'WhatIfSkipped')
    }

    $existing = Get-FabricItemByDisplayName -WorkspaceId $WorkspaceId -DisplayName $DisplayName -Headers $Headers -ExpectedType 'Reflex'
    if ($existing) {
        Write-Host "Reflex '$DisplayName' already exists with id '$($existing.id)' -- skipping."
        return (New-ItemStatus -LogicalName 'Reflex' -DisplayName $DisplayName -ItemId $existing.id -ItemType $existing.type -Status 'Existing')
    }

    if (-not $script:RootCmdlet.ShouldProcess($DisplayName, 'Create Reflex')) {
        Write-Host "What-if: would create Reflex '$DisplayName'."
        return (New-ItemStatus -LogicalName 'Reflex' -DisplayName $DisplayName -ItemId $null -ItemType 'Reflex' -Status 'WhatIfSkipped')
    }

    $createUri = "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/reflexes"
    $primaryTemplatePath = Join-Path $ActivatorRoot 'create-reflex.request.json'

    try {
        $requestBody = New-RequestBodyFromTemplate `
            -TemplatePath $primaryTemplatePath `
            -Replacements $Replacements `
            -DefinitionSourceRoot $ActivatorRoot

        Invoke-FabricRestMethod -Method Post -Uri $createUri -Headers $Headers -Body $requestBody | Out-Null
    }
    catch {
        $message = $_.Exception.Message
        if (-not (Test-IsReflexKqlSourceUnsupportedError -Message $message)) {
            throw
        }

        Add-ProvisioningWarning 'The provider rejected the full Reflex definition. A container-only item was created; configure alert rules manually using infra/fabric/activator/rule-queries/ and verify them before use.'

        $minimalTemplatePath = Join-Path $ActivatorRoot 'create-reflex-minimal.request.json'
        $minimalSourceOverrides = @{
            REFLEX_ENTITIES_MINIMAL_B64 = Join-Path $ActivatorRoot 'ReflexEntities.minimal.json'
        }

        $requestBody = New-RequestBodyFromTemplate `
            -TemplatePath $minimalTemplatePath `
            -Replacements $Replacements `
            -DefinitionSourceRoot $ActivatorRoot `
            -DefinitionSourceOverrides $minimalSourceOverrides

        Invoke-FabricRestMethod -Method Post -Uri $createUri -Headers $Headers -Body $requestBody | Out-Null

        $created = Get-FabricItemByDisplayName -WorkspaceId $WorkspaceId -DisplayName $DisplayName -Headers $Headers -ExpectedType 'Reflex'
        if (-not $created) {
            throw "Reflex '$DisplayName' minimal-fallback create call completed, but the item could not be resolved afterwards."
        }

        Write-Host "Created Reflex '$DisplayName' with id '$($created.id)' (container-only fallback -- alert rules need manual configuration, see warning above)."
        return (New-ItemStatus -LogicalName 'Reflex' -DisplayName $DisplayName -ItemId $created.id -ItemType $created.type -Status 'CreatedMinimalKqlSourceUnsupported')
    }

    $created = Get-FabricItemByDisplayName -WorkspaceId $WorkspaceId -DisplayName $DisplayName -Headers $Headers -ExpectedType 'Reflex'
    if (-not $created) {
        throw "Reflex '$DisplayName' create call completed, but the item could not be resolved afterwards."
    }

    Write-Host "Created Reflex '$DisplayName' with id '$($created.id)'."
    return (New-ItemStatus -LogicalName 'Reflex' -DisplayName $DisplayName -ItemId $created.id -ItemType $created.type -Status 'Created')
}

function Test-IsOperationsAgentPlaybookRulesUnsupportedError {
    param([string]$Message)

    return $Message -match '(?i)No rule definitions available'
}

function Ensure-OperationsAgentItem {
    param(
        [string]$WorkspaceId,
        [string]$DisplayName,
        [hashtable]$Replacements,
        [hashtable]$Headers
    )

    if (-not $WorkspaceId) {
        Write-Host "Skipping OperationsAgent because no workspace ID is available (likely -WhatIf mode before workspace creation)."
        return (New-ItemStatus -LogicalName 'OperationsAgent' -DisplayName $DisplayName -ItemId $null -ItemType 'OperationsAgent' -Status 'WhatIfSkipped')
    }

    $existing = Get-FabricItemByDisplayName -WorkspaceId $WorkspaceId -DisplayName $DisplayName -Headers $Headers -ExpectedType 'OperationsAgent'
    if ($existing) {
        Write-Host "OperationsAgent '$DisplayName' already exists with id '$($existing.id)' -- skipping."
        return (New-ItemStatus -LogicalName 'OperationsAgent' -DisplayName $DisplayName -ItemId $existing.id -ItemType $existing.type -Status 'Existing')
    }

    if (-not $script:RootCmdlet.ShouldProcess($DisplayName, 'Create OperationsAgent')) {
        Write-Host "What-if: would create OperationsAgent '$DisplayName'."
        return (New-ItemStatus -LogicalName 'OperationsAgent' -DisplayName $DisplayName -ItemId $null -ItemType 'OperationsAgent' -Status 'WhatIfSkipped')
    }

    Add-ProvisioningWarning 'Operations Agent docs currently disagree on the root definition-part name. Trying OperationsAgentV1.json first and retrying with Configurations.json only if the create call returns a schema/definition validation error.'

    $primaryTemplatePath = Join-Path $operationsAgentRoot 'create-operations-agent.compat.request.json'
    $fallbackTemplatePath = Join-Path $operationsAgentRoot 'create-operations-agent.request.json'
    $createUri = "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/operationsAgents"

    try {
        $requestBody = New-RequestBodyFromTemplate `
            -TemplatePath $primaryTemplatePath `
            -Replacements $Replacements `
            -DefinitionSourceRoot $operationsAgentRoot

        Invoke-FabricRestMethod -Method Post -Uri $createUri -Headers $Headers -Body $requestBody | Out-Null
    }
    catch {
        $message = $_.Exception.Message

        if (Test-IsOperationsAgentPlaybookRulesUnsupportedError -Message $message) {
            return (New-OperationsAgentPlaybookSkip -DisplayName $DisplayName)
        }

        if (-not (Test-IsSchemaValidationStyleError -Message $message)) {
            throw
        }

        Add-ProvisioningWarning 'Retrying the Operations Agent create call with Configurations.json because the primary OperationsAgentV1.json variant was rejected with a schema/definition style validation error.'

        try {
            $requestBody = New-RequestBodyFromTemplate `
                -TemplatePath $fallbackTemplatePath `
                -Replacements $Replacements `
                -DefinitionSourceRoot $operationsAgentRoot

            Invoke-FabricRestMethod -Method Post -Uri $createUri -Headers $Headers -Body $requestBody | Out-Null
        }
        catch {
            $fallbackMessage = $_.Exception.Message
            if (Test-IsOperationsAgentPlaybookRulesUnsupportedError -Message $fallbackMessage) {
                return (New-OperationsAgentPlaybookSkip -DisplayName $DisplayName)
            }
            throw
        }
    }

    $created = Get-FabricItemByDisplayName -WorkspaceId $WorkspaceId -DisplayName $DisplayName -Headers $Headers -ExpectedType 'OperationsAgent'
    if (-not $created) {
        throw "OperationsAgent '$DisplayName' create call completed, but the item could not be resolved afterwards."
    }

    Write-Host "Created OperationsAgent '$DisplayName' with id '$($created.id)'."
    return (New-ItemStatus -LogicalName 'OperationsAgent' -DisplayName $DisplayName -ItemId $created.id -ItemType $created.type -Status 'Created')
}

function New-OperationsAgentPlaybookSkip {
    param([string]$DisplayName)

    Add-ProvisioningWarning 'Operations Agent creation requires provider-supported playbook configuration. Complete the guided Fabric portal setup using infra/fabric/fabric-operations-agent/Configurations.json as a reference, then rerun provisioning.'

    return (New-ItemStatus -LogicalName 'OperationsAgent' -DisplayName $DisplayName -ItemId $null -ItemType 'OperationsAgent' -Status 'SkippedPlaybookAuthoringRequired')
}

function Ensure-EventstreamItem {
    param(
        [string]$WorkspaceId,
        [string]$DisplayName,
        [hashtable]$Replacements,
        [hashtable]$Headers
    )

    if (-not $WorkspaceId) {
        Write-Host "Skipping Eventstream because no workspace ID is available (likely -WhatIf mode before workspace creation)."
        return (New-ItemStatus -LogicalName 'Eventstream' -DisplayName $DisplayName -ItemId $null -ItemType 'Eventstream' -Status 'WhatIfSkipped')
    }

    $existing = Get-FabricItemByDisplayName -WorkspaceId $WorkspaceId -DisplayName $DisplayName -Headers $Headers -ExpectedType 'Eventstream'
    if ($existing) {
        Write-Host "Eventstream '$DisplayName' already exists with id '$($existing.id)' -- skipping."
        return (New-ItemStatus -LogicalName 'Eventstream' -DisplayName $DisplayName -ItemId $existing.id -ItemType $existing.type -Status 'Existing')
    }

    if (-not $script:RootCmdlet.ShouldProcess($DisplayName, 'Create Eventstream')) {
        Write-Host "What-if: would create Eventstream '$DisplayName'."
        return (New-ItemStatus -LogicalName 'Eventstream' -DisplayName $DisplayName -ItemId $null -ItemType 'Eventstream' -Status 'WhatIfSkipped')
    }

    $definitionSourceOverrides = @{
        EVENTSTREAM_TOPOLOGY_B64 = Join-Path $eventstreamRoot 'eventstream.custom-endpoint.json'
        EVENTSTREAM_AEH_TOPOLOGY_B64 = Join-Path $eventstreamRoot 'eventstream.azure-eventhub-fallback.json'
        EVENTSTREAM_PLATFORM_B64 = Join-Path $eventstreamRoot '.platform.json'
    }

    $createUri = "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/items"
    $primaryTemplatePath = Join-Path $eventstreamRoot 'create-eventstream.request.json'
    $fallbackTemplatePath = Join-Path $eventstreamRoot 'create-eventstream-azure-eventhub-fallback.request.json'

    try {
        $requestBody = New-RequestBodyFromTemplate `
            -TemplatePath $primaryTemplatePath `
            -Replacements $Replacements `
            -DefinitionSourceRoot $eventstreamRoot `
            -DefinitionSourceOverrides $definitionSourceOverrides

        Invoke-FabricRestMethod -Method Post -Uri $createUri -Headers $Headers -Body $requestBody | Out-Null
    }
    catch {
        $message = $_.Exception.Message
        if (-not (Test-IsSchemaValidationStyleError -Message $message)) {
            throw
        }

        if ([string]::IsNullOrWhiteSpace($AzureEventHubConnectionId)) {
            throw "$message`nThe Eventstream CustomEndpoint payload failed validation and no -AzureEventHubConnectionId was supplied for the documented Azure Event Hubs fallback template."
        }

        Add-ProvisioningWarning 'Eventstream CustomEndpoint create failed with a schema/definition style validation error. Retrying once with the documented Azure Event Hubs fallback topology.'
        $requestBody = New-RequestBodyFromTemplate `
            -TemplatePath $fallbackTemplatePath `
            -Replacements $Replacements `
            -DefinitionSourceRoot $eventstreamRoot `
            -DefinitionSourceOverrides $definitionSourceOverrides

        Invoke-FabricRestMethod -Method Post -Uri $createUri -Headers $Headers -Body $requestBody | Out-Null
    }

    $created = Get-FabricItemByDisplayName -WorkspaceId $WorkspaceId -DisplayName $DisplayName -Headers $Headers -ExpectedType 'Eventstream'
    if (-not $created) {
        throw "Eventstream '$DisplayName' create call completed, but the item could not be resolved afterwards."
    }

    Write-Host "Created Eventstream '$DisplayName' with id '$($created.id)'."
    return (New-ItemStatus -LogicalName 'Eventstream' -DisplayName $DisplayName -ItemId $created.id -ItemType $created.type -Status 'Created')
}

Write-Host '=== provision-fabric-items.ps1 (T036) ==='
Write-Host "SubscriptionId      : $SubscriptionId"
Write-Host "ResourceGroupName   : $ResourceGroupName"
Write-Host "FabricCapacityName  : $FabricCapacityName"
Write-Host "FabricWorkspaceName : $FabricWorkspaceName"
Write-Host "NamePrefix          : $NamePrefix"
Write-Host ''

if ($TeamsTeamId -eq '00000000-0000-0000-0000-000000000000' -or
    $TeamsChannelId -eq '19:00000000000000000000000000000000@thread.tacv2') {
    Add-ProvisioningWarning 'Preview/default placeholder values are still in use for the Operations Agent Teams team/channel binding. Replace them with real IDs before relying on Teams notifications from the demo.'
}

Assert-AzureContext -SubscriptionId $SubscriptionId

Write-Host ''
Write-Host '--- Step 1/5: Resume Fabric capacity if needed (T036a) ---'
& $resumeCapacityScriptPath -SubscriptionId $SubscriptionId -ResourceGroupName $ResourceGroupName -CapacityName $FabricCapacityName -WhatIf:$WhatIfPreference

Write-Host ''
Write-Host '--- Step 2/5: Resolve Fabric capacity + auth ---'
$fabricHeaders = Get-FabricAuthHeaders
$fabricCapacity = Get-FabricCapacityByDisplayName -CapacityName $FabricCapacityName -Headers $fabricHeaders
$fabricCapacityId = $fabricCapacity.id

$replacements = @{
    NAME_PREFIX                  = $NamePrefix
    NAME_PREFIX_UNDERSCORE       = ($NamePrefix -replace '-', '_')
    CAPACITY_ID                  = $fabricCapacityId
    OPERATIONS_RECIPIENT_UPN     = $OperationsRecipientUpn
    TEAMS_TEAM_ID                = $TeamsTeamId
    TEAMS_CHANNEL_ID             = $TeamsChannelId
    OPS_NOTEBOOK_ITEM_ID         = $OpsNotebookItemId
    POWER_AUTOMATE_ACTION_ID     = $PowerAutomateActionId
    OPS_NOTEBOOK_ACTION_ID       = (New-DeterministicGuid -Seed "$NamePrefix::OPS_NOTEBOOK_ACTION_ID").Guid
    FABRIC_CAPACITY_ADMIN_ALIAS  = ($FabricCapacityAdminUpn -split '@')[0]
    SESSIONMETRIC_CONNECTION_NAME = (New-EventstreamConnectionName -NamePrefix $NamePrefix -Suffix 'sessionmetric')
    RACESPLIT_CONNECTION_NAME     = (New-EventstreamConnectionName -NamePrefix $NamePrefix -Suffix 'racesplit')
}

if ($AzureEventHubConnectionId) {
    $replacements.AZURE_EVENT_HUB_CONNECTION_ID = $AzureEventHubConnectionId
}

Write-Host "Resolved Fabric capacity GUID: $fabricCapacityId"

Write-Host ''
Write-Host '--- Step 3/5: Workspace ---'
$workspaceResult = Ensure-FabricWorkspace `
    -WorkspaceName $FabricWorkspaceName `
    -CapacityId $fabricCapacityId `
    -Headers $fabricHeaders `
    -Replacements $replacements

$replacements.WORKSPACE_ID = $workspaceResult.Id
$replacements.WORKSPACE_NAME = $FabricWorkspaceName
$replacements.EVENTHOUSE_WORKSPACE_ID = $workspaceResult.Id
Invoke-AssignWorkspaceToCapacity `
    -WorkspaceId $workspaceResult.Id `
    -CapacityId $fabricCapacityId `
    -Headers $fabricHeaders `
    -Replacements $replacements

Write-Host ''
Write-Host '--- Step 4/5: Fabric items ---'
$items = [System.Collections.Generic.List[object]]::new()

$eventhouseDisplayName = "$NamePrefix-eventhouse"
$eventhouseResult = Ensure-FabricItem `
    -LogicalName 'Eventhouse' `
    -DisplayName $eventhouseDisplayName `
    -WorkspaceId $workspaceResult.Id `
    -ExpectedType 'Eventhouse' `
    -CreateUri "https://api.fabric.microsoft.com/v1/workspaces/$($workspaceResult.Id)/eventhouses" `
    -TemplatePath (Join-Path $eventhouseRoot 'create-eventhouse.request.json') `
    -DefinitionSourceRoot $eventhouseRoot `
    -Replacements $replacements `
    -Headers $fabricHeaders
$items.Add($eventhouseResult) | Out-Null
$replacements.EVENTHOUSE_ITEM_ID = $eventhouseResult.Id

$kqlDatabaseResult = Ensure-FabricItem `
    -LogicalName 'KQLDatabase' `
    -DisplayName "$NamePrefix-realtime" `
    -WorkspaceId $workspaceResult.Id `
    -ExpectedType 'KQLDatabase' `
    -CreateUri "https://api.fabric.microsoft.com/v1/workspaces/$($workspaceResult.Id)/kqlDatabases" `
    -TemplatePath (Join-Path $eventhouseRoot 'create-kql-database.request.json') `
    -DefinitionSourceRoot $eventhouseRoot `
    -Replacements $replacements `
    -Headers $fabricHeaders
$items.Add($kqlDatabaseResult) | Out-Null
$replacements.KQLDATABASE_ITEM_ID = $kqlDatabaseResult.Id

$eventstreamResult = Ensure-EventstreamItem `
    -WorkspaceId $workspaceResult.Id `
    -DisplayName "$NamePrefix-eventstream" `
    -Replacements $replacements `
    -Headers $fabricHeaders
$items.Add($eventstreamResult) | Out-Null

$lakehouseResult = Ensure-FabricItem `
    -LogicalName 'Lakehouse' `
    -DisplayName "$($replacements.NAME_PREFIX_UNDERSCORE)_lakehouse" `
    -WorkspaceId $workspaceResult.Id `
    -ExpectedType 'Lakehouse' `
    -CreateUri "https://api.fabric.microsoft.com/v1/workspaces/$($workspaceResult.Id)/lakehouses" `
    -TemplatePath (Join-Path $lakehouseRoot 'create-lakehouse.request.json') `
    -DefinitionSourceRoot $lakehouseRoot `
    -Replacements $replacements `
    -Headers $fabricHeaders
$items.Add($lakehouseResult) | Out-Null
$replacements.LAKEHOUSE_ITEM_ID = $lakehouseResult.Id
$replacements.LAKEHOUSE_DISPLAY_NAME = "$($replacements.NAME_PREFIX_UNDERSCORE)_lakehouse"

# T060c: the Files/ -> Tables/ load notebook. Creating the item here only creates it (an empty
# run of an idempotent notebook every provisioning run would be wasteful and athlete-agnostic --
# there's no athlete ID to load yet at infra-provisioning time); actually running it per athlete
# is scripts/simulate/load-history-to-tables.ps1's job, invoked after seed-history.
$loadHistoryNotebookResult = Ensure-FabricItem `
    -LogicalName 'Notebook' `
    -DisplayName "$NamePrefix-load-history-to-tables" `
    -WorkspaceId $workspaceResult.Id `
    -ExpectedType 'Notebook' `
    -CreateUri "https://api.fabric.microsoft.com/v1/workspaces/$($workspaceResult.Id)/notebooks" `
    -TemplatePath (Join-Path $notebooksRoot 'create-notebook.request.json') `
    -DefinitionSourceRoot $notebooksRoot `
    -Replacements $replacements `
    -Headers $fabricHeaders
$items.Add($loadHistoryNotebookResult) | Out-Null
$replacements.LOAD_HISTORY_NOTEBOOK_ITEM_ID = $loadHistoryNotebookResult.Id

$lakehouseShortcuts = @(
    @{ Name = 'sc_TrainingSession'; TablePath = '/Tables/dbo/trainingsession' },
    @{ Name = 'sc_NutritionLog'; TablePath = '/Tables/dbo/nutritionlog' },
    @{ Name = 'sc_RecoveryMetrics'; TablePath = '/Tables/dbo/recoverymetrics' },
    @{ Name = 'sc_SleepSession'; TablePath = '/Tables/dbo/sleepsession' },
    @{ Name = 'sc_TrainingBlockPhase'; TablePath = '/Tables/dbo/trainingblockphase' }
)
foreach ($shortcut in $lakehouseShortcuts) {
    Ensure-LakehouseKqlShortcut `
        -WorkspaceId $workspaceResult.Id `
        -KqlDatabaseItemId $kqlDatabaseResult.Id `
        -LakehouseItemId $lakehouseResult.Id `
        -ShortcutName $shortcut.Name `
        -LakehouseTablePath $shortcut.TablePath `
        -Headers $fabricHeaders | Out-Null
}

$semanticModelResult = Ensure-FabricItem `
    -LogicalName 'SemanticModel' `
    -DisplayName "$NamePrefix-athlete-trends-semanticmodel" `
    -WorkspaceId $workspaceResult.Id `
    -ExpectedType 'SemanticModel' `
    -CreateUri "https://api.fabric.microsoft.com/v1/workspaces/$($workspaceResult.Id)/semanticModels" `
    -TemplatePath (Join-Path $powerBISemanticModelRoot 'create-semantic-model.request.json') `
    -DefinitionSourceRoot $powerBISemanticModelRoot `
    -Replacements $replacements `
    -Headers $fabricHeaders
$items.Add($semanticModelResult) | Out-Null
$replacements.SEMANTIC_MODEL_ITEM_ID = $semanticModelResult.Id

$reportResult = Ensure-FabricItem `
    -LogicalName 'Report' `
    -DisplayName "$NamePrefix-athlete-trends-report" `
    -WorkspaceId $workspaceResult.Id `
    -ExpectedType 'Report' `
    -CreateUri "https://api.fabric.microsoft.com/v1/workspaces/$($workspaceResult.Id)/reports" `
    -TemplatePath (Join-Path $powerBIReportRoot 'create-report.request.json') `
    -DefinitionSourceRoot $powerBIReportRoot `
    -Replacements $replacements `
    -Headers $fabricHeaders
$items.Add($reportResult) | Out-Null

try {
    $digitalTwinResult = Ensure-FabricItem `
        -LogicalName 'DigitalTwinBuilder' `
        -DisplayName "$($replacements.NAME_PREFIX_UNDERSCORE)_digitaltwinbuilder" `
        -WorkspaceId $workspaceResult.Id `
        -ExpectedType 'DigitalTwinBuilder' `
        -CreateUri "https://api.fabric.microsoft.com/v1/workspaces/$($workspaceResult.Id)/digitaltwinbuilders" `
        -TemplatePath (Join-Path $digitalTwinRoot 'create-digital-twin-builder.request.json') `
        -DefinitionSourceRoot (Join-Path $digitalTwinRoot 'dtb-definition') `
        -Replacements $replacements `
        -Headers $fabricHeaders
} catch {
    if (Test-IsFeatureNotAvailableError -Message $_.Exception.Message) {
        Add-ProvisioningWarning 'DigitalTwinBuilder creation returned HTTP 403 FeatureNotAvailable. Enable "Digital Twin Builder (preview)" in the Fabric Admin Portal (Settings gear > Admin portal > Tenant settings) as a Fabric administrator, then re-run this script; it is idempotent and will pick up from here. Skipping DigitalTwinBuilder (and the dependent Ontology/OperationsAgent items) for this run.'
        $digitalTwinResult = New-ItemStatus -LogicalName 'DigitalTwinBuilder' -DisplayName "$($replacements.NAME_PREFIX_UNDERSCORE)_digitaltwinbuilder" -ItemId $null -ItemType 'DigitalTwinBuilder' -Status 'SkippedFeatureNotAvailable'
    } else {
        throw
    }
}
$items.Add($digitalTwinResult) | Out-Null

if ($digitalTwinResult.Status -eq 'SkippedFeatureNotAvailable') {
    # Ontology is a separate Fabric item type but is part of the same Digital Twin Builder
    # preview surface; it fails with the identical FeatureNotAvailable error when DTB is
    # disabled, so there is no value attempting the call once we already know the tenant
    # setting is off.
    $ontologyResult = New-ItemStatus -LogicalName 'Ontology' -DisplayName "$($replacements.NAME_PREFIX_UNDERSCORE)_ontology" -ItemId $null -ItemType 'Ontology' -Status 'SkippedFeatureNotAvailable'
} else {
    try {
        $ontologyResult = Ensure-FabricItem `
            -LogicalName 'Ontology' `
            -DisplayName "$($replacements.NAME_PREFIX_UNDERSCORE)_ontology" `
            -WorkspaceId $workspaceResult.Id `
            -ExpectedType 'Ontology' `
            -CreateUri "https://api.fabric.microsoft.com/v1/workspaces/$($workspaceResult.Id)/ontologies" `
            -TemplatePath (Join-Path $digitalTwinRoot 'create-ontology.request.json') `
            -DefinitionSourceRoot (Join-Path $digitalTwinRoot 'ontology-definition') `
            -Replacements $replacements `
            -Headers $fabricHeaders
    } catch {
        if (Test-IsFeatureNotAvailableError -Message $_.Exception.Message) {
            Add-ProvisioningWarning 'Ontology creation returned HTTP 403 FeatureNotAvailable. Enable "Digital Twin Builder (preview)" in the Fabric Admin Portal (Settings gear > Admin portal > Tenant settings) as a Fabric administrator, then re-run this script; it is idempotent and will pick up from here. Skipping Ontology (and the dependent OperationsAgent item) for this run.'
            $ontologyResult = New-ItemStatus -LogicalName 'Ontology' -DisplayName "$($replacements.NAME_PREFIX_UNDERSCORE)_ontology" -ItemId $null -ItemType 'Ontology' -Status 'SkippedFeatureNotAvailable'
        } else {
            throw
        }
    }
}
$items.Add($ontologyResult) | Out-Null
if ($ontologyResult.Id) {
    $replacements.ONTOLOGY_ITEM_ID = $ontologyResult.Id
}

$activatorReplacements = @{}
foreach ($entry in $replacements.GetEnumerator()) {
    $activatorReplacements[$entry.Key] = $entry.Value
}
foreach ($escapedEntry in (Get-ActivatorEscapedReplacements -InstancesRoot (Join-Path $activatorRoot 'instances') -Replacements $activatorReplacements).GetEnumerator()) {
    $activatorReplacements[$escapedEntry.Key] = $escapedEntry.Value
}

$activatorResult = Ensure-ReflexItem `
    -WorkspaceId $workspaceResult.Id `
    -DisplayName "$NamePrefix-alerts" `
    -ActivatorRoot $activatorRoot `
    -Replacements $activatorReplacements `
    -Headers $fabricHeaders
$items.Add($activatorResult) | Out-Null

$dataAgentResult = Ensure-FabricItem `
    -LogicalName 'DataAgent' `
    -DisplayName "$NamePrefix-dataagent" `
    -WorkspaceId $workspaceResult.Id `
    -ExpectedType 'DataAgent' `
    -CreateUri "https://api.fabric.microsoft.com/v1/workspaces/$($workspaceResult.Id)/dataAgents" `
    -TemplatePath (Join-Path $dataAgentRoot 'create-data-agent.request.json') `
    -DefinitionSourceRoot $dataAgentRoot `
    -Replacements $replacements `
    -Headers $fabricHeaders `
    -AllowedUnresolvedPlaceholders @('AUTHORIZED_ATHLETE_ID', 'RACE_ID', 'SESSION_ID') `
    -UpdateDefinitionIfExists
$items.Add($dataAgentResult) | Out-Null

$operationsAgentResult = Ensure-OperationsAgentItem `
    -WorkspaceId $workspaceResult.Id `
    -DisplayName "$NamePrefix-operationsagent" `
    -Replacements $replacements `
    -Headers $fabricHeaders
$items.Add($operationsAgentResult) | Out-Null

Write-Host ''
Write-Host '--- Step 5/5: Non-REST manifest outputs and caveats ---'
Add-ProvisioningWarning 'Lakehouse table DDL (infra/fabric/lakehouse/create-lakehouse-tables.sql) is intentionally not executed by T036 directly; this run created the "load-history-to-tables" Notebook item (T060c) that executes it, but the notebook itself is only RUN per-athlete by scripts/simulate/load-history-to-tables.ps1 after seed-history, not automatically here.'

$result = [PSCustomObject]@{
    SubscriptionId      = $SubscriptionId
    ResourceGroupName   = $ResourceGroupName
    FabricCapacityName  = $FabricCapacityName
    FabricCapacityId    = $fabricCapacityId
    FabricWorkspaceName = $FabricWorkspaceName
    FabricWorkspaceId   = $workspaceResult.Id
    WorkspaceStatus     = $workspaceResult.Status
    Items               = @($items)
    Warnings            = @($script:Warnings)
}

Write-Host ''
Write-Host 'Fabric item provisioning summary:'
$result | Format-List | Out-String | Write-Host

return $result
