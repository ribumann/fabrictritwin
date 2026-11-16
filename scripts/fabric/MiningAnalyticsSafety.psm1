Set-StrictMode -Version Latest

function Get-MiningAnalyticsFabricItems {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][guid]$WorkspaceId,
        [Parameter(Mandatory)][hashtable]$Headers,
        [scriptblock]$Request
    )

    if (-not $Request) {
        $Request = {
            param($Uri, $RequestHeaders)
            Invoke-RestMethod -Method Get -Uri $Uri -Headers $RequestHeaders
        }
    }

    $items = [System.Collections.Generic.List[object]]::new()
    $seenIds = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $seenUris = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $requestUri = "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/items"
    do {
        $uri = [uri]$requestUri
        if (-not $uri.IsAbsoluteUri -or $uri.Scheme -cne 'https' -or
            $uri.Host -cne 'api.fabric.microsoft.com') {
            throw 'Fabric item pagination returned an invalid continuation URI.'
        }
        if (-not $seenUris.Add($uri.AbsoluteUri)) {
            throw 'Fabric item pagination returned a repeated continuation URI.'
        }

        $page = & $Request $uri.AbsoluteUri $Headers
        if (-not $page -or $null -eq $page.value) {
            throw 'Fabric item inventory returned a page without a value array.'
        }
        foreach ($item in @($page.value)) {
            $itemId = [guid]::Empty
            if (-not $item.id -or -not [guid]::TryParse([string]$item.id, [ref]$itemId) -or
                $itemId -eq [guid]::Empty -or [string]::IsNullOrWhiteSpace([string]$item.type) -or
                [string]::IsNullOrWhiteSpace([string]$item.displayName)) {
                throw 'Fabric item inventory returned an item without a valid ID, type, or display name.'
            }
            if (-not $seenIds.Add($itemId.ToString())) {
                throw "Fabric item inventory repeated item ID '$itemId' across its pages."
            }
            $items.Add($item)
        }
        $requestUri = if ($page.PSObject.Properties.Name -contains 'continuationUri') {
            [string]$page.continuationUri
        } else {
            ''
        }
    } while (-not [string]::IsNullOrWhiteSpace($requestUri))

    return ,$items.ToArray()
}

function Get-MiningAnalyticsMatchingItem {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Items,
        [Parameter(Mandatory)][string]$DisplayName,
        [Parameter(Mandatory)][string]$Type
    )

    $nameMatches = @($Items | Where-Object {
        [string]::Equals([string]$_.displayName, $DisplayName, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($nameMatches.Count -eq 0) { return $null }

    $typeMatches = @($nameMatches | Where-Object { $_.type -ceq $Type })
    if ($typeMatches.Count -gt 1) {
        throw "Multiple Fabric items match '$DisplayName' with type '$Type'; refusing to choose one."
    }
    if ($typeMatches.Count -eq 0) {
        if ($nameMatches.Count -eq 1 -and $nameMatches[0].displayName -cne $DisplayName) {
            throw "Fabric item '$($nameMatches[0].displayName)' differs in case from expected name '$DisplayName'."
        }
        if ($nameMatches.Count -eq 1) {
            throw "Fabric item '$DisplayName' has type '$($nameMatches[0].type)', expected '$Type'."
        }
        throw "Multiple Fabric items match '$DisplayName', but none have type '$Type'."
    }
    if ($typeMatches[0].displayName -cne $DisplayName) {
        throw "Fabric item '$($typeMatches[0].displayName)' differs in case from expected name '$DisplayName'."
    }

    $itemId = [guid]::Empty
    if (-not [guid]::TryParse([string]$typeMatches[0].id, [ref]$itemId) -or $itemId -eq [guid]::Empty) {
        throw "Fabric item '$DisplayName' has an invalid ID."
    }
    return $typeMatches[0]
}

function Assert-MiningAnalyticsCreatedItemIdentity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$Item,
        [string]$ReturnedId,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$PreimageItemIds,
        [Parameter(Mandatory)][string]$DisplayName,
        [Parameter(Mandatory)][string]$Type
    )

    if ($Item.displayName -cne $DisplayName -or $Item.type -cne $Type) {
        throw 'Create result does not match the exact expected item name and type.'
    }
    $itemId = [guid]::Empty
    if (-not [guid]::TryParse([string]$Item.id, [ref]$itemId) -or $itemId -eq [guid]::Empty) {
        throw 'Create result has an invalid item ID.'
    }
    if ($itemId.ToString() -in $PreimageItemIds) {
        throw 'Create result item ID was present before submission; refusing to treat it as newly created.'
    }
    if (-not [string]::IsNullOrWhiteSpace($ReturnedId)) {
        $returnedGuid = [guid]::Empty
        if (-not [guid]::TryParse($ReturnedId, [ref]$returnedGuid) -or
            $returnedGuid -eq [guid]::Empty -or $returnedGuid -ne $itemId) {
            throw 'Create response item ID does not match the new exact-name workspace item.'
        }
    }
    return $itemId.ToString()
}

