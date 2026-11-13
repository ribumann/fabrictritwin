# Recover paused Eventstream routing

Accepted publisher sends and successful live WebSocket delivery do **not** prove
Eventhouse ingestion. Check the existing Eventstream's documented `/topology`:
`triathlon_custom_endpoint` and `triathlon_main_stream` can be `Running` while
`racesplit_stream` and `sessionmetric_stream` are `Paused`.

Keep the existing Fabric capacity **Active** throughout recovery and the bounded
ingestion check. A capacity pause/resume cycle can leave the derived streams
paused again; re-read topology after activation and apply recovery only if needed.
Coordinate the active window with the environment owner rather than changing
unknown suspension schedules. Local DNS may retain a negative answer after
activation; diagnose resolution for the same hostname without changing the
endpoint, database, token audience, or TLS verification.

After verifying the workspace, Eventstream, and KQL database IDs, use PowerShell 7:

```powershell
.\scripts\fabric\resume-eventstream.ps1 `
  -SubscriptionId '<subscription-guid>' -TenantId '<tenant-guid>' `
  -WorkspaceId '<workspace-guid>' -EventstreamId '<eventstream-guid>' `
  -KqlDatabaseId '<kql-database-item-guid>' -WhatIf
```

Remove `-WhatIf` to apply. The default `WhenLastStopped` resumes from the last
checkpoint subject to source retention. Use `-StartType Now` explicitly for a
fresh disposable-demo check; it intentionally skips previously buffered events.
The script only accepts the existing CustomEndpoint/default stream, two named
derived streams and two DirectIngestion destinations in the specified database.
It uses the eventstream-wide resume operation because this topology's only
pause/resume-capable nodes are the derived streams. It neither resets the source
nor recreates connections or changes permissions. A failure or unexpected
topology stops recovery rather than choosing an alternative destination.

`Status = Running` means the derived streams report `Running`, **not** that events
have arrived. Destination warnings are surfaced. Coordinate with other users of
the demo before generating one bounded race/session through the existing
application. Query the real table for the generated entity ID and require a
fresh ingestion timestamp plus nonzero row count; report only aggregates:

```kusto
RaceSplit
| where raceId == "<generated-race-guid>"
| summarize rows=count(), latestIngestion=max(ingestion_time()),
            latestEvent=max(timestamp)
