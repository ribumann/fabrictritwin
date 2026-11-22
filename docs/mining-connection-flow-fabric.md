# D01 connection flow: Fabric-owned v1 integration

This is an additive KQL implementation for the separate
`ConnectionMeasurement` v1 event family. It uses the simulator's
`d01-shared-flow-v1` profile (`D01_CONNECTION_PROFILE_VERSION`), five-second
sample interval, pinned D01 plant catalog, and
`d01-connection-measurements-v1` binding set. The 57 bindings
describe synthetic sensor observations at authored **module ports**; the
catalog does not provide equipment-owned ports, so the bindings do not infer
equipment endpoints. Their nullable equipment identifiers are stored as empty
strings in the Kusto string columns and the v1 JSON events must carry `null`.
Effluent/fines and thickener underflow have separate dry
solids and water components. Ferrosilicon medium remains distinct from ore.
Nominal capacities are visualization scales, not operating limits.

The new tables, bindings, functions, and update policies have been staged in
the mining Eventhouse. Existing legacy mining tables, functions, and policies
are unchanged. Earlier query-local probes used synthetic datatables and did
not verify actual ingestion.

An isolated Eventstream definition lives at
`infra/fabric/mining-connection-flow/eventstream.json`. It separates
`ConnectionMeasurement` and `ConnectionRunProfile` events into the new raw
measurement and run-profile tables. A separate instance has been created for
canary validation; the existing Eventstream is not modified.
The profile mapping stores the sender's `requested_at` in `pinned_at`; actual
pin receipt is established separately using the table's ingestion time. The
sender sends a pin only once and checks a bounded, exact readback before flow
publishing. The draft host enables this handler only when
`MINING_CONNECTION_PIN_EVENTSTREAM_ENABLED=true`; it is off by default and has
not been deployed to the backend. An isolated real-clock canary verified pin
receipt, timestamp preservation, and arrival through the separate Eventstream:
all 2,109 expected raw and validated observations matched at one cutoff, with
no quarantined observations. The maximum measured raw receipt lag was 37.17
seconds; this is an observation, not a latency bound. A subsequent regional
combined-publisher canary reconciled all 2,736 flow observations and matched
the isolated legacy raw events; it did not exercise legacy validation.

The hosted probes exercised the run-relative 5-second cadence at a
non-wall-aligned start (`...41.826Z`), dynamic UUID/null typing, and the bounded
latest/trend response logic. They confirmed a valid run-relative sample passes
while a wall-clock-aligned but run-relative-invalid sample does not; latest
returns numeric zero, missing, and conflict states; and anchored 30-second and
60-second trend bins retain the full six- and twelve-sample denominators for
partial bins (probed at 5/6 and 11/12 samples), and return null for missing or
conflict-only values. The right-closed window behavior was corrected and
subsequently checked against live canary data. These
synthetic probes validate Kusto query behavior, not deployed functions,
ingestion/update-policy execution, live table contents, materialization delay,
or production workload.

The complete current classifier, `mining_ConnectionUniqueTicksV1`,
`MiningConnectionLatestV1`, and `MiningConnectionTrendV1` bodies were also
compiled and invoked as query-local `let` functions with typed empty datatables
standing in for their external tables. All compiled successfully. The
classifier returned its 32-column schema; Latest and Trend returned their
documented 19- and 27-column schemas with `INVALID_REQUEST` status rows because
the binding and run-pin datatables were empty. This verifies full-body Kusto
parsing and result schemas, not successful classification against ingested
rows. Subsequent isolated live tests verified persisted `ingestion_time()` and
update-policy execution.

The expected-set function, run-level reconciliation, and classifier were also
compiled query-locally with synthetic pin receipt columns standing in for
`ingestion_time()`. Probes covered a pin receipt before and after the cutoff,
duplicate pre-cutoff pins, a post-cutoff duplicate, and unavailable receipt
time. The reconciliation functions ignored post-cutoff pins, rejected
pre-cutoff duplicates as ambiguous, and returned
`RUN_PIN_RECEIPT_TIME_UNAVAILABLE` for null receipt time. The classifier
accepted a pin received before an event and quarantined pins received at or
after it; current duplicate pins failed closed. These probes validate query
logic only. The run-profile ingestion-time policy was subsequently applied
and verified in the staged Eventhouse.

