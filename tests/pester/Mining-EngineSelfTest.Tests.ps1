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
        'infra/fabric/eventhouse/MiningQueries.kql' = '818036feac8f5edb23c2c3564014c1ab0b4271f1926dc3257a87271c53e1ab1a'
        'apps/simulator/src/mining/plant-catalog.json' = '0ba278e5e28b3466381534c5a920ce28b551cb3a7ddfc68cdf4371749f2c62ce'
        'apps/simulator/src/mining/catalog.ts' = 'ae699fe26beaad2f245a317ecb96e9dbfdecdf0414a34e1eb26a31f5f1930a66'
        'infra/fabric/eventhouse/MiningSchema.kql' = 'd8b21287a96c87a041f7f741f3233f4da47bcd0a1c53bcd8db6e88a5bb2c26c1'
    }
}

Describe 'Synthetic mining KQL engine self-test' {
    It 'pins the exact generated payload and frozen source files' {
        $script:Manifest.schemaVersion | Should -Be 2
        $script:Manifest.status | Should -Be 'synthetic-engine-self-test-only'
        $script:Manifest.sourceRevision | Should -Be 'd01-kql-coverage-bins-v5'
        $script:Manifest.sourceBaseCommit | Should -Be '4d1f93b6d1cc7e940d24f73621742329c112197d'
        $script:Manifest.historicalSource.sourceCommit | Should -Be '324d73496913b4a2944713eb8861f2b7fdba4c02'
        $script:Manifest.historicalSource.sourceFiles[1].sha256 | Should -Be 'aa2e41fa8d370f77e217da5304cd0ad7c5c4c1cce2b22b8ca541fa9b38f19c05'
        $script:Manifest.historicalSource.querySha256 | Should -Be 'a1a05bf82f28989d32b8c7190e7fc3a341038b90f4e28a5c9d1edae4f15034b4'
        $script:Manifest.historicalSource.queryBytes | Should -Be 108379
        $script:Manifest.previousCandidates[0].sourceCommit | Should -Be '40d13ed257b0eeba7323d89710bc364872c23956'
        $script:Manifest.previousCandidates[0].miningQueriesSha256 | Should -Be '68e69067deb7f898196ce2c64a95cd98e92652fd81b4e64866657d8acc037105'
        $script:Manifest.previousCandidates[0].querySha256 | Should -Be 'c90677d2dbba05d300b4550f35601a56b0d8a32a7c219ee461253325e08e0677'
        $script:Manifest.previousCandidates[0].queryBytes | Should -Be 108399
        $script:Manifest.previousCandidates[1].sourceCommit | Should -Be '73e4e428128d5dffd527074feca90d3a103231c9'
        $script:Manifest.previousCandidates[1].miningQueriesSha256 | Should -Be '9658f006440604d87b4211007dbd6e4990043ed6b80780e1808040dc343f91b8'
        $script:Manifest.previousCandidates[1].querySha256 | Should -Be '0b3e3027612fab95ce513d2dafcfbfabc01cda0fdf34773c135e85713bd8a9cb'
        $script:Manifest.previousCandidates[1].queryBytes | Should -Be 108379
        $script:Manifest.previousCandidates[2].sourceCommit | Should -Be 'b43bfc477da75433ef9cd33bf2eed56059b527cc'
        $script:Manifest.previousCandidates[2].miningQueriesSha256 | Should -Be '63f84951b34cf27722fb74f58234dac659af058d50dc2cb1430b58409fe48b4c'
        $script:Manifest.previousCandidates[2].querySha256 | Should -Be '380c2234bbd86545ea52b8cc0af90e58a7671b38aa5f76c4b8974c7eae9ffd41'
        $script:Manifest.previousCandidates[2].queryBytes | Should -Be 108395
        $script:Manifest.querySha256 | Should -Be '8097f6b29dfb2d483e36088d956015796d60c6c226ccc52c69e213b165867e5f'
        $script:Manifest.queryBytes | Should -Be 108410
        $script:Manifest.fixtureSha256 | Should -Be '5cd30adec57140734879e33ecffc4101da264dbe0fb172eff584b593e20fbac1'
        (Get-FileHash -LiteralPath $script:QueryPath -Algorithm SHA256).Hash.ToLowerInvariant() |
            Should -Be $script:Manifest.querySha256

        foreach ($source in $script:Manifest.sourceFiles) {
            $source.sha256 | Should -Be $script:ExpectedSourceHashes[$source.path]
            $relativePath = $source.path.Replace('/', '\')
            $path = Join-Path $script:Root $relativePath
            $actualHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actualHash -ne $source.sha256) {
                $sourceText = [Text.UTF8Encoding]::new($false, $true).GetString(
                    [IO.File]::ReadAllBytes($path)
                )
                $originalCheckoutText = [regex]::Replace($sourceText, '\r\n|\r|\n', "`r`n")
                $originalCheckoutBytes = [Text.Encoding]::UTF8.GetBytes($originalCheckoutText)
                $actualHash = [Convert]::ToHexString(
                    [Security.Cryptography.SHA256]::HashData($originalCheckoutBytes)
                ).ToLowerInvariant()
            }
            $actualHash | Should -Be $source.sha256
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

    It 'fixes the reserved latest identifier in deployable source and extracted payload' {
        $source = Get-Content -LiteralPath (Join-Path $script:Root 'infra\fabric\eventhouse\MiningQueries.kql') -Raw
        foreach ($text in @($source, $script:Query)) {
            $text | Should -Not -Match '\blet\s+latest\s*='
            $text | Should -Not -Match '\bjoin\s+kind=leftouter\s+latest\s+on\b'
            $text | Should -Match '\blet\s+latest_telemetry\s*='
            $text | Should -Match '\bjoin\s+kind=leftouter\s+latest_telemetry\s+on\s+tag_id\b'
        }
    }

    It 'masks conflicted strings with supported empty literals without hiding the conflict status' {
        $source = Get-Content -LiteralPath (Join-Path $script:Root 'infra\fabric\eventhouse\MiningQueries.kql') -Raw
        foreach ($text in @($source, $script:Query)) {
            $text | Should -Not -Match '\bstring\s*\(\s*null\s*\)'
            $text | Should -Match 'quality = iff\(event_conflict, "", quality\)'
            $text | Should -Match 'state = iff\(event_conflict, "", state\)'
            ([regex]::Matches($text, 'event_conflict, "DUPLICATE_CONFLICT"')).Count | Should -BeGreaterOrEqual 2
        }
    }

    It 'orders fixture timestamp dependencies and preserves real curated column contracts (offline only)' {
        $schema = Get-Content -LiteralPath (Join-Path $script:Root 'infra\fabric\eventhouse\MiningSchema.kql') -Raw
        foreach ($table in @('ValidatedTelemetry', 'ValidatedState', 'IncidentLedger')) {
            $columns = [regex]::Match(
                $schema, "\.create table mining_$table \(([^)]+)\)"
            ).Groups[1].Value.Split(',') | ForEach-Object { $_.Trim().Split(':')[0] }
            $binding = [regex]::Match(
                $script:Query, "(?s)let _selftest_$table = datatable\(.*?\| project ([^;]+);"
            )
            $binding.Success | Should -BeTrue
            $projected = $binding.Groups[1].Value.Split(',') | ForEach-Object { $_.Trim() }
            ($projected -join ',') | Should -Be ($columns -join ',')
            $timeColumn = if ($table -eq 'IncidentLedger') { 'occurred_at' } else { 'timestamp' }
            $binding.Value | Should -Match "\| extend $timeColumn = [^\r\n]+\r?\n\| extend received_at = $timeColumn \+"
        }
    }

    It 'binds summary coverage before ratio eligibility in real source and extracted payload' {
        $source = Get-Content -LiteralPath (Join-Path $script:Root 'infra\fabric\eventhouse\MiningQueries.kql') -Raw
        foreach ($text in @($source, $script:Query)) {
            $text | Should -Match 'invalid_common_bins == 0\s*\| extend ratio_ok = coverage_valid and conflict_event_count == 0'
            $text | Should -Not -Match 'invalid_common_bins == 0,\s*ratio_ok'
        }
    }

    It 'uses explicit unit-sized bins for all summary expected-sample denominators' {
        $source = Get-Content -LiteralPath (Join-Path $script:Root 'infra\fabric\eventhouse\MiningQueries.kql') -Raw
        foreach ($text in @($source, $script:Query)) {
            $text | Should -Not -Match '\bfloor\('
            foreach ($signal in @('feed_a', 'feed_b', 'feed_c', 'water', 'power')) {
                $expected = "${signal}_coverage = todouble(${signal}_good) / bin(todouble(duration_seconds) / todouble(${signal}_cadence), 1.0)"
                $text | Should -Match ([regex]::Escape($expected))
            }
        }
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

    It 'freezes independent arguments and expected results for every G5 function' {
        $cases = @($script:Manifest.fixture.semanticCases)
        $cases.Count | Should -Be 5
        ($cases.function -join ',') | Should -Be 'mining_PlantLatest,mining_PlantSummary,mining_AssetTrend,mining_ActiveIncidents,mining_CompareLines'
        $cases[0].arguments.run_id | Should -Be $script:Manifest.fixture.runId
        $cases[0].expected.rowCount | Should -Be 60
        $cases[0].expected.latestFeed.value | Should -Be 12
        $cases[1].expected.plantFeedTph | Should -Be 42
        $cases[1].expected.processedTonnes | Should -Be 0.7
        $cases[1].expected.grossProcessWaterM3PerT | Should -Be (1 / 21)
        $cases[1].expected.wholePlantEnergyKwhPerT | Should -Be (50 / 21)
        $cases[2].expected.tagId | Should -Be 'D01.A.crusher.ore_flow'
        $cases[2].expected.coverage | Should -Be 1
        $cases[3].expected.activeState | Should -Be 'ACTIVE_UNACKNOWLEDGED'
        $cases[4].expected.totalGoodSamples | Should -Be 6
        $cases[4].expected.lines.C.value | Should -Be 16
        $script:Query | Should -Match '_selftest_CompareMatch'
        $script:Query | Should -Match '_selftest_IncidentMatch'
    }

    It 'keeps live evidence criteria duplicate-aware and fail-closed' {
        $proof = $script:Manifest.proofRequirements
        $proof.status | Should -Be 'requirements-only-not-issued'
        @($proof.canaryPerTable).Count | Should -Be 2
        foreach ($table in $proof.canaryPerTable) {
            $table.expectedDistinctEventIds | Should -Be 1
            $table.observedDistinctEventIds | Should -Be 1
            $table.minimumCopies | Should -Be 1
            $table.lexemeMatchCopies | Should -Be 'equal copies'
            $table.wrongDestinationCopies | Should -Be 0
            $table.rawIngestionNonNullCopies | Should -Be 'equal copies'
        }
        $proof.classifierObservation.doNotInferExpectedRowsFromObservedCopies | Should -BeTrue
        $proof.classifierObservation.deduplicatedRowsPerExpectedEvent | Should -Be 1
        $proof.nativeReadback.status | Should -Be 'unavailable-unverified'
        $proof.nativeReadback.requiredOnEveryUse | Should -BeTrue
        $proof.selfTestContribution | Should -Be 'informational-only; never grants deployment or source readiness'
    }

    It 'requires one correct row per line in the emitted comparison predicate (offline model only)' {
        $expression = [regex]::Match(
            $script:Query, '(?s)let _selftest_CompareMatch =\s*(.*?)\s*;'
        ).Groups[1].Value
        $pattern = 'toscalar\(_selftest_CompareRows \| where line_id == "(?<line>[ABC])" and tag_id == "(?<tag>[^"]+)" and value == (?<value>\d+\.0) and unit == "(?<unit>[^"]+)" and good_count == (?<good>\d+) and coverage == (?<coverage>\d+\.0) \| count\) == 1'
        $predicates = [regex]::Matches($expression, $pattern)
        $predicates.Count | Should -Be 3
        ([regex]::Replace($expression, $pattern, 'MATCH') -replace '\s+', ' ').Trim() |
            Should -Be 'MATCH and MATCH and MATCH'
        (($predicates | ForEach-Object { $_.Groups['line'].Value }) -join ',') | Should -Be 'A,B,C'

        $rows = @(
            @{ line = 'A'; tag = 'D01.A.crusher.ore_flow'; value = 12; unit = 't/h'; good = 2; coverage = 1 }
            @{ line = 'B'; tag = 'D01.B.crusher.ore_flow'; value = 14; unit = 't/h'; good = 2; coverage = 1 }
            @{ line = 'C'; tag = 'D01.C.crusher.ore_flow'; value = 16; unit = 't/h'; good = 2; coverage = 1 }
        )
        $matchesContract = {
            param($observed)
            if (@($observed).Count -ne 3) { return $false }
            foreach ($predicate in $predicates) {
                $matching = @($observed | Where-Object {
                    $_.line -ceq $predicate.Groups['line'].Value -and
                    $_.tag -ceq $predicate.Groups['tag'].Value -and
                    $_.value -eq [double]::Parse($predicate.Groups['value'].Value, [cultureinfo]::InvariantCulture) -and
                    $_.unit -ceq $predicate.Groups['unit'].Value -and
                    $_.good -eq [int]$predicate.Groups['good'].Value -and
                    $_.coverage -eq [double]::Parse($predicate.Groups['coverage'].Value, [cultureinfo]::InvariantCulture)
                })
                if ($matching.Count -ne 1) { return $false }
            }
            return $true
        }
        (& $matchesContract $rows) | Should -BeTrue
        (& $matchesContract @($rows[0], $rows[0], $rows[0])) | Should -BeFalse
        foreach ($missing in 0..2) {
            $remaining = @($rows | Where-Object { $_.line -ne $rows[$missing].line })
            (& $matchesContract $remaining) | Should -BeFalse
            (& $matchesContract @($remaining + $remaining[0])) | Should -BeFalse
        }
        foreach ($field in @('tag', 'value', 'unit', 'good', 'coverage')) {
            $invalid = $rows[1].Clone()
            $invalid[$field] = if ($field -in @('tag', 'unit')) { 'wrong' } else { -1 }
            (& $matchesContract @($rows[0], $invalid, $rows[2])) | Should -BeFalse
        }
        $script:Query | Should -Match 'toscalar\(_selftest_CompareRows \| count\) == 3'
    }

    It 'checks each summary line feed rather than only the plant total (offline model only)' {
        $expression = [regex]::Match(
            $script:Query, '(?m)^let _selftest_SummaryMatch = (.*);$'
        ).Groups[1].Value
        $pattern = 'abs\(line_(?<line>[abc])_feed_tph - (?<value>\d+\.0)\) < 0\.000001'
        $predicates = [regex]::Matches($expression, $pattern)
        $predicates.Count | Should -Be 3
        $expression | Should -Not -Match '\bor\b'
        $expected = @{ a = 12; b = 14; c = 16 }
        foreach ($predicate in $predicates) {
            $line = $predicate.Groups['line'].Value
            [double]::Parse($predicate.Groups['value'].Value, [cultureinfo]::InvariantCulture) |
                Should -Be $expected[$line]
        }
        foreach ($observed in @(
            @{ a = 12; b = 14; c = 16 }
            @{ a = 14; b = 12; c = 16 }
            @{ a = 12; b = 16; c = 14 }
            @{ a = 16; b = 14; c = 12 }
        )) {
            ($observed.a + $observed.b + $observed.c) | Should -Be 42
            $matches = @($predicates | Where-Object {
                $value = [double]::Parse($_.Groups['value'].Value, [cultureinfo]::InvariantCulture)
                [math]::Abs($observed[$_.Groups['line'].Value] - $value) -lt 0.000001
            }).Count -eq 3
            $matches | Should -Be ($observed.a -eq 12 -and $observed.b -eq 14 -and $observed.c -eq 16)
        }
    }
}