```

Do not substitute direct Kusto ingestion, WebSocket counts, or absence of
ingestion errors for this check. Stop at any permission/credential/consent denial.
Connection strings must stay in memory and must not appear in logs or files.

Official references:

- [Get Eventstream topology](https://learn.microsoft.com/en-us/rest/api/fabric/eventstream/topology/get-eventstream-topology)
- [Resume Eventstream](https://learn.microsoft.com/en-us/rest/api/fabric/eventstream/topology/resume-eventstream)
- [Pause/resume support matrix](https://learn.microsoft.com/en-us/fabric/real-time-intelligence/event-streams/pause-resume-data-streams)

The support matrix excludes CustomEndpoint sources and Eventhouse DirectIngestion
destinations, but includes derived streams.

## Mining: source and query contracts (offline review only)

The mining extension shares the existing CustomEndpoint, Eventstream and
Eventhouse database; it does not share triathlon tables or functions. Mining
routes remain explicitly filtered by the v2 `entityType` values
`PlantTelemetry` and `PlantStateEvent`. The proposed owned-object ledger is:

| Owned object | Purpose and retention |
| --- | --- |
| `mining_TelemetryRaw`, `mining_PlantStateEvents` | Full v2 JSON and a separate `timestamp_raw` string projection; 7-day soft-delete |
| `mining_PlantCatalog`, `mining_PublishProfile` | Versioned catalog/profile inputs; no added retention policy |
| `mining_SourceContract` | Version and readiness evidence, including timestamp-shape and exclusive-writer gates |
| `mining_ValidatedTelemetry`, `mining_ValidatedState` | Typed curated rows; proposed read source for analytics; 7-day soft-delete |
| `mining_Quarantine` | Raw event, timestamp projection, disposition and reason codes; 7-day soft-delete |
| `mining_AlertTransitions`, `mining_IncidentLedger` | Separate alert-transition and approved incident sources; 30-day soft-delete |
| `mining_telemetry_json_map`, `mining_state_json_map` | Root-document JSON mappings on the two mining raw tables |
| `mining_telemetry_*`, `mining_state_*` | The two proposed Eventstream filters, derived streams and destinations |

`MiningSchema.kql`, `MiningValidation.kql` and `MiningQueries.kql` are proposed
definitions, **not an apply script**. The classifiers are read-only: they
return an `ACCEPTED`, `QUARANTINED` or `BLOCKED` disposition and do not write
either curated or quarantine tables. No update policy, raw-to-curated
materialization, or incident population is enabled. Never use a raw dynamic
table as a curated reading source.

The frozen source contract pins catalog version
`sha256:0ba278e5e28b3466381534c5a920ce28b551cb3a7ddfc68cdf4371749f2c62ce`,
profile `d01-publish-profile-v1`, and source contract
`d01-validated-source-v1`. `mining_SourceReadiness()` checks the pinned
catalog/profile counts and identities. It returns an explicit
`BLOCKED_SOURCE_CONTRACT`, `BLOCKED_RAW_TIMESTAMP_PROOF`,
`BLOCKED_WRITER_APPROVAL`, `BLOCKED_CATALOG`, or `BLOCKED_PROFILE` until each
gate is met. Timestamp proof requires evidence that raw ingestion preserved
the timestamp field's original shape; exclusive-writer approval is separate.
Neither scalar connectivity nor offline tests satisfy these gates.

Telemetry validation requires the exact v2 root key set and types, canonical
UTC millisecond timestamps, deterministic SHA-256 event ID from
`run_id:sequence`, safe integer sequence, exact D01 catalog module/equipment/
tag/unit identity, exact per-tag publish interval, finite numeric value and
quality in `good|uncertain|bad`. State validation checks its exact v2 shape,
event identity, canonical timestamp, scope and state enums. The source quality
is retained unchanged; uncertain and bad samples are both excluded from
good-only calculations but are counted separately. Same-ID/same-fingerprint
retries deduplicate; a same-ID payload conflict is surfaced and excluded,
never silently selected. Quarantine/classification is not yet materialized.

The five fixed G5 read contracts are:

| Stored function | Signature | Bound and key behavior |
| --- | --- | --- |
| `mining_PlantLatest` | `(plant_id:string, run_id:string, as_of_utc:datetime)` | Catalog-wide tag/module rows; latest seven days; quality and freshness remain explicit |
| `mining_PlantSummary` | `(plant_id:string, run_id:string, window_start_utc:datetime, window_end_utc:datetime)` | 60 seconds–24 hours; interval-integrated line feed, process water and whole-plant power; no hopper double count, OEE, grade, or line-energy allocation |
| `mining_AssetTrend` | `(plant_id:string, run_id:string, requested_module_id:string, metric_family:string, window_start_utc:datetime, window_end_utc:datetime, bin_minutes:int)` | BFF families `feed`, `density`, `vibration`, `water-energy`; 1- or 5-minute bins; at most 24 hours; explicit gaps, quality counts, late counts and overflow |
| `mining_ActiveIncidents` | `(plant_id:string, requested_run_id:string, as_of_utc:datetime)` | Requires the separately approved `d01-incident-ledger-v1`; at most 20 incidents |
| `mining_CompareLines` | `(plant_id:string, run_id:string, metric_family:string, window_start_utc:datetime, window_end_utc:datetime, bin_minutes:int)` | 1- or 5-minute bins; at most 24 hours and 1,000 rows; only `feed`, `density`, `vibration` |

Every query scopes to D01 and the requested run, returns a status column,
surfaces duplicate conflicts, and refuses invalid/future windows. `AssetTrend`
and `CompareLines` return `TOO_MANY_ROWS` instead of truncating when their
fixed 1,000-row cap is exceeded. The reader separately rejects results above
the caller's smaller `maxRows` (1–1,000). Common statuses include `OK`,
`NO_DATA`, `INVALID_REQUEST`, `INVALID_WINDOW`, `INVALID_BIN`,
`DUPLICATE_CONFLICT`, `UNKNOWN_MODULE`, `UNKNOWN_TAG`, `UNSUPPORTED_METRIC`,
`BLOCKED_CATALOG`, `TOO_MANY_ROWS`, `GAP`, `INVALID_COVERAGE`, `BAD_QUALITY`,
`UNCERTAIN_QUALITY`, `MIXED_QUALITY`, and `MIXED_NON_GOOD_QUALITY`.
`PlantLatest` also uses `UNKNOWN_NO_OBSERVATION`,
`UNKNOWN_NO_STATE`, `STALE`, `STALE_STATE`, `FAULT`, and `NOT_RUNNING`.
`PlantSummary` reports `INVALID_COVERAGE`, `STATE_COVERAGE_INCOMPLETE`,
`INSUFFICIENT_COMMON_COVERAGE`, and `FEED_BELOW_10_TPH`. Incident reads return
`BLOCKED_INCIDENT_SOURCE`, `NO_ACTIVE_INCIDENTS`, or `TOO_MANY_INCIDENTS`.
Readiness failures retain their `BLOCKED_*` status. These status rows are
explicit outcomes, not successful empty results.

`AssetTrend` accepts the Cockpit metric families, not raw catalog metric names.
Within the requested module, it selects catalog tags by the fixed mapping
`feed` → `ore_flow`, `density` → `medium_density`, `vibration` →
`vibration_rms`, and `water-energy` → `water_flow` or `power`. It returns each
selected canonical `tagId`/`seriesId` independently with that tag's catalog
unit and keeps `metric_family` equal to the requested Cockpit family. In
particular, water-flow and power series are never combined or converted into a
fabricated shared ratio; the selected module scope and each exact tag identity
remain visible to the caller.

The exact candidate result projections are below. All rows include
`status:string`; Kusto strings cannot be null, so unavailable string values are
empty strings paired with a non-success status. Nullable non-string values use
typed nulls.

| Function | Additional columns |
| --- | --- |
| `mining_PlantLatest` | `plant_id:string`, `run_id:string`, `as_of_utc:datetime`, `row_kind:string` (`tag`, `state`, `contract`), `module_id:string`, `equipment_id:string`, `scope_id:string`, `tagId:string`, `seriesId:string`, `metric:string`, `value:real`, `unit:string`, `quality:string`, `event_time:datetime`, `received_at:datetime`, `age_seconds:long`, `state:string`, `scheduled_running:bool`, `coverage:real` |
| `mining_PlantSummary` | `plant_id:string`, `run_id:string`, `window_start_utc:datetime`, `window_end_utc:datetime`, `line_a_feed_tph:real`, `line_b_feed_tph:real`, `line_c_feed_tph:real`, `plant_feed_tph:real`, `processed_tonnes:real`, `running_lines:long`, `good_sample_count:long`, `non_good_sample_count:long`, `uncertain_sample_count:long`, `bad_sample_count:long`, `late_sample_count:long`, `conflicting_event_count:long`, `gross_process_water_m3_per_t:real`, `whole_plant_energy_kwh_per_t:real`, `feed_coverage:real`, `water_coverage:real`, `power_coverage:real`, `common_coverage:real`, `first_event_time:datetime`, `last_event_time:datetime`, `first_received_at:datetime`, `last_received_at:datetime` |
| `mining_AssetTrend` | `plant_id:string`, `run_id:string`, `module_id:string`, `tagId:string`, `seriesId:string`, `metric_family:string`, `bin_start_utc:datetime`, `value:real`, `unit:string`, `good_count:long`, `non_good_count:long`, `source_qualities:dynamic` (distinct exact source categories), `uncertain_count:long`, `bad_count:long`, `late_count:long`, `expected_samples:real`, `coverage:real`, `first_event_time:datetime`, `last_event_time:datetime`, `first_received_at:datetime`, `last_received_at:datetime` |
| `mining_ActiveIncidents` | `plant_id:string`, `run_id:string`, `incident_id:string`, `rule_id:string`, `scope_id:string`, `severity:string`, `active_state:string`, `raised_at:datetime`, `last_transition_at:datetime`, `acknowledged_at:datetime`, `received_at:datetime`, `evidence:dynamic`, `conflict_count:long` |
| `mining_CompareLines` | `plant_id:string`, `run_id:string`, `line_id:string`, `module_id:string`, canonical `tag_id:string`, `metric:string`, `unit:string`, `metric_family:string`, `bin_start_utc:datetime`, `value:real`, `good_count:long`, `non_good_count:long`, `source_qualities:dynamic`, `uncertain_count:long`, `bad_count:long`, `late_count:long`, `expected_samples:real`, `coverage:real`, `conflict_count:long`, `first_event_time:datetime`, `last_event_time:datetime`, `first_received_at:datetime`, `last_received_at:datetime` |

`PlantLatest` has a tag row for each catalog tag, and a distinct state row for
each `scope_id` (`A`, `B`, `C`, `shared`); it does not duplicate line state
across physical modules. A blocked request yields a contract status row rather
than reading or fabricating data. These are source-code-projected column
contracts and remain subject to hosted KQL compilation.

The v2 event validators and all five query functions require a lowercase,
hyphenated UUID `run_id`; query windows are ordered, half-open (`[start,end)`),
not future-dated, and at most 24 hours (PlantSummary additionally requires at
least 60 seconds). Interval-ending telemetry samples are assigned to the bin
containing `timestamp - 1ms`, consistently with their represented interval;
samples exactly at `window_end_utc` are excluded.

`PlantSummary` computes common coverage from the elapsed seconds where all five
required good-quality signals and all four running scopes are present. A minute
contributes only when each signal's represented interval coverage is at least
90%; the water/feed and whole-plant-energy/feed ratios require at least 90%
common coverage and time-weighted common feed of at least 10 t/h. Invalid
over-coverage, conflicting events, startup grace, or incomplete state coverage
prevents a ratio from being reported.

PlantSummary state conflicts are not filtered before latest-state selection.
The latest timestamp for each scope/minute is determined with conflict rows
included; if a latest row conflicts, that minute is excluded from common state
coverage. Current `running_lines` likewise uses the latest state from the full
195-second context and is null when any line's latest state conflicts, rather
than falling back to an older good state. `conflicting_event_count` includes
both telemetry and state conflicts from the summary's relevant state context;
any conflict yields `DUPLICATE_CONFLICT` and prevents intensity ratios.

For `CompareLines`, source rows include `line_id`, `module_id`, canonical
`tag_id`, catalog `metric` and `unit`, `metric_family`, `bin_start_utc`,
`value`, separate `good_count`/`uncertain_count`/`bad_count`, coverage,
late-event counts and event/receive bounds. The BFF maps `tag_id` to the
client's `seriesId` and sets `moduleId:null`. Feed is exactly the three
`D01.{A,B,C}.crusher.ore_flow` tags (`t/h`); density is the three
`D01.{A,B,C}.dms.medium_density` tags (`kg/m3`); vibration is the three
`D01.{A,B,C}.crusher.vibration_rms` tags (`mm/s`). Water-energy comparisons
are explicitly unsupported: there is no per-line power allocation and no
invented shared-water series. A hosted caller must surface every non-OK
status and must not treat a control row as data.

The query file declares functions against the proposed curated/incident
schemas, but these definitions have **not** been compiled or run against a
hosted KQL database. The focused Pester checks are offline static contract and
planner-safeguard checks only; they do not prove KQL syntax, ingestion,
timestamp preservation, policy state or runtime results. No live definitions,
data, queries or permissions are changed by these scripts or checks.

### Synthetic KQL engine self-test

`fixtures/mining-engine-self-test.kql` is a query-local scalar test assembled
from the frozen `MiningValidation.kql` and `MiningQueries.kql` function bodies.
The builder pins those exact source hashes and the D01 catalog/profile code,
then rewrites every source table/function reference to a private `_selftest_`
alias. All rows come from local `datatable` bindings; the query has no stored
definition commands, endpoint references, or business-table reads. It covers
one happy-path call for each of the five G5 functions plus same-event retry
deduplication and receive-time selection. The fixture is sized to the frozen
catalog/profile contract and expects 42 t/h plant feed, 0.7 processed tonnes,
full common coverage, three running lines, one active incident, and bounded
trend/line result counts.

The local source-contract row deliberately sets timestamp/writer flags to
exercise the READY branches. This synthetic status is **not** source,
deployment, timestamp-preservation, or authorization evidence. The final row
contains only scalar booleans, counts, and aggregate values. It cannot grant
readiness or replace independent target/native-definition readback.

Rebuild or verify the pinned payload from the repository root:

```powershell
node .\scripts\fabric\build-mining-engine-self-test.mjs
node .\scripts\fabric\build-mining-engine-self-test.mjs --check
Invoke-Pester .\tests\pester\Mining-EngineSelfTest.Tests.ps1
```

The generated payload is capped at 256 KiB and its exact UTF-8 SHA-256 and
byte count are recorded in the adjacent manifest. It has **not** been run
against hosted KQL. Offline generation/tests validate source pins, locality,
payload bounds and fixture expectations only; engine compilation, actual
query results and all error branches remain unverified.

The manifest freezes the input arguments and independent expected results for
all five G5 functions. In brief: PlantLatest returns 56 catalog tags and four
states (11 observed tags, 45 unknown); PlantSummary expects 42 t/h, 0.7
processed tonnes, three running lines, full common coverage, 1/21 m3/t water
and 50/21 kWh/t energy; AssetTrend returns the A-crusher ore-flow series at
12 t/h; ActiveIncidents returns one unacknowledged warning; CompareLines
returns the A/B/C feed series at 12/14/16 t/h. These are deterministic
query-local expectations, not hosted results.

The adjacent manifest also records a **requirements-only, unissued** proof
contract. For each raw canary table, allow duplicate copies but require exactly
one distinct event ID, at least one copy, timestamp-lexeme and non-null raw
ingestion-time matches for every copy, and zero copies in the opposite table.
Classifier proof is separate: compare duplicate-preserving multisets keyed by
event ID and raw ingestion time against event ID and `received_at`; pin the
expected classifier rows independently, require all expected rows to have a
non-null `received_at` and match, and require one conflict-free deduplicated
row per event with the minimum receipt time. Do not infer expected classifier
rows from observed raw copies. A synthetic readiness string or this engine
self-test is never proof.

Kusto soft-delete periods are minimum availability periods, not guaranteed
immediate deletion. Retention commands are scoped to mining-owned tables only;
the ledger leaves triathlon objects, database recoverability, and unrelated
content unchanged.

`plan-mining-definition.ps1` compares three **local** decoded `eventstream.json`
files: an operator-approved baseline, an independently reviewed candidate, and
a freshly acquired current definition. Store these files privately: they may
contain connection details. Hash the exact baseline and candidate bytes with
`Get-FileHash -Algorithm SHA256`. The candidate must preserve the baseline and
add exactly the six named mining nodes above, routing the flattened v2
`PlantTelemetry` and `PlantStateEvent` discriminators to their respective
mining tables. The planner checks node references, both triathlon destinations,
their workspace/database IDs, approved hashes and the exact non-mining preimage. It
reports node names only; it does not generate a candidate or validate its
complete schema. An operator must review the candidate's full definition and
destination input schemas against the actual API and event contract.

```powershell
.\scripts\fabric\plan-mining-definition.ps1 `
  -SubscriptionId '<subscription-guid>' -TenantId '<tenant-guid>' `
  -WorkspaceId '<workspace-guid>' -EventstreamId '<eventstream-guid>' `
  -KqlDatabaseId '<kql-database-item-guid>' `
  -BaselinePath '<private-baseline.json>' -CurrentPath '<private-current.json>' `
  -DesiredPath '<private-reviewed-candidate.json>' `
  -BaselineSha256 '<approved-baseline-sha256>' -DesiredSha256 '<approved-candidate-sha256>'