## Files and apply order

Review/apply these new files to the already-existing mining Eventhouse database
in order:

1. `infra/fabric/eventhouse/MiningConnectionSchema.kql` — new raw, profile,
   binding, run-pinning, run-completion, validated, and quarantine tables;
   one JSON mapping; table-scoped policies on new objects only.
2. `infra/fabric/eventhouse/MiningConnectionBindings.kql` — seed the one v1
   profile and 57 bindings, deriving endpoints only from the already-loaded
   pinned `mining_PlantCatalog` stream records. Inspect its final count result.
3. Before publishing, insert exactly one immutable
   `mining_ConnectionRunProfile` row per run, with `plant_id`, `run_id`, all
   three pinned versions, the simulator's exact `started_at` timestamp, and
   `pinned_at`. The run ID must be the canonical lowercase UUID used by the
   event contract. Cadence is measured from `started_at`, not wall-clock or
   epoch boundaries. The schema enables Kusto ingestion-time capture on this
   table; temporal authorization uses that persisted receipt time, not the
   externally supplied `pinned_at` value.
4. `infra/fabric/eventhouse/MiningConnectionValidation.kql` — install the
   read-only classifier.
5. `infra/fabric/eventhouse/MiningConnectionMaterialization.kql` — attach
   nontransactional, queued update policies that populate only the new
   validated/quarantine tables.
6. `infra/fabric/eventhouse/MiningConnectionQueries.kql` and
   `MiningConnectionRunIngestion.kql` — install bounded read and reconciliation
   functions.

The separate marker-based `MiningConnectionRunIngestionV1` function requires
an externally verified final-ingress cutoff and an immutable
`mining_ConnectionRunCompletion` row. The public integration does not write
that marker or use it to claim completion; it uses the private, cutoff-specific
expected-set snapshot described below.

The run-profile table's ingestion-time policy is required for cutoff proof.
If an existing profile row has no available Kusto `ingestion_time()` (for
example, it predates enabling the policy), reconciliation fails closed with
`RUN_PIN_RECEIPT_TIME_UNAVAILABLE`; do not treat `pinned_at` as a substitute.
The writer-controlled `pinned_at` field may describe send time and is retained
as metadata, not trusted as evidence that the row was persisted by a cutoff.

The raw mapping retains `sample_time_raw` separately from the dynamic event.
Kusto can normalize date-time values during JSON ingestion. Verify the exact
source-time lexeme with a hosted ingestion probe before relying on the
canonical-UTC string check; a mismatch is quarantined rather than silently
accepted. The dynamic raw event is retained alongside it.

## Update-policy and latency constraints

`mining_ClassifyConnectionMeasurementV1()` joins raw events with binding,
profile, and per-run pin tables. It accepts `run_id` materialized as either a
string or GUID, while still requiring canonical lowercase UUID text after
conversion. Each `sample_time` must be strictly after the pinned run start and
exactly an integer multiple of 5,000 milliseconds from that start; a valid
run may start at a non-wall-aligned instant such as `...41.826Z`.
The classifier also requires the run-profile row's persisted
`ingestion_time()` to be strictly earlier than the raw event's `received_at`;
missing profile receipt time or a pin received at/after the event cannot
authorize that event. A later single pin therefore cannot retroactively
authorize earlier raw events. The classifier currently summarizes all
currently visible run-profile rows by run ID, so any duplicate pin rows make
the run ambiguous and fail closed—even if a duplicate arrived after a
historical event. It does not reconstruct a per-event historical pin snapshot;
the expected-set and run reconciliation functions independently apply their
requested cutoff to profile-row receipt time. The declared `pinned_at` field
is not used as persisted-receipt proof.

Fabric permits update-policy queries with
`join` only when streaming ingestion is disabled for all upstream tables in
that join chain. The new schema file disables it on these new tables. Do not
enable streaming ingestion on them as a shortcut. Raw ingestion is queued;
update policies are nontransactional so transformation failures do not roll
back the source append. A target can lag or fail while raw remains available
for diagnosis/replay. No fixed latency or “immediate” materialization is
promised.

Update policies append per-ingestion results; they do not enforce a global
unique key or safely retract an earlier row when a later conflicting copy
arrives. The read functions therefore deduplicate by immutable `(run_id,
event_id)` and payload fingerprint at query time:

