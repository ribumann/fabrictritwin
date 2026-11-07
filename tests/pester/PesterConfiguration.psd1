@{
    # Pester 5 configuration for scripts/ smoke and unit tests (Constitution Principle IV/Testing).
    # 'Integration' tests hit live Azure/Fabric resources (Smoke-Test.Tests.ps1) and are
    # excluded here so the default/CI unit-test run stays fast and mock-only; they are run
    # separately (and only after provisioning) by scripts/validate/smoke-test.ps1.
    Run          = @{
        Path     = 'tests/pester'
        Exit     = $true
    }
    Filter       = @{
        ExcludeTag = 'Integration'
    }
    Output       = @{
        Verbosity = 'Detailed'
    }
    TestResult   = @{
        Enabled      = $true
        OutputPath   = 'tests/pester/TestResults/pester-results.xml'
        OutputFormat = 'NUnitXml'
    }
    CodeCoverage = @{
        Enabled = $false
    }
}