```

`-Mode Verify` checks that the current local snapshot matches the candidate.
It is **not** hosted verification: subscription, tenant and Eventstream IDs
are supplied context only. The script does not authenticate, establish which
item produced a snapshot, verify KQL objects, or prove ingestion.
`-Mode Apply` always fails. Fabric's documented update replaces the complete
definition and does not document atomic revision matching. Before considering
an actual update, arrange an authorized serialized maintenance window, re-read
the exact target and preimage immediately before the write, review the complete
candidate and all definition parts, and retain the private preimage for
recovery. A recheck is not atomic compare-and-swap; concurrent edits remain a
risk. Confirm Eventstream schemas, KQL objects, permissions, retention and
rollback with the environment owner first. Never run this review as permission
to resume capacity or make cloud changes.

For rollback, review and remove only the six named mining nodes from a freshly
read definition, retaining every other part; do not restore a stale whole-item
snapshot over unrelated edits. Mining table/function deletion is a separate
destructive decision requiring explicit approval and a check for downstream
use; never tear down the database. The legacy resume helper deliberately
rejects this expanded topology until separately extended and tested. Actual
ingestion, proof-gate population, hosted function compilation and runtime
validation remain pending an approved verification window.

### Disposable raw-source canary approval scope

This is a proposed, unexecuted canary, not a frozen native mutation packet,
authorization, or an apply procedure. The reviewed source is pinned in the
adjacent manifest; no fresh target readback/ETag, exact current target hash,
independently protected target identity, or observed permission evidence is
included. The offline candidate/preimage files are not proof of current cloud
state. The planner authenticates nowhere, so required Eventstream and KQL
database write permissions remain untested.

Its write scope is limited to two mining raw tables (`mining_TelemetryRaw`,
`mining_PlantStateEvents`), their two root-document JSON mappings, their
7-day table-scoped retention policies, and these six Eventstream nodes:
`mining_telemetry_filter`, `mining_telemetry_stream`,
`mining_telemetry_direct_ingestion`, `mining_state_filter`,
`mining_state_stream`, and `mining_state_direct_ingestion`. The filters read
the existing `triathlon_main_stream` and route only exact
`entityType == "PlantTelemetry"` or `entityType == "PlantStateEvent"` values
to their corresponding raw table using `DirectIngestion`. Mapping names and
paths are exactly `mining_telemetry_json_map` and
`mining_state_json_map`, each mapping `event` from `$` and `timestamp_raw`
from `$.timestamp`. The other eight mining tables and all query functions are
not needed for this raw-ingestion canary; no classifier, quarantine,
materialization, update policy, incident data, or `SourceContract` readiness
write is included.

Use two synthetic messages only. The fixed sample below is for offline review;
an approved run must use a fresh run ID and current canonical UTC millisecond
timestamp strings, recomputing each event ID from `run_id:sequence` and
retaining those exact strings for the proof query. The per-table event count is
scoped to that fresh run, not to all historical rows.

```jsonl
{"entityType":"PlantTelemetry","schema_version":2,"run_id":"00000000-0000-4000-8000-000000000001","event_id":"a49cfbfc2222aac3040a8adecfe8bb3775bc5501d3782830ebeac39035d5511a","sequence":1,"interval_seconds":30,"timestamp":"2026-01-15T12:00:00.123Z","plant_id":"D01","module_id":"D01.A.crusher","equipment_id":"D01.A.crusher.feeder","tag_id":"D01.A.crusher.ore_flow","value":42.0,"unit":"t/h","quality":"good"}
{"entityType":"PlantStateEvent","schema_version":2,"run_id":"00000000-0000-4000-8000-000000000001","event_id":"322a2802a280929e5b715409a04651bc00172cceb0eb2d3fa1fe66813f106009","sequence":2,"timestamp":"2026-01-15T12:00:00.124Z","plant_id":"D01","scope_id":"A","scheduled_running":true,"state":"running"}
```

Acceptance is at least one matching raw row per event ID, exactly one distinct
canary event ID in each intended table for the fresh run, and every delivered
copy preserves the sent timestamp string in `timestamp_raw` and
`event["timestamp"]` (whose type must remain `string`) with non-null
`ingestion_time()`. The opposite mining raw table must have no copy of that
event ID. `ingestion_time()` can be null when the table's ingestion-time
policy is disabled; this packet neither reads nor changes that policy. If the
count is null, the canary fails and any policy change requires a separately
reviewed mining-table-only scope. A bounded telemetry proof query is:

```kusto
let expected_run_id = "00000000-0000-4000-8000-000000000001";
let expected_event_id = "a49cfbfc2222aac3040a8adecfe8bb3775bc5501d3782830ebeac39035d5511a";
let expected_timestamp = "2026-01-15T12:00:00.123Z";
mining_TelemetryRaw
| where tostring(event["run_id"]) == expected_run_id
| summarize observed_distinct_event_ids = dcount(tostring(event["event_id"])),
    copies = countif(tostring(event["event_id"]) == expected_event_id),
    raw_ingestion_nonnull_copies = countif(
        tostring(event["event_id"]) == expected_event_id and
        isnotnull(ingestion_time())),
    exact_lexeme_copies = countif(tostring(event["event_id"]) == expected_event_id and
        gettype(event["timestamp"]) == "string" and
        timestamp_raw == expected_timestamp and
        tostring(event["timestamp"]) == expected_timestamp)