- identical repeated copies collapse to one observation and increment
  `DuplicateCount`;
- the same event ID with distinct payload fingerprints is marked conflict and
  its value is nulled, including copies found at another sample time or stream
  elsewhere in the same run and receipt cutoff; raw copies not accepted into
  validated data are also considered so a quarantined or blocked conflict
  cannot make an accepted copy appear good;
- distinct event IDs claiming the same tag/tick are also a tick conflict;
- conflict detection is bounded to the requested run and receipt cutoff. Event
  identity is checked across the run, not just the requested sample-time slice;
  this is not a global exactly-once guarantee.

Structurally invalid, unsupported-version, unpinned-run, and mismatched-binding
events go to `mining_ConnectionQuarantine`. A missing/ambiguous connection
profile yields `BLOCKED` in the classifier and remains only in raw until the
profile is corrected and raw is replayed. A profile row or run pin must not be
mutated to reinterpret historical observations.

## Public KQL contract

Use the exact signatures below. `streamIds` is a dynamic array of stream IDs;
an empty array means all bound streams. A non-empty array with an unknown ID is
invalid. Every request is scoped to the pinned D01 versions shown here.

```kusto
MiningConnectionLatestV1(
  runId:string, catalogVersion:string, measurementCatalogVersion:string,
  profileVersion:string, streamIds:dynamic, asOf:datetime,
  lookback:timespan, maxRows:long)
```

`lookback` is 5 seconds to 1 day. `maxRows` is 1–57. A successful response has
one row per selected binding, including a `MISSING` row for a binding with no
sample inside the requested lookback. If `maxRows` is too small, the function
returns a single `TRUNCATED` status row, not a partial success-shaped list.
`IsStale` is true when the latest in-lookback sample is over 15 seconds old.
The Cockpit may show good stale samples up to 120 seconds old as **delayed**,
with their sample times; it never labels them current. Older, missing, bad,
or conflicting samples are unavailable.
`ReceiptTime` is the first Eventhouse `ingestion_time()` observed for the
deduplicated sample. Both sample time and raw receipt time are bounded by the
common `asOf` cutoff, so a later-arriving historical sample cannot change that
cutoff's result. `Value` is nulled only for a conflicting tick; bad and
uncertain values remain visible with their quality/status.

| Column                      | Kusto type |
| --------------------------- | ---------- |
| `Status`                    | `string`   |
| `RunId`                     | `string`   |
| `CatalogVersion`            | `string`   |
| `MeasurementCatalogVersion` | `string`   |
| `ProfileVersion`            | `string`   |
| `StreamId`                  | `string`   |
| `MeasurementTagId`          | `string`   |
| `Quantity`                  | `string`   |
| `Basis`                     | `string`   |
| `Unit`                      | `string`   |
| `Value`                     | `real`     |
| `Quality`                   | `string`   |
| `SampleTime`                | `datetime` |
| `ReceiptTime`               | `datetime` |
| `EventId`                   | `string`   |
| `Sequence`                  | `long`     |
| `IsStale`                   | `bool`     |
| `DuplicateCount`            | `long`     |
| `ConflictCount`             | `long`     |

```kusto
MiningConnectionTrendV1(
  runId:string, catalogVersion:string, measurementCatalogVersion:string,
  profileVersion:string, streamIds:dynamic, fromTime:datetime, toTime:datetime,
  windowSize:timespan, maxRows:long)
```

`windowSize` is exactly `30s` or `60s`; the supported time range is at most one
day; `maxRows` is 1–5000. Windows are right-closed buckets
`(WindowStart, WindowEnd]` anchored to the pinned run start, not epoch or
wall-clock boundaries. Thus a run starting at `...41.826Z` has boundaries at
that instant plus exact 30- or 60-second multiples. Requested samples are
restricted to the inclusive interval `[fromTime,toTime]`, and `fromTime` must
be at or after the pinned run start. The returned bins are every aligned
`WindowStart` from the first bucket intersecting the requested interval
through the bucket containing `toTime`, inclusive:

```text
WindowStart(tick) = started_at + floor((tick - started_at - 1ms) / windowSize) * windowSize
```

