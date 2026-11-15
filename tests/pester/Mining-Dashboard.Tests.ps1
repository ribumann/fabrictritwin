BeforeAll {
    $script:generator = Join-Path $PSScriptRoot '..\..\scripts\fabric\New-MiningDashboardDefinition.ps1'
    $script:parameters = @{
        DashboardId = '11111111-1111-4111-8111-111111111111'
        WorkspaceId = '22222222-2222-4222-8222-222222222222'
        QueryEndpoint = 'https://example.z6.kusto.fabric.microsoft.com'
        DatabaseName = 'mining-test'
    }
}

Describe 'Offline Mining dashboard authoring' {
    It 'keeps every query-backed tile linked to a stable page and datasource across generation' {
        $first = Join-Path $TestDrive 'first.json'
        $second = Join-Path $TestDrive 'second.json'
        & $generator @parameters -OutputPath $first
        & $generator @parameters -OutputPath $second
        (Get-Content $first -Raw) | Should -BeExactly (Get-Content $second -Raw)
        $request = Get-Content $first -Raw | ConvertFrom-Json
        $part = $request.definition.parts[0]
        $dashboard = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part.payload)) | ConvertFrom-Json
        $dashboard.tiles.Count | Should -Be 4
        @($dashboard.tiles.id | Select-Object -Unique).Count | Should -Be 4
        foreach ($tile in $dashboard.tiles) {
            $tile.pageId | Should -BeExactly $dashboard.pages[0].id
            $tile.dataSourceId | Should -BeExactly $dashboard.dataSources[0].id
            $tile.query | Should -Match 'timestamp between'
            $tile.query | Should -Match 'received_at <= asof'
        }
        $dashboard.tiles[1].query | Should -Match 'mining_RunIngestion'
        $dashboard.tiles[3].query | Should -Match 'status == "OK" and coverage >= 0.9'
    }
    It 'rejects untrusted query targets and database injection before writing output' {
        foreach ($endpoint in @(
            'http://example.z6.kusto.fabric.microsoft.com',
            'https://example.z6.kusto.fabric.microsoft.com.evil.test',
            'https://user:password@example.z6.kusto.fabric.microsoft.com'
        )) {
            $values = $parameters.Clone()
            $values.QueryEndpoint = $endpoint
            $output = Join-Path $TestDrive 'invalid.json'
            { & $generator @values -OutputPath $output } | Should -Throw '*exact Fabric Kusto query target*'
            Test-Path $output | Should -BeFalse
        }
        $values = $parameters.Clone()
        $values.DatabaseName = "mining`n.show tables"
        { & $generator @values -OutputPath (Join-Path $TestDrive 'injected.json') } | Should -Throw
    }
}
