#Requires -Version 7.0

BeforeAll {
    $script:Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
    $script:FixtureDirectory = Join-Path $script:Root 'scripts\fabric\fixtures'
    $script:QueryPath = Join-Path $script:FixtureDirectory 'mining-engine-self-test.kql'
    $script:ManifestPath = Join-Path $script:FixtureDirectory 'mining-engine-self-test.manifest.json'
    $script:Query = Get-Content -LiteralPath $script:QueryPath -Raw
    $script:Manifest = Get-Content -LiteralPath $script:ManifestPath -Raw | ConvertFrom-Json
    $script:ExpectedSourceHashes = @{
        'infra/fabric/eventhouse/MiningValidation.kql' = 'e733da5365075ea850588f1bf57ff3bc3ff7a2055fa3217149c5f4d26b94e0df'
        'infra/fabric/eventhouse/MiningQueries.kql' = 'aa2e41fa8d370f77e217da5304cd0ad7c5c4c1cce2b22b8ca541fa9b38f19c05'
        'apps/simulator/src/mining/plant-catalog.json' = '0ba278e5e28b3466381534c5a920ce28b551cb3a7ddfc68cdf4371749f2c62ce'
        'apps/simulator/src/mining/catalog.ts' = 'ae699fe26beaad2f245a317ecb96e9dbfdecdf0414a34e1eb26a31f5f1930a66'
    }
}

Describe 'Synthetic mining KQL engine self-test' {
    It 'pins the exact generated payload and frozen source files' {
        $script:Manifest.schemaVersion | Should -Be 1
        $script:Manifest.status | Should -Be 'synthetic-engine-self-test-only'
        $script:Manifest.sourceCommit | Should -Be '324d73496913b4a2944713eb8861f2b7fdba4c02'
        $script:Manifest.querySha256 | Should -Be '8726333c69ca5de38c8d784ec555e035a7b9b10662564609d79826e752d4f9e4'
        $script:Manifest.queryBytes | Should -Be 106707
        $script:Manifest.fixtureSha256 | Should -Be '4e08566ab5d6ed9995a31588f70ac745067ad124196ef01d7c79929d33d8c7c5'
        (Get-FileHash -LiteralPath $script:QueryPath -Algorithm SHA256).Hash.ToLowerInvariant() |
            Should -Be $script:Manifest.querySha256

        foreach ($source in $script:Manifest.sourceFiles) {
            $source.sha256 | Should -Be $script:ExpectedSourceHashes[$source.path]
            $relativePath = $source.path.Replace('/', '\')
            $path = Join-Path $script:Root $relativePath
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() |
                Should -Be $source.sha256
        }
    }

    It 'keeps every binding local and the payload bounded and aggregate-only' {
        [IO.File]::ReadAllBytes($script:QueryPath).Length |
            Should -BeLessOrEqual $script:Manifest.maxBytes
        $script:Query | Should -Match '(?m)^let _selftest_PlantCatalog = datatable\('
        ([regex]::Matches($script:Query, '\bdatatable\(')).Count | Should -Be 7
        ([regex]::Matches($script:Query, '(?m)^print$')).Count | Should -Be 1
        $script:Query | Should -Not -Match '(?im)^\s*\.(create|alter|drop|set)\b'
        $script:Query | Should -Not -Match '\bmining_[A-Za-z0-9_]+\b'
        $script:Query | Should -Not -Match '\b(cluster|database)\s*\('
        $script:Query | Should -Not -Match '\bingestion_time\s*\('
        $script:Query | Should -Not -Match '\|\s*render\b'
        $finalOutput = $script:Query.Substring($script:Query.LastIndexOf("`nprint") + 1)
        $finalOutput | Should -Match '(?s)^print\s+self_test_passed\s*=.*summary_feed_tph.*compare_good_samples.*active_incidents.*;$'
        $finalOutput | Should -Not -Match '\b(event_id|tagId|seriesId|evidence|received_at)\b'
    }

    It 'pins deterministic happy-path expectations and labels synthetic readiness' {
        $script:Manifest.fixture.catalogRows | Should -Be 194
        $script:Manifest.fixture.profileRows | Should -Be 56
        $script:Manifest.fixture.telemetryRows | Should -Be 23
        $script:Manifest.fixture.telemetryLogicalEvents | Should -Be 22
        $script:Manifest.fixture.stateRows | Should -Be 4
        $script:Manifest.fixture.incidentRows | Should -Be 1
        $expected = $script:Manifest.fixture.expected
        $expected.sourceStatus | Should -Be 'READY (synthetic only)'
        $expected.latestTagRows | Should -Be 56
        $expected.latestGoodTagRows | Should -Be 11
        $expected.latestStateRows | Should -Be 4
        $expected.unknownTagRows | Should -Be 45
        $expected.summaryStatus | Should -Be 'OK'
        $expected.summaryFeedTph | Should -Be 42
        $expected.summaryProcessedTonnes | Should -Be 0.7
        $expected.summaryRunningLines | Should -Be 3
        $expected.summaryCommonCoverage | Should -Be 1
        $expected.assetTrendRows | Should -Be 1
        $expected.compareLinesRows | Should -Be 3
        $expected.compareGoodSamples | Should -Be 6
        $expected.activeIncidents | Should -Be 1
        $expected.retryCopies | Should -Be 2
        $script:Query | Should -Match 'Local READY flags exercise query branches only'
    }
}