function ConvertTo-MiningAnalyticsCanonicalJson {
    param([Parameter(Mandatory)][AllowNull()][object]$Value)

    if ($null -eq $Value -or $Value -is [string] -or $Value -is [ValueType]) { return $Value }
    if ($Value -is [System.Collections.IDictionary]) {
        $ordered = [ordered]@{}
        foreach ($key in @($Value.Keys | Sort-Object -CaseSensitive)) {
            $ordered[[string]$key] = ConvertTo-MiningAnalyticsCanonicalJson $Value[$key]
        }
        return $ordered
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        $array = [System.Collections.Generic.List[object]]::new()
        foreach ($entry in $Value) {
            $array.Add((ConvertTo-MiningAnalyticsCanonicalJson $entry))
        }
        return ,$array.ToArray()
    }
    throw "Unsupported JSON value type '$($Value.GetType().FullName)' in a Fabric definition."
}

function Get-MiningAnalyticsDefinitionPartMap {
    param([Parameter(Mandatory)][object]$Definition)

    if (-not $Definition.parts) { throw 'Fabric returned a definition without parts.' }
    $parts = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
    foreach ($part in @($Definition.parts)) {
        if ([string]::IsNullOrWhiteSpace([string]$part.path) -or
            $part.payloadType -cne 'InlineBase64' -or
            $null -eq $part.payload) {
            throw 'Fabric returned a definition part with an unsupported path or payload type.'
        }
        if ($parts.ContainsKey([string]$part.path)) {
            throw "Fabric returned duplicate definition part '$($part.path)'."
        }
        try {
            $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$part.payload))
        } catch {
            throw "Fabric returned invalid base64 for definition part '$($part.path)'."
        }
        $parts.Add([string]$part.path, $text)
    }
    return $parts
}

function Get-MiningAnalyticsNormalizedPart {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Text)

    if ($Path.EndsWith('.json', [StringComparison]::OrdinalIgnoreCase) -or
        $Path -eq '.platform' -or $Path -in @('definition.pbism', 'definition.pbir')) {
        try {
            $value = $Text | ConvertFrom-Json -AsHashtable -Depth 100
            $canonical = ConvertTo-MiningAnalyticsCanonicalJson $value
            return ConvertTo-Json -InputObject $canonical -Depth 100 -Compress
        } catch {
            throw "Definition part '$Path' is not valid canonicalizable JSON."
        }
    }

    $normalized = $Text.TrimStart([char]0xFEFF) -replace "`r`n?", "`n"
    $normalized = [regex]::Replace(
        $normalized,
        '(?m)^([ \t]+)summarizeBy: none\n\1(lineageTag: [0-9a-fA-F-]{36})$',
        [System.Text.RegularExpressions.MatchEvaluator]{
            param($match)
            $match.Groups[1].Value + $match.Groups[2].Value + "`n" +
                $match.Groups[1].Value + 'summarizeBy: none'
        })
    $normalized = $normalized.TrimEnd([char]10)
    $lines = @($normalized -split "`n" | ForEach-Object {
        $match = [regex]::Match($_, '^([ \t]*)(.*)$')
        $indentation = $match.Groups[1].Value.Replace("`t", '    ').Length
        (' ' * $indentation) + $match.Groups[2].Value
    })
    return $lines -join "`n"
}

