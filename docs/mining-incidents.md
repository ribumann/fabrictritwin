# Mining incident evaluation

`apps/streaming-backend/src/mining-incidents/evaluator.ts` is a bounded advisory
state machine over curated D01 observations. `runtime.ts` adds an **unmounted,
default-off** durable processing and in-app notification/outbox foundation.
Neither is bound to an HTTP endpoint, startup hook or live Fabric source. Offline
tests do not establish live ingestion or mining acceptance. The simulator's
diagnostic alerts are separate and are not authoritative inputs.

## Input boundary

The caller must supply strictly validated, run-correlated observations and the
pinned catalog. Raw transport JSON is not accepted as proof of validation.
Map numeric `run_id`, `event_id`, `timestamp`, `tag_id`, `value`, `unit`,
`quality` and `interval_seconds` to the corresponding camel-case reading fields.
Map state `scope_id`, `scheduled_running`, `state` and `sequence` alongside
the common identity/time fields. The transport has no heartbeat boolean:
periodic state records and transitions both establish observed state freshness.
Sequence orders same-time state events; a later transition supersedes the
earlier periodic state record.

The evaluator rejects conflicting event identities or tag timestamps, unknown
tags, wrong units/cadence, nonfinite values, invalid quality/state, noncanonical
UTC times and observations later than receipt. It bounds one run to 30 minutes,
56 tags and 4,096 unique observations. `uncertain` and `bad` are valid qualities
but cannot satisfy process or good-quality recovery holds.

## Five advisory rules

Evaluate every minute relative to run start. Feed observations before each
evaluation; process holds use consecutive completed sample windows in explicitly
running state, with two-minute startup suppression.
Temperature and level snapshots start their holds at the first qualifying
observed snapshot; they do not establish the preceding interval's value.
Completed-window means/RMS can establish their reported interval. DMS OR holds
can continue across alternating density/pressure breaches only when the actual
qualifying windows cover the entire hold without a gap.

| Rule            | Raise                                                                                  | Clear                                                       |
| --------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Crusher bearing | RMS >4.5 mm/s for 2 min; high when bearing temperature >75 Cel also holds for 2 min    | RMS <3.8 and temperature <70 for 3 min                      |
| DMS condition   | Density outside 2800-3100 kg/m3 or pressure outside 200-400 kPa for 2 min              | Density 2850-3050 and pressure 230-370 for 3 min            |
| Shared water    | Tank level <25% for 2 min; one high-priority shared incident                           | Level >35% for 3 min                                        |
| Unplanned stop  | Explicit stopped/fault during scheduled running for 2 min                              | Explicit running for 2 min                                  |
| Telemetry stale | No good numeric value for 3 publish intervals +15 s, or no state observation for 195 s | Two new consecutive fresh good values or state observations |

Named crusher tags use `D01.{A|B|C}.crusher.vibration_rms` and
`bearing_temperature`; screen excitation is never a crusher-bearing input.
DMS uses the corresponding `.dms.medium_density` and `.dms.feed_pressure`.
Shared water is `D01.shared.water.level`.

Missing/overdue, stopped or bad/uncertain evidence resets process holds.
Active process incidents remain unverified rather than clearing without
sufficient good observations. Latest bad/uncertain arrivals invalidate their
process verification before the next minute evaluation. Acknowledgement is
independent of clearing and does not suppress future escalation.

Only raise/escalation/clear changes produce transitions, with stable run/rule/
scope/change/time-derived IDs. Each transition includes bounded actual numeric
and state evidence with source event identities. Staleness separately records
the last valid observation time, which can predate the three-minute evidence
window; a missing observation is never represented as a fabricated reading.

## Durable runtime contract

The host must explicitly call `MiningIncidentRuntime.open(run, "fresh" | "recover",
dependencies, cancellation?)`. `MiningIncidentRun` pins the run ID, canonical
start/end times and exact catalog (including order); its interval must be whole
minutes and no longer than 30 minutes. Construction, imports, environment flags,
status and read-only requests never activate or recover processing.

`MiningIncidentAuthority.authorize` is a **trusted delegated authorization**
boundary for fresh activation, recovery and acknowledgement, not a managed
identity permission check. `checkRun` must reject revoked approvals, accepted
stops, disconnected owners and incorrect run bindings. Both callbacks receive
cancellation. A managed identity with storage access is not permission to
activate a run. Anonymous clients must not supply these callbacks.

The injected `MiningIncidentSource.read({runId, asOf, signal})` must return only
strictly validated, curated G5 observations and their actual `receivedAt` time.
Arrival order in the returned array is preserved; receipt times cannot move
backwards. Do not fabricate healthy readings, derive authority from raw or
simulator diagnostics, or substitute publisher completion for ingestion
completion. Query/DTO agreement with the curated-source owner is an integration
prerequisite. The adapter should return newly observed arrivals, including late
arrivals, rather than repeatedly returning its whole historical lookback.
Observation commands, including repeats, have a total budget of 4,096 per run.

