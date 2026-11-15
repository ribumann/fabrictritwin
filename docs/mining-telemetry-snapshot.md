# Mining historical telemetry snapshots

This is a separate **historical snapshot**, not live or automatically refreshing
telemetry. It takes actual validated D01 Eventhouse facts for an explicit completed
run, reconciles their exact event identities, and creates isolated native Lakehouse
tables, a Direct Lake semantic model, and a bound Power BI report. The existing
topology model/report, ontology, Data Agent, and TriTwin items are not changed.

The script is a deployment mechanism, not proof that a particular deployment
succeeded. A native acceptance receipt must end in `VerifiedNativeSnapshot`.
Portal visual verification is explicitly separate and remains `Not performed`
unless an authorized user checks the report in Fabric.

## Sources and guarantees

`scripts/fabric/MiningSnapshot.psm1` uses the pinned catalog validator and existing
OneLake upload, schema-scoped table-load, SQL/Delta verification, and append-only
write-journal helpers. Snapshot files use Parquet with an explicit all-string
schema: Fabric's CSV loader infers types and would otherwise truncate 100ns
receipt timestamps to microseconds. The shared uploader supports binary source
bytes, and the table verifier accepts explicit event-ID row-sort keys; existing
catalog CSV loading/sorting is unchanged.

Before any upload, a bounded capture must establish all of the following:

- The public durable publisher-status endpoint identifies the exact run as
  accepted and `publisher_complete`, with no stop request.
- `mining_RunIngestion` reports `READY`, zero conflicts/quarantine, and exact
  reviewed event counts and sorted-event-ID SHA-256 hashes for both raw and
  validated telemetry/state families.
- Extracted validated facts independently match those exact identity sets. Every
  event ID must be SHA-256 of `run_id:sequence`; the validated source contract,
  catalog/profile, tag/module/equipment/unit joins, quality, state, finite values,
  and timestamps must pass validation. Identical redeliveries collapse to one
  event with its earliest actual source receipt. Conflicting payloads fail.

The input is a reviewed **event-identity expectation**, not an invented publisher
manifest. Publisher start/stop times, duration, seed, and replayed values are not
inferred from observations. The observed minimum/maximum event timestamps are
labeled as observed, and each fact carries the source event/receipt times,
run ID, snapshot as-of time, source fingerprints, and contract versions. The
capture does not claim independent publisher-payload regeneration.

The extraction is capped at 2,001 rows per fact family and rejects more than
2,000 source copies; the observed interval cannot exceed 30 minutes. Kusto
embedded errors and partial/malformed envelopes fail closed. Native writes do
not start if capture fails. Capture and receipts must remain outside the repo.

## Reviewed inputs

Use PowerShell 7.5+, Python with a supported PyArrow binary wheel, and an
already-authorized Azure CLI identity. Install the deployment-only writer in a
local virtual environment with
`python -m pip install --only-binary=:all: -r scripts\fabric\requirements-mining-snapshot.txt`.
No script signs
in, switches accounts, changes roles/consent, or resumes/pauses capacity.
Tokens stay in memory and their caller, tenant, audience, and lifetime are checked.

Create a local target JSON with these fields, using the reviewed actual values:

```json
{
  "TenantId": "00000000-0000-4000-8000-000000000001",
  "SubscriptionId": "00000000-0000-4000-8000-000000000002",
  "CallerObjectId": "00000000-0000-4000-8000-000000000003",
  "WorkspaceId": "00000000-0000-4000-8000-000000000004",
  "StaticLakehouseId": "00000000-0000-4000-8000-000000000005",
  "SourceSchema": "dbo",
  "SqlEndpointId": "00000000-0000-4000-8000-000000000006",
  "SqlServer": "example.datawarehouse.fabric.microsoft.com",
  "SqlDatabase": "mining_example_lakehouse",
  "KustoEndpoint": "https://example.z2.kusto.fabric.microsoft.com/",
  "KustoDatabase": "mining-example-realtime",
  "PublisherStatusUri": "https://example.invalid/api/mining/demo/runs/status"
}
```