The first scheduled tick is five seconds after the run start. A tick exactly
on a boundary belongs to the window ending there, so the first 30-second
window can contain all six scheduled ticks. A `fromTime` exactly on a later
boundary includes the preceding bucket because the boundary tick is included
in the request. A partially requested bucket remains partial. If the selected binding × aligned-window count
exceeds `maxRows`, the function
returns one `TRUNCATED` status row. Split the stream/time request rather than
assuming paging or silently consuming a truncated response.

`SampleCount` counts distinct, non-conflicting `good` ticks used in `Value`,
which is their arithmetic mean (not a time-weighted average). `ExpectedSampleCount`
is always the full-bin count—6 for 30 seconds and 12 for 60 seconds—even for
partial first/last bins or a request covering only part of a bin. It is not
scaled to the requested overlap. `Coverage` is
`SampleCount / ExpectedSampleCount`, so partial bins use that same full-bin
denominator. Bad/uncertain ticks are not averaged. `Value` is null when a
window has no qualifying good tick, including missing, unusable, and
conflict-only windows.
Missing ticks are never filled with zero. `WindowClosed` is evaluated against
the caller's common `toTime`, which also bounds raw receipt time. `IsComplete`
is true only for a closed window
with the expected number of good ticks, no bad/uncertain samples, and no
conflict.

| Column                      | Kusto type |
| --------------------------- | ---------- |
| `Status`                    | `string`   |
| `RunId`                     | `string`   |
| `CatalogVersion`            | `string`   |
| `MeasurementCatalogVersion` | `string`   |
| `ProfileVersion`            | `string`   |
| `StreamId`                  | `string`   |
| `MeasurementTagId`          | `string`   |
| `Quantity`                  | `string`   |
| `Basis`                     | `string`   |
| `Unit`                      | `string`   |
| `WindowStart`               | `datetime` |
| `WindowEnd`                 | `datetime` |
| `WindowClosed`              | `bool`     |
| `Value`                     | `real`     |
| `SampleCount`               | `long`     |
| `ExpectedSampleCount`       | `long`     |
| `ObservedTickCount`         | `long`     |
| `BadSampleCount`            | `long`     |
| `UncertainSampleCount`      | `long`     |
| `Coverage`                  | `real`     |
| `DuplicateCount`            | `long`     |
| `ConflictCount`             | `long`     |
| `Quality`                   | `string`   |
| `WindowState`               | `string`   |
| `IsComplete`                | `bool`     |
| `LastSampleTime`            | `datetime` |
| `LastReceiptTime`           | `datetime` |

`WindowState` values: `COMPLETE`, `PARTIAL`, `MISSING` (closed with no tick),
`UNUSABLE` (ticks exist but none are good and usable), `CONFLICT`, and
`OPEN_WINDOW` (the cutoff precedes the aligned end). `Quality` values include
`good`, `partial`, `missing`, `bad`, `uncertain`, and `conflict`. Client
comparisons across streams must pass the same `toTime`; separate latest calls
do not establish simultaneity.

`MiningConnectionRunReconciliationV1(runId:string, asOf:datetime)` is a
one-row diagnostic. It compares accepted raw `(event_id,payload_fingerprint)`
identities received by `asOf` with validated identities materialized by `asOf`,
checks raw event-ID conflicts across the run (including accepted/quarantined
cross-time or cross-stream copies), and reports duplicates,
conflicts, quarantine, blocked classifications, and missing/unexpected
validated identities. `RECONCILED` means only that these two observed sets
match at that cutoff after the completion marker. It does **not** prove that
the simulator emitted every scheduled tick, that every event reached raw, or
that a complete plant batch arrived. `NOT_COMPLETED_AT_CUTOFF`,
`BLOCKED_RAW_CLASSIFICATION`, `CONFLICTS`, and `INCOMPLETE` are not success.
Re-run after queued materialization settles; no latency bound is asserted.
Its run-pin uniqueness/version check also uses only rows whose actual Kusto
`ingestion_time()` is at or before `asOf`; a row with unavailable receipt time
returns `RUN_PIN_RECEIPT_TIME_UNAVAILABLE`.

