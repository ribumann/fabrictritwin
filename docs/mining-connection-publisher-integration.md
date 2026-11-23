# D01 shared-flow publisher integration

The shared physical-flow simulator is opt-in. The existing profile remains the
default: omit `profileVersion` from a start request to run the legacy
`PlantTelemetry` / `PlantStateEvent` publisher unchanged.

## Explicit selector and durable run record

The delegated start request selects the new run explicitly:

```json
{
  "plantId": "D01",
  "runId": "11111111-1111-4111-8111-111111111111",
  "profileVersion": "d01-shared-flow-v1"
}
```

The request is rejected unless `MINING_CONNECTION_FLOW_ENABLED=true`. Admission persists the selected profile and a future schedule before the
publisher starts. The shared-flow contract is isolated in coordination schema
version 4; legacy bounded and continuous records retain their existing schemas.
A representative preparing plant document contains:

```json
{
  "version": 4,
  "run": {
    "plantId": "D01",
    "runId": "11111111-1111-4111-8111-111111111111",
    "profileVersion": "d01-shared-flow-v1",
    "durationSeconds": 1200,
    "shutdownAtSeconds": 1020,
    "drainDownSeconds": 180,
    "scenario": "normal",
    "seed": 1,
    "admittedAt": "2026-11-07T12:00:00.000Z",
    "pinDeadlineAt": "2026-11-07T12:02:00.000Z",
    "startedAt": "2026-11-07T12:02:05.000Z",
    "stopAt": "2026-11-07T12:22:05.000Z",
    "finalFlushUntil": "2026-11-07T12:22:10.000Z",
    "authorityUntil": "2026-11-07T12:00:45.000Z",
    "phase": "preparing",
    "connectionProfileContract": {
      "catalogVersion": "sha256:0ba278e5e28b3466381534c5a920ce28b551cb3a7ddfc68cdf4371749f2c62ce",
      "measurementCatalogVersion": "d01-connection-measurements-v1",
      "profileVersion": "d01-shared-flow-v1",
      "legacyProjectionProfileVersion": "d01-shared-flow-legacy-projection-v1"
    }
  }
}
```

The request receipt also pins the same `profileVersion` and schedule. Omitted
profile remains legacy; reusing a run ID with another profile conflicts. Old
version-1 and version-2 legacy records are not upgraded or reinterpreted.

## Fabric profile pin hook

The default hosts configure `connectionRunProfilePin` only when
`MINING_CONNECTION_PIN_EVENTSTREAM_ENABLED=true`. A trusted caller may also
inject the callback explicitly. The run
record and admission receipt are durably accepted first, with
`phase: "preparing"`; this is returned to the caller so the start request can
settle without waiting on queued ingestion. The handler then receives the
following descriptor and must resolve only after the immutable pin is
confirmed:

```ts
interface MiningConnectionRunProfilePin {
  plant_id: "D01";
  run_id: string;
  catalog_version: string;
  measurement_catalog_version: "d01-connection-measurements-v1";
  profile_version: "d01-shared-flow-v1";
  started_at: string;
}
```

Without receipt-based starts, `started_at` is the immutable future schedule
anchor, set 125 seconds after `admittedAt`. The pin deadline is 120 seconds after admission, leaving a fixed
5-second safety margin. The external writer owns the actual `pinned_at`; it is
intentionally absent from this descriptor. After exact readback succeeds, both
Eventstream sender links are prepared without sending an event. Only after
both preparations succeed does the owner persist `phase: "scheduled"`. At `startedAt`, it persists
`phase: "running"`; the first simulator sample is still exactly `startedAt +
5s`. The owner renews its lease and checks stop intent every 10 seconds while
preparing and while waiting for the scheduled start. A stop, timeout,
cancellation, or loss of lease authority aborts preparation and prevents
activation and measurement sends. Publishers are not constructed before pin
confirmation. Duplicate/restarted calls
observe the durable record and never resend the pin or reconstruct an owner.
The callback must honor its `AbortSignal`, including during send and readback.
An ignored abort can leave a pin-side effect uncertain, but still cannot
activate the run or authorize measurement sends. The callback is an integration
boundary; the opt-in Eventstream handler sends a pin once and confirms its
actual Eventhouse receipt before returning.

## Shared-flow admission deadlines

Shared-flow starts require `MINING_FINAL_FLUSH_MILLISECONDS` to be a positive
integer from 1 through 5000. The prepare lead, configured run duration, and
flush budget must fit within the 1800-second total lifetime measured from
`admittedAt`. With a 5000 ms flush budget, the maximum duration is 1670 seconds;
a 1675-second request is rejected before durable admission. The unset/zero
default remains unchanged for legacy runs. This bound includes pin preparation,
the scheduled run, and final flush; it is not extended by retries or delayed
ticks.

Queued pin acknowledgement may take longer than the old five-second first-tick
window: it is allowed up to the durable 120-second pin deadline. Neither
`startedAt` nor any sample deadline is shifted to accommodate actual latency.
The runtime uses both wall-clock and monotonic deadlines, rejects a pin that
arrives at or after its deadline, and never catches up, skips, backdates, or
resends a sample. If pin confirmation is late, absent, ambiguous, or interrupted,
the run fails without sending measurements. A sender-preparation failure also
prevents activation; any constructed publishers are closed.

