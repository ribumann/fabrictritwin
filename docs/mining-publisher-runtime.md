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
pre-stop admission semantics. The runner uses this capability only after the
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
