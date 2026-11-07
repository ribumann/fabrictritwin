#Requires -Version 7.0
<#
.SYNOPSIS
Pester tests for scripts/simulate/seed-history.ps1 (T058).

.DESCRIPTION
Validates the wrapper's parameter handling and idempotent no-op reporting while mocking the
underlying Node CLI invocation.
#>

BeforeAll {
    $script:SeedHistoryScript = (Resolve-Path (Join-Path $PSScriptRoot '..' '..' 'scripts' 'simulate' 'seed-history.ps1')).Path
    . $script:SeedHistoryScript
}

Describe 'seed-history.ps1 (T058)' {

    Context 'Parameter validation' {
        It 'throws when -AthleteId is not supplied' {
            { Invoke-SeedHistory } | Should -Throw '*AthleteId*required*'
        }
    }

    Context 'Idempotent no-op reporting' {
        BeforeEach {
            Mock -CommandName Get-SeedHistoryCliPath -MockWith {
                'C:\repo\apps\simulator\dist\cli\seed-history-cli.js'
            }

            Mock -CommandName Invoke-SeedHistoryCli -MockWith {
                [PSCustomObject]@{
                    ExitCode = 0
                    StdOut   = @'
{
  "athleteId": "11111111-1111-4111-8111-111111111111",
  "runId": "run-seed-001",
  "outcome": "already-seeded",
  "status": "already-seeded",
  "existingStatus": "completed"
}
'@
                }
            }
        }

        It 'returns the already-seeded JSON result without treating it as an error' {
            $result = Invoke-SeedHistory -AthleteId '11111111-1111-4111-8111-111111111111' -Environment 'test'

            $result.athleteId | Should -Be '11111111-1111-4111-8111-111111111111'
            $result.status | Should -Be 'already-seeded'
            $result.existingStatus | Should -Be 'completed'

            Should -Invoke -CommandName Invoke-SeedHistoryCli -Times 1 -Exactly -ParameterFilter {
                $AthleteId -eq '11111111-1111-4111-8111-111111111111' -and $Environment -eq 'test'
            }
        }
    }
}
