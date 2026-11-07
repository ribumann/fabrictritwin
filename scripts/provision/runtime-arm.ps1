#Requires -Version 7.0
# Shared, in-memory ARM operations. Never send credentials through CLI arguments or files.

function Get-RuntimeAccessToken {
    param([string]$SubscriptionId, [string]$TenantId, [string]$Resource = 'https://management.azure.com/')

    # `az account get-access-token` rejects `--subscription` and `--tenant` together (az CLI
    # >= 2.7x: "Please specify only one of subscription and tenant, not both"). A subscription
    # ID unambiguously resolves to one cached tenant, so passing only `--subscription` is
    # sufficient; the returned `tenant` claim is still verified below so a mismatched/ambiguous
    # cached account fails closed instead of silently issuing a token for the wrong tenant.
    $output = & az account get-access-token --subscription $SubscriptionId --resource $Resource --output json --only-show-errors 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Cannot acquire a token for '$Resource' in the explicitly selected subscription."
    }
    $token = ($output -join "`n") | ConvertFrom-Json
    if (-not $token.accessToken -or -not $token.tenant -or $token.tenant -ne $TenantId) {
        throw 'Token acquisition returned an empty token or a different tenant.'
    }
    return [string]$token.accessToken
}

function Get-RuntimeArmContext {
    param([string]$SubscriptionId, [string]$TenantId)

    $output = & az account show --subscription $SubscriptionId --output json --only-show-errors 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw 'Cannot read the explicitly selected Azure subscription. Sign in to the intended tenant first.'
    }
    $account = ($output -join "`n") | ConvertFrom-Json
    if ($account.id -ne $SubscriptionId -or ($TenantId -and $account.tenantId -ne $TenantId)) {
        throw 'The selected Azure subscription does not belong to the requested tenant.'
    }
    if (-not $account.tenantId) { throw 'Azure returned no tenant for the selected subscription.' }
    return @{
        SubscriptionId = $SubscriptionId
        TenantId = [string]$account.tenantId
        Headers = @{ Authorization = "Bearer $(Get-RuntimeAccessToken -SubscriptionId $SubscriptionId -TenantId $account.tenantId)" }
    }
}

function Invoke-RuntimeArm {
    param(
        [hashtable]$Context,
        [ValidateSet('GET', 'POST', 'PUT', 'PATCH')][string]$Method = 'GET',
        [string]$ResourceId,
        [string]$ApiVersion = '2024-03-01',
        [object]$Body,
        [string]$ContinuationUri,
        [switch]$AllowNotFound
    )

    $prefix = "/subscriptions/$($Context.SubscriptionId)/"
    if (-not $ResourceId.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or $ResourceId.Contains('?')) {
        throw 'ARM request must stay within the explicitly selected subscription.'
    }
    $uri = "https://management.azure.com${ResourceId}?api-version=$ApiVersion"
    if ($ContinuationUri) {
        $next = [uri]$ContinuationUri
        if ($next.Scheme -ne 'https' -or $next.Host -ne 'management.azure.com' -or -not $next.IsDefaultPort -or
            $next.UserInfo -or $next.AbsolutePath -ne $ResourceId) { throw 'ARM continuation escaped the requested collection.' }
        $uri = $ContinuationUri
    }
    $parameters = @{
        Method = $Method; Uri = $uri; Headers = $Context.Headers
        SkipHttpErrorCheck = $true
        Verbose = $false; Debug = $false; ErrorAction = 'Stop'
    }
    if ($null -ne $Body) {
        $parameters.Body = ConvertTo-Json -InputObject $Body -Depth 100 -Compress
        $parameters.ContentType = 'application/json'
    }
    # Suppress service error bodies: a failed secrets PATCH can echo credential material.
    try { $response = Invoke-WebRequest @parameters }
    catch { throw "ARM $Method request failed before a response was received ($ResourceId). Response details suppressed." }
    $status = [int]$response.StatusCode
    if ($status -eq 404 -and $AllowNotFound) { return $null }
    if ($status -lt 200 -or $status -ge 300) {
        throw "ARM $Method failed with HTTP $status ($ResourceId). Response details suppressed."
    }
    if ([string]::IsNullOrWhiteSpace($response.Content)) {
        if ($Method -eq 'GET') { throw "ARM GET returned an empty response ($ResourceId)." }
        return $null
    }
    try { return ConvertFrom-Json -InputObject $response.Content -AsHashtable }
    catch { throw "ARM returned invalid JSON ($ResourceId). Response details suppressed." }
}