`MiningConnectionExpectedSetReconciliationV1(runId:string,
catalogVersion:string, measurementCatalogVersion:string, profileVersion:string,
asOf:datetime, expectedEventIds:dynamic)` is an additive, default-off
per-ID canary diagnostic. It accepts only the supported D01 version tuple, a
uniquely pinned run, and a dynamic array of 1–200 unique lowercase 64-character
hex SHA-256 event IDs. Duplicate, malformed, non-string, empty, unsupported,
or otherwise invalid requests return one `INVALID_REQUEST` row with an empty
`ExpectedEventId`; a list larger than 200 returns one `TRUNCATED` row and is
never partially evaluated. Only run-pin rows with Kusto
`ingestion_time() <= asOf` participate in uniqueness and version matching.
Missing or ambiguous as-of pins return `RUN_PIN_MISSING_OR_AMBIGUOUS`; if a
candidate pin's persisted receipt time is unavailable, the function instead
returns `RUN_PIN_RECEIPT_TIME_UNAVAILABLE` rather than inferring visibility
from `pinned_at`.

For a valid request, the function returns one row per explicitly supplied ID.
Raw evidence is bounded by the ID, run, and `received_at <= asOf`; it includes
copies with other plant/version scope so those are visible as out-of-scope
evidence. Validated copies must match the pinned plant/run/version scope and
both `received_at <= asOf` and `ingestion_time() <= asOf`. Thus a raw row
received by the cutoff whose validated materialization arrives later appears
as `RAW_ONLY` at that cutoff. This diagnostic is not a paging or full-run
enumeration API.

| Column                                      | Kusto type |
| ------------------------------------------- | ---------- |
| `Status`                                    | `string`   |
| `RunId`                                     | `string`   |
| `CatalogVersion`                            | `string`   |
| `MeasurementCatalogVersion`                 | `string`   |
| `ProfileVersion`                            | `string`   |
| `AsOf`                                      | `datetime` |
| `EvidenceScope`                             | `string`   |
| `ExpectedEventId`                           | `string`   |
| `RawCopyCount`                              | `long`     |
| `RawInScopeCopyCount`                       | `long`     |
| `RawOutOfScopeCopyCount`                    | `long`     |
| `RawAcceptedCopyCount`                      | `long`     |
| `RawQuarantinedCopyCount`                   | `long`     |
| `RawBlockedCopyCount`                       | `long`     |
| `RawDuplicateCopyCount`                     | `long`     |
| `RawDistinctPayloadCountCappedAt2`          | `long`     |
| `RawAcceptedDistinctPayloadCountCappedAt2`  | `long`     |
| `RawConflict`                               | `bool`     |
| `ValidatedCopyCount`                        | `long`     |
| `ValidatedDuplicateCopyCount`               | `long`     |
| `ValidatedDistinctPayloadCountCappedAt2`    | `long`     |
| `MaterializedDistinctPayloadCountCappedAt2` | `long`     |
| `ValidatedConflict`                         | `bool`     |
| `RawValidatedPayloadMatch`                  | `bool`     |
| `PayloadMismatch`                           | `bool`     |
| `Conflict`                                  | `bool`     |
| `RawAcceptedEvent`                          | `dynamic`  |
| `RawAcceptedSampleTime`                     | `string`   |
| `ValidatedEvent`                            | `dynamic`  |

The `*CountCappedAt2` columns are cardinality indicators: `0` means no
fingerprint, `1` means exactly one, and `2` means two or more. They are
deliberately capped and must not be presented as exact counts above two.
`RawValidatedPayloadMatch` is null unless both accepted raw and validated
evidence each have exactly one distinct fingerprint. Statuses distinguish
`MISSING_FROM_RAW_AND_VALIDATED`, `RAW_ONLY`, `VALIDATED_WITHOUT_RAW`,
`VALIDATED_WITHOUT_ACCEPTED_RAW`, `RAW_NOT_ACCEPTED`, `RAW_OUT_OF_SCOPE`,
`OBSERVED_MATCH`, `DUPLICATE_MATCH`, `RAW_CONFLICT`, `VALIDATED_CONFLICT`,
and `RAW_VALIDATED_MISMATCH`. `EvidenceScope` is
`explicit_expected_ids_only`.

