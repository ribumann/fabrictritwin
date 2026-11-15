# Mining D01 native analytics

The Mining D01 analytics items provide a native Fabric semantic model and report
over the existing `mining-d01-lakehouse` `dbo` catalog tables. The source is
curated static topology, not realtime telemetry. The model uses DirectLake and
does not modify the Lakehouse, graph, Eventhouse, eventstreams, or TriTwin
artifacts.

The model contains the six catalog entity tables and six relationship tables,
with endpoint-role relationships and measures for catalog counts, equipment
tag coverage, and topology groupings. The report presents modules per line,
equipment per module, tags per equipment, and incoming/outgoing process streams
per module.

## Generate, deploy, and verify

`scripts/fabric/New-MiningAnalyticsDefinition.ps1` deterministically generates
the native TMDL and PBIR definitions without cloud access. The deployment script
validates the selected tenant, workspace role, and Lakehouse before creating
only the missing Mining-owned items. It does not update or replace existing
items. Create requests are journaled before submission, and ambiguous operation
results must be reconciled before retrying.

Run from the repository root with PowerShell 7 and an Azure CLI sign-in that has
the required Fabric and Power BI access. Set the IDs and receipt path to the
intended environment; the receipt directory must already exist.

```powershell
./scripts/provision/deploy-mining-analytics.ps1 `
    -SubscriptionId '<subscription-guid>' `
    -TenantId '<tenant-guid>' `
    -WorkspaceId '<fabric-workspace-guid>' `
    -LakehouseId '<mining-lakehouse-guid>' `
    -ReceiptPath 'C:\path\to\receipts\mining-analytics.jsonl'
```

The script obtains access tokens in memory, requests a model refresh, runs
bounded ExecuteQueries checks for model measures and all four report groupings,
then verifies that the report is bound to the returned semantic model ID. Its
`Verified` result includes the actual metrics, group counts, visual totals, item
IDs, and report URL. `-WhatIf` suppresses creation of any missing item.

The focused definition tests run with the repository's existing Pester suite:

```powershell
./tests/pester/Run-Tests.ps1
```