### Receipt-based start

The optional `MINING_CONNECTION_RECEIPT_START_ENABLED=true` gate uses a
versioned `fabric-receipt-v1` pin. The pin's `started_at` is the latest
permitted start, not the actual start. Fabric and the publisher derive the
actual start as the earlier of that timestamp and the pin's persisted
`ingestion_time()` rounded down to a second plus 31 seconds. This allows
preparation to finish early without waiting for the entire 125-second lead.
The first sample remains five seconds after the derived start.

The publisher sends the pin once, reads back its policy and actual Fabric
receipt, prepares both senders, and records the derived start under the plant
lease before publishing. A missing, mismatched, implausible or late receipt,
stop request, lost lease, or insufficient activation margin fails the run
without sending measurements. The original 120-second preparation deadline
and admission-to-flush limit remain in force. Receipt time is approximate
Fabric service-clock evidence, not an ordering guarantee for concurrent
ingestions; the clock and remaining-margin checks are deliberately fail-closed.

For an existing installation, apply `MiningConnectionReceiptStartUpgrade.kql`,
the run-profile JSON mapping in `MiningConnectionSchema.kql`, and the updated
validation and query functions before enabling the gate. Existing pins with no
policy keep their original exact-start interpretation. Disable the gate to
return new runs to the fixed-start protocol; keep the updated Fabric functions
until all receipt-based runs have expired from retention. Older application
revisions cannot read version-5 run state, so use an isolated state container
for deployment and preserve the previous revision's container for rollback.
Switch or roll back only while no publisher is active. The old container does
not automatically receive runs created in the new container.

An isolated canary confirmed one pin in about 45 seconds. Two separate
57-measurement samples reached raw and validated tables; a warmed sender
acknowledged one sample within the two-second send budget. These observations
do not establish a latency guarantee or prove a complete run. The two samples
were deliberately backdated and cannot establish live freshness. A later
real-clock canary matched all 2,109 observations at a common cutoff; its
maximum observed raw receipt lag was 37.17 seconds. In a subsequent regional
receipt-start canary, the start was about 54 seconds earlier than the fixed
schedule, and live reads returned all 57 measurements. Timing varies with
Fabric ingestion and preparation; it is not a latency guarantee. The gate is
off by default.

## Separate transports and event contract

Configure both sources only for the explicit profile:

- `MINING_EVENTSTREAM_EVENTHUB_CONNECTION_STRING`: existing legacy source.
- `MINING_CONNECTION_EVENTSTREAM_EVENTHUB_CONNECTION_STRING`: dedicated
  connection-flow source, with SAS send credentials.
- `MINING_CONNECTION_FLOW_ENABLED=true`: permits the explicit selector.
- `MINING_CONNECTION_PIN_EVENTSTREAM_ENABLED=true`: enables the dedicated
  Eventstream pin writer and exact readback.

The configured connection target must differ from the legacy Eventstream
namespace/entity. Missing or shared targets fail closed. Each five-second
connection sample is a distinct batch of at most 200 raw events; no
`ConnectionMeasurement` is appended to the legacy batch. Both sends are awaited
before the simulator advances. Ambiguous failures are not retried. The raw
event's discriminator is `entityType: "ConnectionMeasurement"` with
`schema_version: 1`, stable `event_id`, ordered `sequence`, sample timestamp,
profile/catalog versions, explicit source/target binding, quantity, basis, value,
unit, quality, and origin. Each sample currently contains 57 bound observations.
Publisher latency telemetry keeps `legacyEventCount` and `connectionEventCount`
separate in addition to the aggregate `eventCount`.

The same shared-flow simulation generates both the connection observations and
the restricted legacy sensor projections for that run. It coordinates its
shutdown and drain-down schedule and only reports publisher completion after
the final zero-inventory step has been sent. This is publisher settlement, not
proof that Eventstream, Fabric, or Kusto ingested the data. API
`ingestionStatus` remains `unknown` at publication time. For a completed,
normal public shared-flow run, a separate background worker reconstructs the
schedule, compares each raw and validated payload and checks all associated
row totals at one cutoff. It stores a snapshot only when the comparison is
complete. The overview rechecks row totals for later arrivals and identifies a
changed result rather than treating the snapshot as permanently complete.
This is cutoff-specific evidence, not a guarantee against future arrivals.

## Remaining integration requirements

- The staged Fabric route and immutable profile pin must be verified by live
  ingestion before the backend enables the new profile. Its deployment must
  provide the separate connection-source credentials.
- This publisher does not write a Fabric completion marker. The separate
  private-store evidence snapshot is not a marker and does not alter Fabric.
- Public connection-flow reads additionally require
  `MINING_CONNECTION_FLOW_READ_ENABLED=true`. The service only exposes the
  currently admitted, public-marked shared-flow run, and rechecks its durable
  authority after each query. The flag is off by default and does not create a
  pin, start a run, or confirm ingestion. The current managed continuous
  publisher does not support this profile.
- `MINING_PUBLIC_DEMO_CONNECTION_FLOW_ENABLED=true` selects the shared-flow
  profile for public bounded starts only, and also requires
  `MINING_CONNECTION_FLOW_ENABLED=true`. Both are off by default. Existing
  incident reconciliation is not started for the shared profile because its
  legacy projections deliberately omit some tags.
