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
items. Inventory is read across every Fabric continuation page, and duplicate,
ambiguous, or wrong-type identities fail closed. Before refresh or reuse, the
script retrieves the complete native definition of any existing item and
compares every expected part to the generated reviewed definition (JSON object
key ordering and TMDL line endings are normalized. The comparison permits only
observed Fabric normalizations: zeroed semantic-model logical ID, pbism version
4.2, TMDL indentation/property ordering and the model culture reference. It
also permits the exact CY25SU12 base-theme resource only when the report
definition references it. A Fabric-expanded report binding is accepted only
when its model ID, workspace, model name, and claims-token mode match the
selected items; other part or content differences block reuse.

Create attempts are journaled with attempt IDs before submission. A later run
reconciles outstanding entries against terminal Fabric operation results and
the exact returned item ID and native definition. Unknown operations, missing
result IDs, or mismatched definitions block further creates; an item with only
the same name is never treated as proof that a prior create succeeded.

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