function Get-RuntimeArmCollection {
    param([hashtable]$Context, [string]$ResourceId, [string]$ApiVersion)
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    $items = @()
    $next = $null
    do {
        $page = Invoke-RuntimeArm -Context $Context -ResourceId $ResourceId -ApiVersion $ApiVersion -ContinuationUri $next
        $items += @($page.value)
        $next = $page.nextLink
        if ($next -and -not $seen.Add($next)) { throw 'ARM returned a repeated continuation link.' }
    } while ($next)
    return $items
}

function Test-RuntimeValueEqual {
    param([object]$Left, [object]$Right)
    if ($null -eq $Left -or $null -eq $Right) { return $null -eq $Left -and $null -eq $Right }
    if ($Left -is [System.Collections.IDictionary] -and $Right -is [System.Collections.IDictionary]) {
        if ($Left.Count -ne $Right.Count) { return $false }
        foreach ($key in $Right.Keys) {
            if (-not $Left.Contains($key) -or -not (Test-RuntimeValueEqual $Left[$key] $Right[$key])) { return $false }
        }
        return $true
    }
    if ($Left -is [array] -and $Right -is [array]) {
        if ($Left.Count -ne $Right.Count) { return $false }
        for ($i = 0; $i -lt $Left.Count; $i++) {
            if (-not (Test-RuntimeValueEqual $Left[$i] $Right[$i])) { return $false }
        }
        return $true
    }
    return $Left -ceq $Right
}

function Get-RuntimeContainer {
    param([hashtable]$App, [string]$ContainerName)
    $containers = @($App.properties.template.containers | Where-Object { $_.name -eq $ContainerName })
    if ($containers.Count -ne 1) { throw "Expected exactly one container named '$ContainerName'." }
    return $containers[0]
}

function Get-RuntimeEnvironment {
    param([hashtable]$Container)
    $envMap = @{}
    foreach ($entry in $Container.env) {
        if ($entry.ContainsKey('value')) { $envMap[$entry.name] = $entry.value }
    }
    return $envMap
}