function Assert-MiningAnalyticsDefinitionMatches {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][object]$ExpectedDefinition,
        [Parameter(Mandatory)][object]$ActualDefinition,
        [Parameter(Mandatory)][string]$Label,
        [string]$ExpectedWorkspaceName,
        [string]$ExpectedSemanticModelName
    )

    $expected = Get-MiningAnalyticsDefinitionPartMap $ExpectedDefinition
    $actual = Get-MiningAnalyticsDefinitionPartMap $ActualDefinition
    $expectedPaths = @($expected.Keys | Sort-Object -CaseSensitive)
    $actualPaths = @($actual.Keys | Sort-Object -CaseSensitive)
    $fabricBaseThemePath = 'StaticResources/SharedResources/BaseThemes/CY25SU12.json'
    if (-not $expected.ContainsKey($fabricBaseThemePath) -and $actual.ContainsKey($fabricBaseThemePath) -and
        $expected.ContainsKey('definition/report.json')) {
        try {
            $reportDefinition = $expected['definition/report.json'] | ConvertFrom-Json -AsHashtable -Depth 100
        } catch {
            throw "$Label report definition is not valid JSON."
        }
        $referencesFabricBaseTheme = @($reportDefinition.resourcePackages | Where-Object {
            $_.name -ceq 'SharedResources' -and $_.type -ceq 'SharedResources'
        } | ForEach-Object { $_.items } | Where-Object {
            $_.name -ceq 'CY25SU12' -and $_.type -ceq 'BaseTheme' -and
            $_.path -ceq 'BaseThemes/CY25SU12.json'
        }).Count -gt 0
        $themeHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
                [Text.Encoding]::UTF8.GetBytes($actual[$fabricBaseThemePath]))).ToLowerInvariant()
        if ($referencesFabricBaseTheme -and
            $themeHash -ceq '67802632b6a9543cb5aa35b7132fd444923934e98f8672d1fe917e6a9cbd05a8') {
            $actualPaths = @($actualPaths | Where-Object { $_ -cne $fabricBaseThemePath })
        }
    }
    if (($expectedPaths -join "`n") -cne ($actualPaths -join "`n")) {
        $missing = @($expectedPaths | Where-Object { -not $actual.ContainsKey($_) })
        $unexpected = @($actualPaths | Where-Object { -not $expected.ContainsKey($_) })
        throw "$Label native definition part set differs from the reviewed definition (missing: $($missing -join ', '); unexpected: $($unexpected -join ', '))."
    }
    foreach ($path in $expectedPaths) {
        if ($path -eq '.platform') {
            try {
                $expectedPlatform = $expected[$path] | ConvertFrom-Json -AsHashtable -Depth 100
                $actualPlatform = $actual[$path] | ConvertFrom-Json -AsHashtable -Depth 100
                $expectedLogicalId = [string]$expectedPlatform.config.logicalId
                $actualLogicalId = [string]$actualPlatform.config.logicalId
            } catch {
                throw "$Label .platform definition is not valid JSON."
            }
            $fabricNormalizedLogicalId = '00000000-0000-0000-0000-000000000000'
            if ($actualLogicalId -cne $expectedLogicalId -and
                $actualLogicalId -cne $fabricNormalizedLogicalId) {
                throw "$Label native definition part '.platform' has an unexpected config.logicalId."
            }
            $actualPlatform.config.logicalId = $expectedLogicalId
            $expectedText = ConvertTo-Json -InputObject (ConvertTo-MiningAnalyticsCanonicalJson $expectedPlatform) `
                -Depth 100 -Compress
            $actualText = ConvertTo-Json -InputObject (ConvertTo-MiningAnalyticsCanonicalJson $actualPlatform) `
                -Depth 100 -Compress
        } elseif ($path -eq 'definition.pbism') {
            try {
                $expectedPbism = $expected[$path] | ConvertFrom-Json -AsHashtable -Depth 100
                $actualPbism = $actual[$path] | ConvertFrom-Json -AsHashtable -Depth 100
                $expectedVersion = [string]$expectedPbism.version
                $actualVersion = [string]$actualPbism.version
            } catch {
                throw "$Label definition.pbism is not valid JSON."
            }
            if ($expectedVersion -eq '5.0' -and $actualVersion -eq '4.2') {
                $actualPbism.version = $expectedVersion
            }
            $expectedText = ConvertTo-Json -InputObject (ConvertTo-MiningAnalyticsCanonicalJson $expectedPbism) `
                -Depth 100 -Compress
            $actualText = ConvertTo-Json -InputObject (ConvertTo-MiningAnalyticsCanonicalJson $actualPbism) `
                -Depth 100 -Compress
        } elseif ($path -eq 'definition.pbir') {
            try {
                $expectedPbir = $expected[$path] | ConvertFrom-Json -AsHashtable -Depth 100
                $actualPbir = $actual[$path] | ConvertFrom-Json -AsHashtable -Depth 100
            } catch {
                throw "$Label definition.pbir is not valid JSON."
            }
            $expectedConnection = [string]$expectedPbir.datasetReference.byConnection.connectionString
            $actualConnection = [string]$actualPbir.datasetReference.byConnection.connectionString
            if ($actualConnection -cne $expectedConnection) {
                $expectedModelId = [guid]::Empty
                if ($expectedConnection -notmatch '^semanticmodelid=([0-9a-fA-F-]{36})$' -or
                    -not [guid]::TryParse($Matches[1], [ref]$expectedModelId) -or
                    $expectedModelId -eq [guid]::Empty -or
                    [string]::IsNullOrWhiteSpace($ExpectedWorkspaceName) -or
                    [string]::IsNullOrWhiteSpace($ExpectedSemanticModelName)) {
                    throw "$Label native definition part '$path' has an unexpected dataset connection string."
                }
                $connectionProperties = [System.Collections.Generic.Dictionary[string, string]]::new(
                    [StringComparer]::OrdinalIgnoreCase)
                foreach ($entry in $actualConnection -split ';') {
                    $separator = $entry.IndexOf('=')
                    if ($separator -le 0) {
                        throw "$Label native definition part '$path' has an invalid dataset connection string."
                    }
                    $key = $entry.Substring(0, $separator).Trim()
                    $value = $entry.Substring($separator + 1).Trim()
                    if (-not $connectionProperties.TryAdd($key, $value)) {
                        throw "$Label native definition part '$path' has duplicate dataset connection properties."
                    }
                }
                if ($connectionProperties.Count -ne 4 -or
                    -not $connectionProperties.ContainsKey('Data Source') -or
                    -not $connectionProperties.ContainsKey('initial catalog') -or
                    -not $connectionProperties.ContainsKey('integrated security') -or
                    -not $connectionProperties.ContainsKey('semanticmodelid') -or
                    $connectionProperties['Data Source'] -cne "powerbi://api.powerbi.com/v1.0/myorg/$ExpectedWorkspaceName" -or
                    $connectionProperties['initial catalog'] -cne $ExpectedSemanticModelName -or
                    $connectionProperties['integrated security'] -cne 'ClaimsToken' -or
                    $connectionProperties['semanticmodelid'] -cne $expectedModelId.ToString()) {
                    throw "$Label native definition part '$path' has an unexpected dataset connection string."
                }
                $actualPbir.datasetReference.byConnection.connectionString = $expectedConnection
            }
            $expectedText = ConvertTo-Json -InputObject (ConvertTo-MiningAnalyticsCanonicalJson $expectedPbir) `
                -Depth 100 -Compress
            $actualText = ConvertTo-Json -InputObject (ConvertTo-MiningAnalyticsCanonicalJson $actualPbir) `
                -Depth 100 -Compress
        } elseif ($path -eq 'definition/model.tmdl') {
            $expectedText = Get-MiningAnalyticsNormalizedPart -Path $path -Text $expected[$path]
            $actualText = Get-MiningAnalyticsNormalizedPart -Path $path -Text $actual[$path]
            $expectedAnnotationBoundary = "annotation __PBI_TimeIntelligenceEnabled = 0`nannotation PBI_ProTooling"
            $actualAnnotationBoundary = "annotation __PBI_TimeIntelligenceEnabled = 0`n`nannotation PBI_ProTooling"
            if ($expectedText.Contains($expectedAnnotationBoundary) -and
                -not $actualText.Contains($expectedAnnotationBoundary) -and
                $actualText.Contains($actualAnnotationBoundary) -and
                ([regex]::Matches($actualText,
                    [regex]::Escape($actualAnnotationBoundary)).Count -eq 1)) {
                $actualText = $actualText.Replace($actualAnnotationBoundary, $expectedAnnotationBoundary)
            }
            $cultureReferenceCount = [regex]::Matches(
                $actualText, '(?m)^ref cultureInfo en-US$').Count
            if ($cultureReferenceCount -gt 1) {
                throw "$Label native definition part '$path' contains duplicate culture references."
            }
            if ($cultureReferenceCount -eq 1 -and
                $expectedText -notmatch '(?m)^ref cultureInfo en-US$') {
                if ($actualText -notmatch "`nref cultureInfo en-US$") {
                    throw "$Label native definition part '$path' has an unexpected culture reference placement."
                }
                $actualText = [regex]::Replace($actualText, "`n+ref cultureInfo en-US$", '')
            }
        } else {
            $expectedText = Get-MiningAnalyticsNormalizedPart -Path $path -Text $expected[$path]
            $actualText = Get-MiningAnalyticsNormalizedPart -Path $path -Text $actual[$path]
        }
        if ($expectedText -cne $actualText) {
            throw "$Label native definition part '$path' differs from the reviewed definition."
        }
    }
}

