# D01 publisher runtime (default off)

`MiningPublisherRuntime` is a callable trusted-backend sender, **not an HTTP
endpoint or deployment**. It integrates the merged deterministic
simulator and Blob lease coordinator. Existing triathlon APIs, generators,
jobs, root simulator exports and `DEMO_PROFILE` behavior are unchanged.
The optional app-lifetime continuous worker calls it only when explicitly enabled.

## Continuous throughput slice

Continuous activation remains **off by default**. The backend entrypoint
constructs the worker only outside synthetic mode, and starts it only after the
HTTP server listens. Configure `MINING_CONTINUOUS_ENABLED=true`, an explicit
`MINING_CONTINUOUS_GENERATION`, and the existing publisher/coordination/managed
identity/Eventstream secret settings to activate it after operator review.
The existing Eventstream secret reference is reused; do not copy credentials.
Set `MINING_CONTINUOUS_READ_ENABLED=true` independently to enable compatible
public throughput reads. Existing public service principal/read gates still
apply. No infrastructure, permissions or capacity state is changed by this code.

Each replica observes the same private D01 state. Only a fresh leased admission
launches a sender; an observation cannot adopt one. One UUID is retained while
healthy. Failures close/drain actual I/O before a local replacement, with
30/60/120/240/300-second bounded failure backoff. Idle/held/other-owner checks
are every 30 seconds. A crash or expired owner permits a **new UUID and physical
model restart**, not replay or seamless recovery. Durable request/history blobs
grow per attempted run, not per event/batch; repeated failures therefore still
need operational retention/monitoring. A generation hold blocks admission even
when no run exists, and is rechecked under the lease and at every batch gate.

The simulator advances at real five-second deadlines and holds at most one
30-second batch. Continuous mode has no duration or synthetic terminal states.
To keep the existing lab sample's strict 0..1000g envelope valid beyond the
finite horizon, only continuous mode collects/replaces that sample after each
30-minute cycle. Existing finite deterministic outputs are unchanged. Other
inventories retain their existing bounded model/clamps; long-horizon realism
is not proven by a two-hour local test. No raw schema/catalog identity changes.

### Rolling evidence and supported UI

The fixed inline `continuous-throughput` query reuses existing
`mining_DeduplicatedTelemetry` and `mining_SourceReadiness`, scanning at most ten
minutes independent of run age. It does not alter a deployed KQL function.
Only the selected plant/run and pinned validated-source/catalog/profile are
read. The three critical tags are `D01.{A,B,C}.crusher.ore_flow`.

The common cutoff is the oldest of their latest observed measurements. The
five-minute trailing arithmetic mean per line uses `(cutoff-5m, cutoff]`, then
sums the three means as throughput. Each 30-second tag requires at least 9/10
distinct, usable observations; a full five-minute post-start window must exist.
Any observed bad/conflicting window sample fails closed even when 9/10 other
samples are usable; the 90% allowance tolerates absent observations, not bad
ones. Usable coverage and observation coverage are reported separately.
Latest/aligned bad, conflicting or missing evidence makes the KPI unavailable.
All age checks use **request UTC**, never the older cutoff: latest and aligned
samples must be no older than 105 seconds. Measurement, validated receipt,
watermark/lag, actual tag value/event ID, sample count and coverage are explicit.
The service reconfirms current accepted UUID/generation/running authority and
stop intent after the query; a changed/held/stopped run withdraws the result.
Query success is not whole-stream ingestion completion or a verified heartbeat.

The same fixed query adds an all-or-nothing detail bundle: one scaffold row per
catalog tag (56 total, including the existing three feed rows) and one latest
simulator-state row for each of lines A/B/C, for 59 rows overall. The 53
non-feed readings carry their direct latest value, quality, measurement and
receipt timestamps, age at request UTC, and event identity. Latest samples are
selected by timestamp and sequence; unresolved ties or conflicts never expose
an arbitrary payload. Direct tag freshness is `3 * cadence + 15 seconds`:
105 seconds for 30-second tags and 195 seconds for 60-second tags. The UI accepts
older throughput-only responses, but rejects an incomplete or mismatched detail
bundle.