`processMinute(asOf)` accepts consecutive run-relative minute boundaries,
starting at minute zero, never future minutes. Repeating an already committed
minute does not requery the source or produce effects. `runScheduled()` is an
explicit, caller-awaited bounded loop through the real run end; it renews
authority during waits of at most 15 seconds and closes on completion. Each
activation has a 31-minute monotonic lifetime bound even if wall time moves
backwards; a later restart needs another explicit authorized recovery. Explicit
recovery can process missed historical minutes using actual curated arrivals,
not inferred observations. This does not reconstruct unknown pre-restart arrival
times for observations that were never committed.

Call and await `close()` on accepted stop/disconnect; it aborts reads
synchronously and releases the actual head lease. An accepted stop is not proof
that shutdown has settled. `close()` revokes authority but does not join an
outstanding operation: the host must also await its processing/loop promise
before reporting stopped. Dependencies must honor the supplied signal and settle
their I/O; no timeout races leave an unobserved background side effect. Runtime
source/authority/read budgets signal cancellation after 10 seconds, while the
existing Blob store bounds transport attempts independently. Wire the
reader-owned optional `MiningStore.read(path, signal?)` Blob download/body
cancellation contract before live activation. No storage/coordinator lease
semantics are modified here.

## Journal and fencing

All paths are relative to the already-selected dedicated private mining-state
container; there is no alternate account/container or provisioning path:

```text
incidents/D01/<sha256(JSON runId)>/head.json
incidents/D01/<sha256(JSON runId)>/<sha256(JSON page)>.json
```

Schema 1 head is `{schema, binding, tail, pages, bytes}`. The binding is SHA-256
of the exact serialized approved run/catalog. Immutable pages are
`{schema, binding, previous, commands}`. Commands are observations with receipt
time, evaluations, or acknowledgements, in their actual processing order.
The version covers evaluator replay semantics too: incompatible evaluator
changes require a new version/migration, not silent replay under new rules.

The existing Blob reader limits a document to **16,384 bytes**. Every page is
sized before storage; the compact head never contains an evaluator snapshot,
catalog copy, transition collection or unbounded pointer list. The committed
chain is limited to 512 pages / 2 MiB / 4,383 commands (4,096 observations,
31 evaluations, 256 acknowledgements). Replay reconstructs hold floors, history,
verification, active/cleared incidents, stable transitions and acknowledgements.
There is no second serialized copy of the evaluator state.

Only a head write using **both its own lease ID and ETag** commits staged pages.
The lease is acquired explicitly and renewed before reads/commits; ETags or
local mutual exclusion alone are not authority. Losing authority, cancellation
or invalid input makes that runtime unusable. Missing/corrupt pages, incompatible
schema, byte/count mismatch and conflicting catalog/run bindings fail explicitly;
they never reset incidents to empty or healthy.

A lost head-write response or cancellation during its response is **unconfirmed**,
not success or an instruction to retry. Explicit authorized recovery reconciles
the committed head. A commit that reached storage before cancellation can be
present on recovery; no local notification is published after cancellation.
Late writes after lease release fail their actual Blob lease condition. Staged
immutable pages have no effects until referenced by the committed head. A failed
attempt can leave orphan pages; there is no automatic garbage collection or
deletion of unrelated state. Retention/cleanup requires a separately approved
operator policy.

## In-app notification and read integration

`snapshot()` returns `{runId, asOf, incidents}` from committed local state.
`outbox(afterId?, limit?)` returns deterministic transition notifications with
their stable `eventId` identities, at most 100 per page. `afterId` is the last
seen transition event ID. This is **availability for in-app reading**, never a
claim of delivery. The journal and deterministic replay make these entries
durable without another external-write transaction.

`acknowledge(incidentId, at)` is separately authorized and durable. The first
acknowledgement wins; repeating it does not write or send again, including after
restart. Acknowledgement does not clear an incident, consume/delete outbox
entries or suppress a later escalation/clear transition. There are no periodic
reminders, cooldown-triggered sends, delivery receipts or external Teams/email
services. A future reminder/delivery adapter needs its own approved durable
cooldown and unknown-delivery policy; do not treat acknowledgement as delivery.

`readMiningIncidentJournal(store, run, {signal?, afterId?, limit?})` is the
reader-owned route integration hook. It reads a single head and immutable chain,
returning `{runId, asOf, incidents, notifications}` without acquiring a lease,
recovering a runtime, querying Fabric or writing. Missing persistence returns
`undefined`; `asOf: null` means no minute has been processed, not healthy
ingestion. Corruption throws. The route still needs its own curated G5
readiness/approval gate and must not present journal availability as ingestion
proof. No HTTP routes or live dependencies are mounted by this item.

Live acceptance still requires approved storage configuration, delegated
activation/acknowledgement, curator-bound source validation, host lifecycle
integration, and hosted restart/fence/stop demonstrations. These are
demonstration advisories, never protective controls or maintenance authorization.