function Get-PendingMiningAnalyticsCreates {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Records)

    $attempts = [System.Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
    $latestLegacyKeys = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
    foreach ($record in $Records) {
        if ($record.kind -notin @('SemanticModel', 'Report')) { continue }
        $attemptIdProperty = $record.PSObject.Properties['attemptId']
        $hashProperty = $record.PSObject.Properties['desiredRequestSha256']
        $attemptId = if ($attemptIdProperty) { [string]$attemptIdProperty.Value } else { '' }
        $targetKey = '{0}|{1}' -f $record.kind, $record.displayName
        $hash = if ($hashProperty) { [string]$hashProperty.Value } else { '' }
        $key = if (-not [string]::IsNullOrWhiteSpace($attemptId)) {
            $attemptId
        } elseif ($record.status -ceq 'OperationSucceeded' -and [string]::IsNullOrWhiteSpace($hash) -and
            $latestLegacyKeys.ContainsKey($targetKey)) {
            $latestLegacyKeys[$targetKey]
        } else {
            '{0}|{1}' -f $targetKey, $hash
        }
        switch ([string]$record.status) {
            'Submitting' {
                $attempts[$key] = $record
                if (-not $attemptId) { $latestLegacyKeys[$targetKey] = $key }
            }
            'Unresolved' {
                $attempts[$key] = $record
                if (-not $attemptId) { $latestLegacyKeys[$targetKey] = $key }
            }
            'OperationSucceeded' { $attempts[$key] = $record }
            'Applied' {
                [void]$attempts.Remove($key)
                if (-not $attemptId -and $latestLegacyKeys.ContainsKey($targetKey) -and
                    $latestLegacyKeys[$targetKey] -ceq $key) {
                    [void]$latestLegacyKeys.Remove($targetKey)
                }
            }
            'Reconciled' {
                [void]$attempts.Remove($key)
                if (-not $attemptId -and $latestLegacyKeys.ContainsKey($targetKey) -and
                    $latestLegacyKeys[$targetKey] -ceq $key) {
                    [void]$latestLegacyKeys.Remove($targetKey)
                }
            }
            'OperationFailed' {
                [void]$attempts.Remove($key)
                if (-not $attemptId -and $latestLegacyKeys.ContainsKey($targetKey) -and
                    $latestLegacyKeys[$targetKey] -ceq $key) {
                    [void]$latestLegacyKeys.Remove($targetKey)
                }
            }
        }
    }
    return @($attempts.Values)
}

Export-ModuleMember -Function @(
    'Assert-MiningAnalyticsCreatedItemIdentity',
    'Assert-MiningAnalyticsDefinitionMatches',
    'Get-MiningAnalyticsFabricItems',
    'Get-MiningAnalyticsMatchingItem',
    'Get-PendingMiningAnalyticsCreates'
)
