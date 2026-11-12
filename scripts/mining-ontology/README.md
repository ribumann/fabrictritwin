# D01 native ontology source (offline)

This additive **old-experience JSON** source consumes the simulator-owned
`apps/simulator/src/mining/plant-catalog.json` at its pinned byte hash. It does
not copy the catalog or modify the athlete templates. Merge the canonical
catalog change before using that repository path.

Privately save the existing ontology `getDefinition` **definition object**
(`{"parts":[...]}`), its SHA-256, a fresh current definition, and an exact-target
JSON file containing `TenantId`, `SubscriptionId`, `WorkspaceId`, `OntologyId`,
`StaticLakehouseId`, `OntologyOutputLakehouseId`, and `SourceSchema` (`dbo`).
Use the **existing static binding source** Lakehouse, never the ontology's
generated output Lakehouse. The planner requires native static-binding evidence
for that target, distinct item IDs, and a reviewed target-file hash.

```powershell
.\scripts\mining-ontology\plan.ps1 -CatalogPath $catalog `
  -BaselinePath $baseline -BaselineSha256 $reviewedBaselineHash `
  -CurrentPath $current -TargetPath $privateTarget `
  -TargetSha256 $reviewedTargetHash -OutputDirectory $newPrivateBundle
```

The bundle contains twelve static CSV tables, exact row/byte-hash receipts,
schema-scoped load request bodies, and the complete additive native definition.
Receipts describe **generated local bytes**, not loaded Delta rows. Six
namespaced types model Plant -> Line (including shared) -> Module -> Equipment
-> Tag, plus Stream. Directed Module -> Stream -> Module links preserve all
50 material/utility routes. Original identifiers, units, authored dimensions,
positions, ports, routing and evidence remain in `metadata_json`; logical
equipment gets no invented geometry or readings. Only the 56 catalog tags
exist. The source Lakehouse holds catalog data, never a telemetry copy.

Reserved native integer IDs are listed in
[`ownership.json`](../../infra/fabric/mining-ontology/ownership.json).
Bindings/contextualizations use deterministic GUIDs. Colliding IDs/names,
changed owned parts, unknown catalog bytes and current snapshot drift fail
closed. Every unrelated definition part retains its exact payload and metadata;
`definition.json` and `.platform` are not reconstructed. A repeated plan against
the desired snapshot has no added parts. `-Mode Verify` compares snapshots
**offline**; it does not prove active instances or source data.

**Apply is intentionally blocked**, including repeated attempts, without making
network requests. The live executor/receipts are not implemented here. Before
an approved executor can write: verify tenant/caller, capacity/workspace, item
ownership, Lakehouse write permission (`Lakehouse.ReadWrite.All` for delegated
load), managed tables without Delta column mapping, OneLake file permissions,
schema-enabled beta load availability, and exact loaded rows/hashes. Upload
catalog CSVs under `Files/mining-D01/<hash>/`, then use the planned
`.../schemas/dbo/tables/<owned-table>/load?beta=true` route, not legacy `/tables`.
Follow each load operation to completion and verify its data before submitting
the definition. Overwrite is scoped to these twelve owned tables only; never
append duplicate catalog rows. Reconcile uncertain outcomes, never blindly retry.

The old API supports `TimeSeries` / `KustoTable` with Eventhouse **item** ID,
cluster URI, database, table, timestamp column and property/key mappings.
No validated curated mining table is available yet: `event:dynamic` raw
ingestion is not a columnar, validated reading source. No time-series binding
is emitted until the ingestion owner establishes that prerequisite. Ontology
definition update has no documented atomic CAS: an approved exclusive-writer
window and fresh live preimage check are still required, not implied by hashes.
Retirement on **January 31, 2027** is a caveat, not authorization to migrate,
replace the shared ontology or enable tenant features.

References: [old native definition](https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/ontology-old-definition),
[old binding requirements](https://learn.microsoft.com/fabric/iq/ontology/old-experience/how-to-bind-data),
[schema-aware CSV loading](https://learn.microsoft.com/fabric/data-engineering/lakehouse-api),
[load permissions/payload](https://learn.microsoft.com/rest/api/fabric/lakehouse/tables/load-table),
[OneLake metadata](https://learn.microsoft.com/fabric/onelake/table-apis/delta-table-apis-overview).