An `OBSERVED_MATCH` (or `DUPLICATE_MATCH`) says only that the supplied ID was
observed and its eligible payload evidence matched at this cutoff. This
function does **not** prove the simulator emitted every expected event, that
the caller supplied the complete expected set, that every event reached raw,
or that the run was complete. A missing ID therefore means “not observed in
these bounded sources by this cutoff,” not proof of non-emission. The existing
`MiningConnectionRunReconciliationV1` remains the separate run-level diagnostic.
For a completed normal shared-flow run, the backend worker independently
generates the scheduled observations in batches of at most 200 and compares
their payloads against raw and validated evidence. It checks run authority
throughout and compares total run-associated row counts at the same cutoff,
including missing receipt times. It stores a private immutable snapshot only
when the evidence is complete. To tolerate small clock differences between the
backend and Fabric, its cutoffs are five seconds behind the backend clock;
the latest-flow read uses the same margin and waits until its cutoff reaches
the run's start. The worker waits until its cutoff reaches the run's end. Later overview reads
recheck row counts and report a changed snapshot if counts differ. Equal counts cannot detect all
possible replacements or deletions; the result remains specific to its original
cutoff. No Fabric completion marker is written.

Transient query and storage failures are retried at most twice, within the
same eight-minute worker deadline. Each attempt rechecks the approved run and
its original contract; cancellation or a changed run stops reconciliation.
Without a snapshot, overview reports verification as pending for up to eight
minutes after the scheduled end, then unknown. Unknown does not prove that
ingestion failed: reconciliation may have failed, timed out, or started late.
After retries are exhausted, a service restart can recover the current run.

The backend query and worker reconciled a 2,109-observation live canary using
the signed-in operator and an in-memory authority/store. A separate regional
Container Apps job subsequently exercised the actual publisher, managed
identity, prefixed Blob store and reconciliation worker. Its 240-second run
reconciled all 2,736 expected observations in both raw and validated tables.
Its isolated legacy raw destinations also matched all 380 publisher events;
that check did not cover legacy validation. A later operator-credential reread
of the same flow run took 24.5 seconds for 14 evidence pages from a remote
host. An isolated ten-minute public-router canary subsequently returned 57
usable live bindings and a sampled trend, and reconciled all 6,840 expected
flow observations in both raw and validated tables. It used test HTTP claims
and isolated legacy raw destinations, not production authentication or legacy
validation. These observations do not establish maximum-duration performance,
deployed application behavior or a latency guarantee.

## Scoped rollout and rollback

1. Snapshot the new object names and inspect the target Eventhouse/database.
   Verify the existing `mining_PlantCatalog` stream records match the pinned
   catalog before seeding. Use an explicitly selected target and operator
   permissions; these draft files do not themselves perform cloud writes.
2. Apply only the new schema, mappings, profile/bindings, classifier, and
   update-policy files in the order above. Verify `57` unique binding tags,
   one supported profile row, all expected stream components, and a small
   synthetic raw-to-validated/quarantine probe.
3. Keep the new simulator publisher disabled until the profile, bindings,
   raw timestamp shape, run pinning, and the query contracts have been
   reviewed. Start with a synthetic canary. Do not use these values as
   calibrated or live plant observations.
4. To roll back, first stop/disable the new publisher and remove only the two
   update-policy entries targeting
   `mining_ValidatedConnectionMeasurement` and `mining_ConnectionQuarantine`
   after inspecting their complete current policy JSON. Preserve raw,
   validated, quarantine, binding, and run evidence. Revert the new reader
   routing at the consuming layer in a separately reviewed change. Do not drop
   tables, delete historical rows, or alter the legacy mining policies as part
   of rollback.
5. Any later cleanup of these new objects is a separate, explicitly approved
   operation with a reviewed backup/retention plan. New raw/validated/
   quarantine and per-run pin/completion tables explicitly use the existing
   seven-day telemetry horizon. Static profile/binding metadata explicitly
   uses 36,500-day retention so the live database's seven-day default cannot
   silently erase it. This does not establish a capacity estimate or alter
   legacy retention.

The offline tests under `tests/fabric/` are static contract/reference checks,
not a Kusto parser or hosted Fabric test. Validate command syntax, update
policy behavior, ingestion timestamp preservation, end-to-end delay, output
types, and load at the selected Eventhouse before production/canary use.
Physical plant observations remain synthetic; this change does not establish
full-flow coverage or acceptance of any physical balance criterion.
