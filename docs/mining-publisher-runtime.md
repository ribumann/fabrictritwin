# D01 publisher runtime (source only, default off)

`MiningPublisherRuntime` is a callable trusted-backend sender, **not an HTTP
endpoint, startup job, or deployment**. It integrates the merged deterministic
simulator and Blob lease coordinator. Existing triathlon APIs, generators,
jobs, root simulator exports and `DEMO_PROFILE` behavior are unchanged.
Nothing imports this runtime from the application entry point.

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