```

Run the same check against `mining_PlantStateEvents` using its fixture ID and
timestamp, and require zero matches for each ID in the opposite raw table.
Accept only when each intended table has
`observed_distinct_event_ids == 1`, `copies >= 1`,
`exact_lexeme_copies == copies`, and
`raw_ingestion_nonnull_copies == copies`. Use aggregate-only checks; do not
return or log raw payloads. This proves only raw mapping and
`DirectIngestion` compatibility. It does not prove classifier readiness or
authorize setting `raw_timestamp_shape_verified`; exclusive-writer approval
remains a separate gate.

Canary counts are duplicate-tolerant: require exactly one distinct event ID
per intended table, at least one copy, exact timestamp-lexeme match and
non-null raw ingestion time for every copy, and zero copies in the opposite
table. Classifier propagation must be collected separately against
independently frozen expected row counts; its expected/matched rows cannot be
inferred from raw copy counts.

Before any later update, an authorized operator must compare a freshly read
Eventstream definition with the private approved preimage and the complete
reviewed candidate. Removing exactly the six mining nodes from the candidate
must leave the exact non-mining structure checked by the offline planner equal
to the approved preimage; the two triathlon destinations and their JSON
mappings remain unchanged. A private, read-only before/after inventory must
also confirm all existing triathlon table policies are unchanged. No policy
command may target a triathlon table or database-wide scope. Because definition
update is a full replacement without a documented atomic compare-and-swap, an
external owner must provide a serialized writer-free maintenance window and the
target must be re-read immediately before the write. Current Apply remains
blocked; no capacity resume, permission change, live send, or cloud write is part
of this packet.

There is no exact frozen native mutation packet ready for approval here: the
source scope and local structural checks are documented, but the current target
hash/identity and permissions are not established. The Eventstream update is a
full-definition replacement without documented atomic compare-and-swap; the
writer-free interval must be provided by the external owner and cover the
fresh preflight, update, and post-update readback. Until those target and
authorization facts are independently collected, this section remains offline
planning only.

References: [Eventstream definition](https://learn.microsoft.com/en-us/rest/api/fabric/articles/item-management/definitions/eventstream-definition),
[update definition](https://learn.microsoft.com/en-us/rest/api/fabric/eventstream/items/update-eventstream-definition),
[JSON mapping](https://learn.microsoft.com/en-us/kusto/management/json-mapping?view=microsoft-fabric),
and [retention policy](https://learn.microsoft.com/en-us/kusto/management/retention-policy?view=microsoft-fabric).
