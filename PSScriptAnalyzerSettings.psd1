@{
    # PSScriptAnalyzer settings for all scripts under scripts/ (Constitution Principle IV).
    # Run via: Invoke-ScriptAnalyzer -Path ./scripts -Recurse -Settings ./PSScriptAnalyzerSettings.psd1
    Severity     = @('Error', 'Warning')
    IncludeDefaultRules = $true
    Rules        = @{
        PSAvoidUsingCmdletAliases      = @{ Enable = $true }
        PSAvoidUsingPositionalParameters = @{ Enable = $true }
        PSUseDeclaredVarsMoreThanAssignments = @{ Enable = $true }
        PSProvideCommentHelp           = @{
            Enable = $true
            ExportedOnly = $false
            BlockComment = $true
            Placement = 'before'
        }
        PSUseShouldProcessForStateChangingFunctions = @{ Enable = $true }
        PSUseConsistentIndentation      = @{
            Enable = $true
            IndentationSize = 4
        }
        PSUseConsistentWhitespace       = @{ Enable = $true }
    }
    ExcludeRules = @('PSAvoidUsingWriteHost')
}