function Update-RuntimeAppSetting {
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [hashtable]$Context, [hashtable]$App, [string]$ContainerName,
        [hashtable]$Environment = @{}, [hashtable]$Secrets = @{}
    )

    $container = Get-RuntimeContainer -App $App -ContainerName $ContainerName
    $originalEnv = @($container.env)
    $updatedEnv = @($originalEnv | Where-Object { -not $Environment.ContainsKey($_.name) })
    foreach ($name in @($Environment.Keys | Sort-Object)) {
        $entry = @{ name = $name }
        if ($Environment[$name] -is [System.Collections.IDictionary]) {
            $entry.secretRef = $Environment[$name].secretRef
        }
        else { $entry.value = [string]$Environment[$name] }
        $updatedEnv += $entry
    }
    $envChanged = -not (Test-RuntimeValueEqual @($originalEnv | Sort-Object name) @($updatedEnv | Sort-Object name))
    $secretChanged = $false
    $changedSecretNames = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $mergedSecrets = @()
    if ($Secrets.Count -gt 0) {
        $existing = Invoke-RuntimeArm -Context $Context -Method POST -ResourceId "$($App.id)/listSecrets"
        $mergedSecrets = @($existing.value | Where-Object { -not $Secrets.ContainsKey($_.name) })
        foreach ($name in @($Secrets.Keys | Sort-Object)) {
            $prior = @($existing.value | Where-Object { $_.name -eq $name })
            if ($prior.Count -ne 1 -or $prior[0].value -cne $Secrets[$name]) {
                $secretChanged = $true
                $changedSecretNames.Add($name) | Out-Null
            }
            $mergedSecrets += @{ name = $name; value = $Secrets[$name] }
        }
        foreach ($secret in $mergedSecrets) {
            if (-not $secret.value -and -not $secret.keyVaultUrl) {
                throw "Cannot preserve native secret '$($secret.name)': listSecrets did not return a value."
            }
        }
    }
    if (-not $envChanged -and -not $secretChanged) { return $false }
    if ($PSCmdlet.ShouldProcess($App.name, 'Merge owned runtime environment/secret fields; retain image and unrelated configuration')) {
        $properties = @{}
        if ($envChanged) {
            $container.env = $updatedEnv
            # A prior template PATCH (e.g. an auth credential rotation) leaves its explicit
            # revisionSuffix stored on the app; omitting revisionSuffix here would make ARM
            # reuse that stale value and collide with the revision it already created.
            $properties.template = @{
                containers = $App.properties.template.containers
                revisionSuffix = "cfg-$([guid]::NewGuid().ToString('N').Substring(0,10))"
            }
        }
        if ($secretChanged) {
            # PATCH nested configuration is not assumed to deep-merge: retain every existing setting.
            $configuration = $App.properties.configuration
            $configuration.secrets = $mergedSecrets
            $properties.configuration = $configuration
        }
        Invoke-RuntimeArm -Context $Context -Method PATCH -ResourceId $App.id -Body @{ properties = $properties } | Out-Null
        $settled = $false
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            $actual = Invoke-RuntimeArm -Context $Context -ResourceId $App.id
            if ($actual.properties.provisioningState -in @('Failed', 'Canceled')) {
                throw "Runtime settings update failed for '$($App.name)'."
            }
            if ($actual.properties.provisioningState -eq 'Succeeded') {
                $actualContainer = Get-RuntimeContainer -App $actual -ContainerName $ContainerName
                if (-not $envChanged -or (Test-RuntimeValueEqual @($actualContainer.env | Sort-Object name) @($updatedEnv | Sort-Object name))) {
                    $settled = $true
                    break
                }
            }
            Start-Sleep -Seconds 2
        }
        if (-not $settled) { throw "Timed out verifying runtime settings for '$($App.name)'." }
        if ($secretChanged) {
            $verified = Invoke-RuntimeArm -Context $Context -Method POST -ResourceId "$($App.id)/listSecrets"
            foreach ($name in $Secrets.Keys) {
                $entry = @($verified.value | Where-Object { $_.name -eq $name })
                if ($entry.Count -ne 1 -or $entry[0].value -cne $Secrets[$name]) { throw "Secret '$name' was not retained by '$($App.name)'." }
            }
        }
        if ($secretChanged -and $App.id -match '/containerApps/') {
            # A rollback or multiple-revision mode can leave older revisions serving traffic.
            # Secret updates do not refresh those processes, even if PATCH creates a new revision.
            $revisions = @(Get-RuntimeArmCollection -Context $Context -ResourceId "$($App.id)/revisions" -ApiVersion '2024-03-01')
            foreach ($revision in $revisions) {
                if (-not $revision.properties.ContainsKey('active')) { throw 'Revision listing did not return activation state.' }
                if (-not $revision.properties.active) { continue }
                $references = @($revision.properties.template.containers.env | Where-Object { $_.secretRef -and $changedSecretNames.Contains([string]$_.secretRef) })
                $usesChangedSecret = $references.Count -gt 0
                if ($usesChangedSecret) {
                    $expectedId = "$($App.id)/revisions/$($revision.name)"
                    if ($revision.id -ne $expectedId) { throw 'Revision listing returned an unexpected resource ID.' }
                    Invoke-RuntimeArm -Context $Context -Method POST -ResourceId "$expectedId/restart" | Out-Null
                }
            }
        }
        return $true
    }
    return $false
}

function Merge-RuntimePrincipalMap {
    param([string]$ExistingJson = '{}', [object]$Additions)
    $existing = $ExistingJson | ConvertFrom-Json -AsHashtable
    if ($existing -isnot [System.Collections.IDictionary]) { throw 'ATHLETE_PRINCIPAL_MAP must be a JSON object.' }
    $map = @{}
    foreach ($key in $existing.Keys) {
        $oid = [guid]::Parse($key).ToString()
        $athlete = [guid]::Parse([string]$existing[$key]).ToString()
        if ($map.ContainsKey($oid) -and $map[$oid] -ne $athlete) { throw "Principal '$oid' has conflicting athlete mappings." }
        $map[$oid] = $athlete
    }
    if ($null -ne $Additions) {
        $newEntries = $Additions | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable
        foreach ($key in $newEntries.Keys) {
            $oid = [guid]::Parse($key).ToString()
            $athlete = [guid]::Parse([string]$newEntries[$key]).ToString()
            if ($map.ContainsKey($oid) -and $map[$oid] -ne $athlete) {
                throw "Principal '$oid' already maps to a different athlete. Resolve the conflict explicitly."
            }
            $map[$oid] = $athlete
        }
    }
    # Environment reconciliation compares JSON strings, so hash-table iteration must not
    # turn unchanged principal mappings into a new Container App revision.
    $orderedMap = [ordered]@{}
    foreach ($key in @($map.Keys | Sort-Object)) { $orderedMap[$key] = $map[$key] }
    return ConvertTo-Json -InputObject $orderedMap -Compress
}