Line state is simulator-reported evidence, not physical equipment health or a
simultaneous snapshot. The running-lines count is available only when all three
line-state observations are valid and no older than 195 seconds; it counts only
explicit `running` states with `scheduled_running=true`. No module operating
state is inferred from a line schedule or direct sensor value. The UI shows
direct tag readings and line evidence. Subsequent releases add cross-run sensor
trends, covered water/energy summaries, retrospective rolling
[advisories](mining-incidents.md) and a bounded [assistant](mining-assistant.md).
These do not establish durable active-incident history or a native live ontology
binding. Unsupported or insufficiently covered results remain unavailable, not
healthy empty.
Public starts/cancellation are disabled even while the worker is waiting or
held. Bounded/replay behavior remains unchanged when continuous read/worker
mode is disabled.

This is a code-only additive read/UI change: rollback may restore the earlier
throughput-only backend/cockpit images without changing any source function,
table, raw envelope, catalog or publisher control. Disable the existing
continuous-read flag only if intentionally withdrawing the entire continuous
read surface; it is not a detail-only switch. Live source advancement, the
remote sustained public observer and deployed drawer acceptance remain separate
release gates, not conclusions from local tests.

The verified live source is shared workspace **triatwin-dev-fabric**, Eventstream
**mining-d01-eventstream**, Eventhouse **mining-d01-eventhouse**, query database
**mining-d01-realtime**. The UI displays the configured query database and shared
workspace. The dedicated **mining-d01-native-agent-demo** workspace contains
static Lakehouse/topology/Data Agent artifacts, not this stream. Native static
ontology instances exist (24 Modules, 56 Tags); matching IDs are not proof of
a native live/time-series binding. `incident_source_ready=false` remains an
unsupported capability; this slice neither calls incident completion nor
constructs an unbounded expected-event manifest.

### Remote public-flow observer

Use `.github/workflows/mining-continuous-flow-observer.yml` from `main` and
dispatch it manually with the current run UUID, exact generation identifier,
and a 15- or 35-minute duration. The inputs have no baked-in run/generation
defaults; this observer never starts or stops a publisher. It issues only
credentialless GETs to the fixed public Cockpit origin:
`/api/mining/context` and
`/api/mining/overview?plantId=D01&runId=<run-id>`. Cockpit must route these
through both `MINING_PUBLIC_DEMO_ENABLED` and
`MINING_PUBLIC_DEMO_READ_ENABLED`; the backend continuous read gate must also
be enabled. The observer verifies the returned continuous mode, shared source,
catalog, run, generation and live authority, so a misrouted legacy reader fails
closed rather than counting as evidence. Incidents/trends capability checks use
the context contract, not the overview DTO's legacy capability flags.