The Lakehouse ID/name, SQL endpoint ID/hostname, local storage location, schema,
metadata visibility, `dbo` read access, complete shortcut inventory, and Delta
column-mapping configuration are checked before loading facts. The source must
be a schema-enabled Lakehouse with local, unmapped string columns.

The expectation JSON contains the explicit `plantId`, `runId`, the approved
`contract` (`catalogVersion`, `profileVersion`, `evaluatorReplayVersion`), and
`expected.telemetry` / `expected.state`, each with integer `count` and lowercase
64-character `hash`. Obtain these hashes from reviewed exact-run reconciliation
or the repository's `expectedMiningEventIds` run-contract helper, never from a
newly selected current run or by accepting whatever was extracted. Its canonical
hash algorithm is SHA-256 of ordinal-sorted unique event IDs joined with LF,
without a trailing LF.

## Capture, review, apply, verify

```powershell
$common = @{
    TargetPath = 'C:\reviewed\snapshot-target.json'
    RunExpectationPath = 'C:\reviewed\run-expectation.json'
    CapturePath = 'C:\evidence\run-capture.json'
}
.\scripts\provision\deploy-mining-snapshot.ps1 @common -Mode Capture `
    -AsOfUtc '2026-01-01T01:00:00.000Z'
```

Capture uses the explicit run ID, never a server-selected current telemetry run.
The public publisher-status read sends no bearer token. It must still identify
the requested run; if that endpoint has moved to another run, this helper stops
rather than substituting it. Review the saved source queries, evidence, and
reconciled facts, then retain the returned capture hash.

```powershell
.\scripts\provision\deploy-mining-snapshot.ps1 @common -Mode Apply `
    -CaptureSha256 $reviewedCaptureHash `
    -ReceiptPath 'C:\evidence\apply.jsonl' `
    -ApproveSnapshotWrites -ExclusiveWriterWindowId 'reviewed-snapshot-window'

.\scripts\provision\deploy-mining-snapshot.ps1 @common -Mode Verify `
    -CaptureSha256 $reviewedCaptureHash `
    -ReceiptPath 'C:\evidence\verify.jsonl'
```

`-AzureCliPython` optionally selects an existing Azure CLI Python executable;
it invokes that executable with `-IBm azure.cli` and never changes identity.
`-PythonExecutable` selects the separate Parquet-writer environment; dependencies
must not be installed into the Azure CLI installation.

Tables are named `mining_D01_snapshot_v1_<run UUID without hyphens>_telemetry` and
`..._state` in `dbo`. Source CSV files use the existing content-addressed
`Files/mining-D01/<SHA-256>/` namespace, with `.parquet` files. The two items are named
`mining-d01-snapshot-<run UUID without hyphens>-semanticmodel` and `...-report`.
The same run/as-of capture reuses only exactly verified native facts and
definitions; different content under an existing name is rejected, never updated.
Use a reviewed exclusive-writer window because the native load API has no
create-only table operation. Absence is checked again after upload, but there is
no atomic create-only guarantee across the final check and table load.

The report's canonical connection includes the workspace name read back from
the exact workspace ID and the isolated model's name/ID; these are not inferred
from an unrelated report. Creation uses a complete paginated inventory and exact definition verification,
not display-name existence alone. Every mutation is journaled before submission.
The service-expanded `CY25SU12` shared base theme is accepted only at its pinned
reviewed native hash; other added or changed definition resources fail.
An unresolved create, load, or refresh is never blindly retried. Preserve the
receipt, reconcile acknowledged IDs/operations with read-only requests, and use
a new receipt for verification. A fresh apply is only safe after proving that
the prior request was not accepted or verifying all its residual state.

Native acceptance checks every loaded row through SQL and Delta metadata, the
complete refresh for its exact request ID, the report's exact dataset binding,
visual-shaped semantic results, and both full semantic event-ID sets/hashes.
Identical state observation tuples can represent distinct real events; visual
groups must match their exact source-derived event multiplicities, while the
separate full event-ID query must still return every event.
HTTP 200 containing a semantic error does not pass. Read-only `Verify` submits
neither item/table mutations nor refreshes; `getDefinition` and `executeQueries`
are read-only API operations despite using POST.

