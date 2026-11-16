#Requires -Version 7.0
BeforeAll {
    $script:bootstrap = Join-Path $PSScriptRoot '..\..' 'scripts\fabric\Prepare-IsolatedMiningDataAgent.ps1'
    $script:invokeBootstrap = Join-Path $PSScriptRoot '..\..' 'scripts\fabric\Invoke-IsolatedMiningDataAgentBootstrap.ps1'
    $script:lakehouse = '11111111-2222-4333-8444-555555555555'
    $script:model = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    $script:workspace = '4a809e56-42a8-4c30-a84f-83a47dd8793f'
}

Describe 'Isolated Mining preparation' {
    It 'generates the pinned catalog and model without a fabricated agent ID' {
        $result = & $script:bootstrap -LakehouseId $script:lakehouse
        $result.Status | Should -BeExactly 'GeneratedNotPublished'
        $result.CatalogStatus | Should -BeExactly 'GeneratedOnly'
        $result.WorkspaceId | Should -BeExactly $script:workspace
        $result.CatalogTables | Should -HaveCount 12
        $result.DataAgentDefinition | Should -BeNullOrEmpty
        @($result.SemanticModelRequest.definition.parts | Where-Object path -Like 'definition/tables/*.tmdl') |
            Should -HaveCount 12
        $expression = $result.SemanticModelRequest.definition.parts | Where-Object path -CEQ 'definition/expressions.tmdl'
        [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($expression.payload)) |
            Should -Match ([regex]::Escape("$script:workspace/$script:lakehouse"))
    }

    It 'binds the agent definition to the supplied model in the isolated workspace' {
        $result = & $script:bootstrap -LakehouseId $script:lakehouse -SemanticModelId $script:model
        $part = $result.DataAgentDefinition.definition.parts |
            Where-Object path -Like '*/datasource.json'
        $source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part.payload)) | ConvertFrom-Json
        $source.workspaceId | Should -BeExactly $script:workspace
        $source.artifactId | Should -BeExactly $script:model
        $source.elements | Should -HaveCount 12
    }

    It 'rejects a target in another workspace before any cloud access' {
        $target = Join-Path $TestDrive 'wrong-target.json'
        @{ WorkspaceId = 'db05aacb-bd7c-405a-a19b-90cc1c67d87b'; StaticLakehouseId = $script:lakehouse } |
            ConvertTo-Json | Set-Content -LiteralPath $target
        { & $script:bootstrap -LakehouseId $script:lakehouse -Mode CatalogApply `
                -TargetPath $target -ReceiptPath (Join-Path $TestDrive 'receipt.jsonl') } |
            Should -Throw '*approved isolated workspace*'
        Test-Path (Join-Path $TestDrive 'receipt.jsonl') | Should -BeFalse
    }

    It 'rejects a Lakehouse mismatch and an empty ID' {
        $target = Join-Path $TestDrive 'wrong-lakehouse.json'
        @{ WorkspaceId = $script:workspace; StaticLakehouseId = $script:model } |
            ConvertTo-Json | Set-Content -LiteralPath $target
        { & $script:bootstrap -LakehouseId $script:lakehouse -Mode CatalogVerify `
                -TargetPath $target -ReceiptPath (Join-Path $TestDrive 'receipt.jsonl') } |
            Should -Throw '*selected Lakehouse*'
        { & $script:bootstrap -LakehouseId ([guid]::Empty) } | Should -Throw '*nonempty*'
    }

    It 'keeps the explicit apply path inert under WhatIf' {
        $target = Join-Path $TestDrive 'target.json'
        @{
            TenantId = '11111111-2222-4333-8444-555555555555'
            SubscriptionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
            WorkspaceId = $script:workspace
            CallerObjectId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
        } | ConvertTo-Json | Set-Content -LiteralPath $target
        $result = & $script:invokeBootstrap -TargetPath $target `
            -CatalogReceiptPath (Join-Path $TestDrive 'catalog.jsonl') `
            -NativeReceiptPath (Join-Path $TestDrive 'native.jsonl') -Apply -WhatIf
        $result.Status | Should -BeExactly 'WhatIf'
        Test-Path (Join-Path $TestDrive 'native.jsonl') | Should -BeFalse
    }
}
