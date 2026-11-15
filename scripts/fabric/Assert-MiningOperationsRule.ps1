#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RuleDetailsPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$details = Get-Content -LiteralPath $RuleDetailsPath -Raw | ConvertFrom-Json
if (@($details).Count -ne 1 -or $null -eq $details.rule) {
    throw 'Expected one native get_rule_details JSON object.'
}
if ($null -ne $details.rule.actionBinding -or @($details.actions | Where-Object { $null -ne $_ }).Count -ne 0) {
    throw 'External actions are not authorized for the Mining freshness advisor.'
}
if ($details.rule.classExpression.'$type' -cne 'kqldataquery' -or
    $details.rule.ruleCondition.'$type' -cne 'propertywhenistrue' -or
    $details.rule.ruleCondition.dataPropertyName -cne 'NoEventsInLast5m') {
    throw 'Unexpected native Mining freshness condition.'
}
$queryPath = Join-Path $PSScriptRoot '..\..\infra\fabric\mining-operations-agent\source-freshness.kql'
$expected = [IO.File]::ReadAllText($queryPath).Replace("`r`n", "`n").Trim()
$actual = ([string]$details.rule.classExpression.expression).Replace("`r`n", "`n").Trim()
if ($actual -cne $expected) {
    throw 'Native query differs from the reviewed Mining freshness template; inspect and execute it before approval.'
}
[PSCustomObject]@{
    ruleId = $details.rule.id
    queryMatchesReviewedTemplate = $true
    externalActions = $false
}