The report exposes observed event time, run/as-of provenance, readings with
explicit tag/unit labels, state transitions, and exact raw reading evidence.
Reading measures require one tag and one unit; no multi-unit total or synthetic
availability/rate KPI is manufactured. Direct Lake fallback is disabled.

## Observed native acceptance: 15 November 2026

The actual reconciled run was `60ac23d3-e0fa-4da7-8ed9-cf79fc1fbcd5`,
captured as of `2026-11-15T17:31:48.989Z`. Telemetry event times span
`16:47:32.029Z`–`16:52:02.029Z`; combined telemetry/state observations start
at `16:47:02.029Z` and end at the same time. These are observed event times,
not inferred publisher-manifest fields.

The separate native model is `84354540-6365-489a-9b30-9d3ef101e95e`;
the bound report is `b8332814-5fe3-45b6-b985-847f46ebc265`. Read-only
verification completed with `VerifiedNativeSnapshot`, including:

- Every native SQL row and Delta schema/history matched the 505 telemetry and
  32 state facts. Canonical row hashes were
  `44a1f734fc17857c7a86333f778a2c86d766ed82a2f11aee0269d3467dbc4615`
  and `8c173275a17bee7c98ebd1353bc0002fb43f693bfe9ef95ae4f98351a3e63aa3`.
- Both semantic event-ID sets matched the reviewed source hashes:
  telemetry `1e58b534772a561240fea05dafd50b9e2bec679388b8be71206ebd6651358d9e`,
  state `e55a9cb99715bdf5b37f0a209c7acc11ec6bd88513422185ea46d6d986da2c12`.
- The telemetry visual-shaped query returned 505 exact dimension/value groups.
  The state query returned 28 exact observation tuples representing all 32
  events: four real tuples each have two distinct source event IDs. No event
  was dropped from the separate 32-ID semantic query.
- Original API refresh `c0e2faa5-aa45-473c-9f08-2996ebeac358` completed at
  `18:03:12.507Z`; Direct Lake framing
  `10f96995-2bd8-41d1-a508-de0c5b2e3088` completed at `18:03:08.620Z`.
  The initial HTTP 202 omitted the documented operation-identity headers, so
  apply stopped and history was reconciled read-only; no refresh was retried.

Separately, the coordinating operator's existing authenticated Fabric browser
rendered all four real native visuals without errors and selected a reading
to filter its exact telemetry evidence. The independent state fact remained
unfiltered. This was not an anonymous native-report test; no account was
selected or changed. The automated receipt's portal field remains
`Not performed` because browser verification is separate.

An earlier CSV attempt was rejected for inferred types/timestamp precision.
Its noncanonical residual table,
`mining_D01_snapshot_60ac23d3e0fa4da78ed9cf79fc1fbcd5_telemetry`
(without `_v1_`), is preserved, not referenced by the model, and not accepted
as snapshot evidence. No existing table or topology item was deleted or
overwritten. This dated acceptance is not a future health guarantee.

## Checks and boundaries

```powershell
Import-Module Pester -RequiredVersion 5.6.1
Invoke-Pester -Path .\tests\pester\Mining-Snapshot.Tests.ps1,
    .\tests\pester\Mining-Ontology.Tests.ps1
```

These are credential-free unit/regression tests, not live deployment proof.
Run `python tests\python\test_mining_snapshot_parquet.py` in the writer environment
to verify deterministic Parquet bytes and exact submicrosecond string preservation.
CI and Copilot setup install the pinned writer dependency and run these tests
alongside the credential-free PowerShell tests.
The snapshot has no scheduled refresh or automatic Eventhouse-to-Lakehouse sync.
The public cockpit is unchanged, and the native report is not published to the
internet. Do not bind the topology Data Agent to this model implicitly.
No cleanup deletes existing tables/items or shared capacity.
