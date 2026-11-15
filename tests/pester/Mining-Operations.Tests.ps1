BeforeAll {
    $root = Join-Path $PSScriptRoot '..\..'
    $script:assertRule = Join-Path $root 'scripts\fabric\Assert-MiningOperationsRule.ps1'
    $script:generator = Join-Path $root 'scripts\fabric\New-MiningOperationsDefinition.ps1'
    $script:query = [IO.File]::ReadAllText((Join-Path $root 'infra\fabric\mining-operations-agent\source-freshness.kql')).Trim()
}

Describe 'Mining Operations Agent review gate' {
    BeforeEach {
        $script:details = @{
            rule = @{
                id = '11111111-1111-4111-8111-111111111111'
                classExpression = @{ '$type' = 'kqldataquery'; expression = $query }
                ruleCondition = @{ '$type' = 'propertywhenistrue'; dataPropertyName = 'NoEventsInLast5m' }
                actionBinding = $null
            }
            actions = $null
        }
        $script:path = Join-Path $TestDrive 'native-rule.json'
    }

    It 'accepts the reviewed query with platform line endings and no action' {
        $details.rule.classExpression.expression = $query.Replace("`r`n", "`n").Replace("`n", "`r`n") + "`r`n"
        $details | ConvertTo-Json -Depth 20 | Set-Content $path
        $result = & $assertRule -RuleDetailsPath $path
        $result.queryMatchesReviewedTemplate | Should -BeTrue
        $result.externalActions | Should -BeFalse
    }

    It 'rejects changed source scope, time bounds, aggregation and extra statements' {
        foreach ($candidate in @(
            $query.Replace("'D01'", "'D02'"),
            $query.Replace('endTime - 15m', 'endTime - 15d'),
            $query.Replace('countif(timestamp > endTime - 5m)', 'count()'),
            "$query; OtherTable | take 1"
        )) {
            $details.rule.classExpression.expression = $candidate
            $details | ConvertTo-Json -Depth 20 | Set-Content $path
            { & $assertRule -RuleDetailsPath $path } | Should -Throw '*differs from the reviewed*'
        }
    }

    It 'rejects the native generator leftouter-count bug and notification bindings' {
        $details.rule.classExpression.expression = 'range t from ago(15m) to now() step 1m | join kind=leftouter mining_ValidatedTelemetry on t | summarize count()'
        $details | ConvertTo-Json -Depth 20 | Set-Content $path
        { & $assertRule -RuleDetailsPath $path } | Should -Throw '*differs from the reviewed*'
        $details.rule.classExpression.expression = $query
        $details.rule.actionBinding = @{ actionId = 'unexpected-notification' }
        $details | ConvertTo-Json -Depth 20 | Set-Content $path
        { & $assertRule -RuleDetailsPath $path } | Should -Throw '*External actions*'
    }

    It 'rejects inverted conditions and multiple native rules' {
        $details.rule.ruleCondition.'$type' = 'propertywhenisfalse'
        $details | ConvertTo-Json -Depth 20 | Set-Content $path
        { & $assertRule -RuleDetailsPath $path } | Should -Throw '*condition*'
        @($details, $details) | ConvertTo-Json -Depth 20 | Set-Content $path
        { & $assertRule -RuleDetailsPath $path } | Should -Throw '*one native*'
    }
}

Describe 'Offline Mining Operations Agent authoring' {
    It 'rejects missing native target identities instead of writing a placeholder definition' {
        { & $generator -WorkspaceId ([Guid]::Empty) -KqlDatabaseId ([Guid]::NewGuid()) } | Should -Throw '*nonempty*'
        { & $generator -WorkspaceId ([Guid]::NewGuid()) -KqlDatabaseId ([Guid]::Empty) } | Should -Throw '*nonempty*'
    }
}