If publishing is running but receipts have stopped, check the exact Eventstream
derived routes before changing transport, secrets or permissions. Source and
destination nodes can remain Running while both derived routes are Paused.
Follow the guarded [routing recovery and live acceptance procedure](../scripts/fabric/README.md#mining-recovery-on-an-already-active-capacity);
the observer never resumes routes, and resumed routes alone do not prove fresh
ingestion.

The remote runner samples at about 30-second cadence and fails on a gap over
60 seconds, stale request UTC/watermark, invalid five-minute rolling window,
source/readiness or scope mismatch, owner churn/stop, or insufficient per-tag
measurement, receipt and event-ID advancement. Each of the three critical
tags must advance; constant numeric values are valid when that evidence
progresses. Backwards source timestamps fail immediately, while equal adjacent
timestamps are allowed. `ingestionStatus: "unknown"` is deliberately not
treated as either healthy or failed. The watermark is a rolling cutoff, not a
five-minute wall-clock boundary. On success or ordinary observer failure, the
workflow uploads bounded public-only JSONL evidence and a terminal summary for
seven days. It does not run on a schedule, deploy, authenticate to
Azure/Fabric, or call start/stop routes.

This observer proves sustained freshness and consistency only through the
public API. It does **not** prove raw-to-validated ingestion, SDK send
settlement, full tag/detail coverage, incident readiness, or a native live
ontology binding. Those claims still require the separately reviewed exact
Fabric/Kusto trace and other parent-owned acceptance evidence.

### Practical private stop

Use the signed delegated endpoint documented in
[run coordination](mining-run-coordination.md#authenticated-generation-stop),
or the current authorized Azure CLI login:

```powershell
.\scripts\simulate\stop-mining-continuous.ps1 `
  -SubscriptionId <selected-subscription> -TenantId <selected-tenant> `
  -CallerPrincipalId <approved-current-cli-caller-object-id> `
  -ResourceGroupName <selected-resource-group> -StorageAccountName <exact-backend-state-account> `
  -ContainerName <exact-backend-mining-state-container> `
  -Generation <exact-configured-generation> -Apply
```

Without `-Apply` the script is read-only. It verifies the explicit
subscription/tenant/current caller object ID/account endpoint, then conditionally creates and reads back
only `<selected-container>/continuous/holds/<generation>.json`. The container
must match the backend's `MINING_STATE_CONTAINER` (`mining-state` for the
verified live deployment, with isolated `mining-state-...` names also supported).
The result includes the exact target URI for operator comparison. Tokens stay in memory;
no role/policy, capacity, writer lease or run state changes occur. A 412 existing
hold is validated, never overwritten. Unknown delivery must be reconciled with
a read-only invocation. `StopIntentConfirmed` is **not** send settlement or
Fabric completion. Observe the owner stop, then disable the worker. Use a
deliberate new generation to resume; never delete holds to force admission.
Read this alongside the schema-3 minimum rollback baseline in run coordination.
Local tests/builds do not satisfy the separate cloud multi-window acceptance gate.

## Explicit backend call

After independently establishing caller authentication and plant/run
authorization, trusted backend code may explicitly construct
`configuredMiningPublisherRuntime(env)` and **await** `runtime.run(input)`.
The input is the coordinator's `StartMiningRun`: D01, caller-retained lowercase
UUID requestId, bounded duration, scenario and seed. The call stays pending
until sender work, transport close and terminal persistence settle. Do not
fire-and-forget it or map admission to delivery success.

Only a fresh `kind:"started"` admission supplies the ephemeral owner and
constructs a transport. An observed/retried admission returns durable status
without launching, resuming or adopting anything. `status` and `requestStop`
delegate to the coordinator and never start a sender. Stop acceptance is intent,
not acknowledgement. An optional caller AbortSignal fails the run; it is not a
durable operator stop. Use the authorized `requestStop` path for that.

### Supervised host ownership

`MiningPublisherHost` is an explicit trusted-host lifecycle adapter, not an HTTP
route, a startup job or an activation grant. Construction does no I/O. Its
default factory captures the environment once and retains the existing
default-off publisher configuration.

After independently authorizing the exact run, call `host.start(input,
requestSignal, incidents?)`. Retain both returned promises: `admission` reports
`kind:"started"` only after fresh durable accepted-admission readback, whereas
`completion` joins the actual sender, incident cleanup, transport close and
terminal persistence. Neither admission nor publisher completion proves Fabric
ingestion. `kind:"observed"` never adopts, resumes or launches a sender, including
for rejected or pending admissions; callers must inspect the returned status.

The request signal can cancel admission, including a late accepted write. If
admission returns a fresh owner after cancellation, the runtime persists failure
and cleans up that owner without constructing a transport. An uncertain
admission/lost write response still requires reconciliation; neither path rolls
back durable admission. After admission notification, request
completion/disconnect no longer owns execution. The host tracks the completion
promise and reports execution failures even if the request disappears.
One local admission/execution may be active at a time; a conflicting start
must reconcile durable status instead of restarting. Cross-replica authority
still comes exclusively from the existing Blob lease coordinator.

The backend entrypoint mounts a default-off delegated start route and coordinates
shutdown. A direct `server.close()` and main-process `SIGTERM`/`SIGINT` both
prevent new publisher work first, stop background services, terminate upgraded
WebSocket clients, close HTTP, and join `host.close()` before reporting success.
Shutdown errors are surfaced. Uncooperative I/O can delay settlement, and the
platform can terminate the process before it settles; this does not prove a run
completed or its writes were rolled back. Finite leases and durable
reconciliation remain necessary. Worker lifetime and scaling are still not
configured or validated for a full run, and the route remains disabled unless
its separately approved settings are explicitly applied.

Incident processing is a separate **explicit** optional third argument to
`run(input, cancellation, incidents)`: the trusted host supplies
`MiningIncidentDependencies`, including a delegated authority and a real
strictly validated curated source. The pure `createD01VersionedIncidentRun(run)` factory
binds `runId`, `startedAt` and `endsAt` to the freshly admitted run and its
model `stopAt`, never `finalFlushUntil`, and incorporates its persisted contract
into the schema-2 journal definition. It freezes tags in canonical source
catalog order, joins module scopes and the versioned publication profile by
ID, and checks their identities and intervals. It never uses the raw interval
placeholder. Incident processing requires a whole number of minutes. No
constructor, configuration flag, observed admission, status read or ordinary
viewer disconnect activates or adopts it. There is no production curated
adapter or delegated write boundary in this source.

`createD01IncidentRun` retains the exact legacy schema-1 definition for
read/recovery; it does not add the new contract to old records. The incident
reader selects the versioned definition only when the persisted run
contains its supported contract. A schema-1/schema-2 journal binding mismatch
is rejected, never retried against the other definition. A reconstructed
digest or prospective source-recorded contract does not establish historical
authorization or which deployed producer actually ran. An independently trusted
approved-run/version proof is still required before exposing incident data.

On an accepted stop through this runtime, the local incident processor is
aborted as soon as stop intent is persisted, even if the subsequent status
read fails; that failure still reaches the caller. An uncertain stop write
aborts local incident and sender work and remains an error. A stop recorded
elsewhere is observed by the next owner heartbeat or batch admission. Owner cancellation or runtime shutdown also
aborts it. `close()` initiates incident-head lease release but does not join
ongoing reads or commits: the runner awaits both close and the actual scheduled
operation before owner terminal persistence/release. An already admitted send
still settles under the existing batch rules. Unknown incident writes remain
uncertain, including a commit that may have preceded lease release; cleanup
errors fail the run rather than being reported as a successful stop. A
non-cooperative dependency can delay settlement until owner authority expires.
Stopping incident processing does not prove that the final curated minute was
processed or that ingestion completed.

The clock and scheduler are injectable for local tests. Production uses wall
UTC, monotonic `performance.now()` and abortable timer waits, not a simulator
catch-up loop. Every five-second step must occur at/after its exact UTC deadline,
with at most **1000ms scheduling/storage lateness** on both clocks. Clock jumps,
missed deadlines or late admission fail explicitly; no historical burst is
generated. Hosts still require synchronized clocks.

The owner heartbeats at each five-second step. Only pending simulator batches
are sent (normally every 30 seconds, plus the terminal partial batch when
explicitly permitted below), always inside the owner batch gate. The transport
uses the existing Eventstream Event Hubs-compatible protocol/parser and official
SDK, with isolated mining credentials, automatic SDK retries disabled, a 2000ms
send budget and cooperative AbortSignal propagation to batch creation and send.
The runner awaits actual network settlement even after abort, then closes the
client and finishes the owner. An uncooperative transport cannot be forcibly
settled: no detached work or false terminal success hides this uncertainty.

Only `batch.events` (flat numeric `PlantTelemetry` / `PlantStateEvent`) is
published. `alert_transitions` is simulator-private diagnostic data, never a
transport event or evidence of the separate five-rule incident engine.
`interval_seconds` on numeric events is the operational 30/60-second cadence;
the raw catalog's 1000ms suggested interval is a placeholder, not publication
cadence. This runner does not infer schedules or counts from that raw field.

Acknowledgement happens only after **all** SDK sends in the pending batch
succeed and the timeout/authority signals remain valid. Partial/uncertain
delivery is never retried automatically or acknowledged. Downstream stable-ID
deduplication/reconciliation remains necessary; no exactly-once claim is made.
`publisher_complete` means only sender completion, never Fabric ingress,
validation, curated counts or incident acceptance.

### Eventhouse ingestion reconciliation

Deploy `infra/fabric/eventhouse/MiningRunIngestion.kql` only to the approved
Mining database after its raw, validated and quarantine sources report ready.
Then explicitly set `MINING_INGESTION_RECONCILIATION_ENABLED=true` on the backend.
The default remains off so an existing deployment without the new function
continues to report ingestion as unknown.

An overview read queries exactly five event families at its requested UTC
receipt cutoff. The backend replays the persisted, versioned run offline
without sending events and compares the SHA-256 hashes of sorted distinct
event IDs for both raw and validated telemetry and state. Publisher completion,
equal row counts, or repeated identical deliveries alone do not establish
ingestion completion. Conflicting validated payloads or any quarantined IDs
prevent completion. Unsupported legacy run contracts, malformed results,
truncated ID sets and query errors fail explicitly rather than inventing success.

The overview returns `pending` when nothing is observed, `partial` for incomplete
evidence, `complete` only when every expected ID is present in both sources and
the publisher completed, or `unknown` when source readiness fails. Counts,
expected-ID hashes, the receipt cutoff and provenance accompany the result.
These are ingestion evidence, not proof that a report, ontology graph, incident
processor or assistant consumed the data. Status/start/cancel endpoints remain
coordination-only and explicitly unknown; the Cockpit uses timestamped overview
evidence only for the matching run.

## Final-batch boundary: explicit activation decision

The simulator cannot emit its terminal batch until model `stopAt`; the original
coordinator cancels at exactly that instant. **The default remains strict**:
there is no final-flush budget, so a runtime reaching this boundary fails rather
than claiming the undelivered final batch completed.

An explicit source capability now permits `finalFlushMilliseconds` from 0..5000
on the coordinator (default 0). A fresh admission with remaining lifetime
persists optional `finalFlushUntil` separately from unchanged model `stopAt`.
Only `owner.runFinalBatch({runId,timestamp:stopAt}, callback)` may admit one
terminal batch during that window. Normal `runBatch` retains its existing
pre-stop admission semantics. Final admission is reserved inside the owner's
exclusive critical section before asynchronous refresh; concurrent reuse is
invalid, including while the first attempt is still checking authority.
The runner uses this capability only after the
simulator has reached its terminal step and actually has a pending batch.
There are no later model steps or future timestamps.

The absolute publisher lifetime remains at most **1800 seconds from startedAt**,
including any opt-in flush. A full 1800-second model run has no remaining drain
budget and therefore truthfully fails its unsent final batch. Shorter runs can
drain at most five seconds, additionally bounded by lease authority and the
two-second transport budget. Lost/expired authority or requested stop never
resurrects a timer, signal or owner. Stop is checked again at final admission;
the existing single already-authorized batch drain race remains explicit.
Final-flush failure/timeout is not completion.

## Configuration and fail-closed boundaries

| Variable                                        | Contract                                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MINING_PUBLISHER_ENABLED`                      | Absent/`false`: returns undefined without constructing clients. Only `true` enables explicit factory use.                                                     |
| `MINING_EVENTSTREAM_EVENTHUB_CONNECTION_STRING` | Explicit mining-only source connection string with namespace, EntityPath, SAS key name and key. No triathlon-variable fallback. Never expose to browser/logs. |
| `MINING_FINAL_FLUSH_MILLISECONDS`               | Optional integer 0..5000; absent means strict 0. No deployed value is supplied by this PR.                                                                    |
| Coordinator variables                           | Explicit enabled durable Blob configuration and managed identity requirements in [mining run coordination](mining-run-coordination.md).                       |

Construction does not prove credentials, target identity, permission or service
reachability. Enabling these flags is **not approved by this source PR**.
No resource creation, config application, role change, cloud writes, live runs,
deployment, job/scale changes or existing token-store reuse is included.

Named activation gates still include independently verified delegated write
authorization (Cockpit start/cancel/assistant remain 503), approved private
mining-state container and container-scoped MI access, authoritative same-item
Eventstream endpoint metadata/DNS, mining-only raw preservation, strict
validation and curated ingestion. Live stop/concurrency/failure tests and
end-to-end five-rule incidents remain separate. This PR claims none of
G1-G8, G4/G5 acceptance or public operator-app readiness.

Rollback is source revert while disabled. If separately activated later, first
disable new authorized admissions and drain/reconcile the finite lease and any
uncertain batch; do not break a lease, substitute an endpoint or delete durable
run evidence to force recovery.
