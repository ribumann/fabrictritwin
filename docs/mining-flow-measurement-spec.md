# D01 connection-flow telemetry

Status: implemented behind default-off feature gates and enabled in the
hosted Mining demo. The baseline and requirements below describe the starting
point and the original pinned-v1 design, not the current live contract. See
[current flow and data models](mining-learning-guide.md#simulation-and-data-models)
and [publisher integration](mining-connection-publisher-integration.md) for
the run-independent v2 path and its limits.

## Outcome

Every physical material connection in the recovery plant has an explicit,
timestamped flow measurement. The twin can display its rate and direction,
compare upstream and downstream trends, and distinguish stopped flow from
missing data. All values remain synthetic, not calibrated plant measurements.

The existing 50 catalog streams are the starting inventory. They include nine
process-water supply branches, one recovered-water return, process solids,
rejects, effluent and medium circuits. "Every equipment" means the equipment
and ports carrying these streams, not invented flows through motors, vibration
sensors or other logical children.

## Starting boundary

- The simulator advances its process model every five seconds. Most existing
  numeric events are simulator-computed 30/60-second averages, sent in
  30-second batches. A separate hopper lane supplies five-second inventory
  points; its 30/60-second averages are computed in Fabric.
- Crusher and sorter tags measure stage inlet feed, not every conveyor.
- Shared water has a tank-level tag and a supply-flow tag. Neither establishes
  the rate of each branch.
- Delay queues, an illustrative 18% dry-solids split to the sorter, and shared
  water accounting provide useful foundations. They are not yet a complete
  port-by-port mass and water balance.
- Line/shared state is not individual-equipment state. The lab's accumulated
  sample mass is not a measured commercial product-recovery rate.

Do not interpolate missing streams from nearby sensor values or copy a shared
water total onto every branch.

## 1. Catalog and event contract

Add a versioned connection-measurement binding for each stream:

| Field                            | Purpose                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `stream_id`                      | Stable identity of the authored source/target port pair                       |
| source/target equipment and port | Explicit physical endpoint, below module level where supported                |
| `measurement_tag_id`             | Unique sensor identity; one observation cannot count as two sensors           |
| quantity and basis               | Dry-solids mass flow, water volume flow, or medium flow; distinguish mixtures |
| unit                             | `t/h` for dry solids, `m3/h` for water; do not compare their magnitudes       |
| nominal capacity                 | Reviewed visualization scale, not an alarm threshold                          |
| sample cadence                   | Five seconds for the new connection-flow observations                         |
| origin                           | Synthetic sensor observation versus explicitly derived quantity               |

Effluent and slurry can carry both dry-solids and water components. Specify each
component separately; do not equate slurry tonnes with dry ore tonnes. Describe
ferrosilicon/medium circuits separately from ore, and explicitly model external
feed, makeup, losses and outlet boundaries.

Introduce a reviewed raw-observation contract/profile version supporting
five-second samples. Preserve run, plant, catalog/profile versions, event ID,
sequence, sample time, tag/equipment/stream identity, value, unit and quality.
Use an exact-field discriminator for connection observations rather than
silently adding fields to today's strict schema-v2 validator.

Retain the existing validated contract for old runs. Pin each new run to one
catalog/profile version; never reinterpret historical observations using a
new stream mapping. Generate all transport copies from the same immutable
observation identities.

## 2. Simulator

Expose actual modeled rate at every relevant source and destination port:

1. Account for external hopper input, actual dispatched mass, capacity/spill
   and each line's allocated feed. Apply availability limits before emitting
   sensor values.
2. Track material in transit and inventory at processing stages. Delayed
   arrival is stored material, not a disappearance. A stopped line drains or
   holds its inventories according to explicit equipment behavior.
3. Implement deterministic splits for sizing, DMS sinks/floats, rinse,
   concentrate, sorter rejects and recovered product. All split outputs plus
   retained inventory and modeled losses must equal the input. Keep the
   illustrative concentrate yield distinct from diamond recovery.
4. Allocate delivered water to the nine supply branches. Account separately
   for makeup, rinse/scrubber demand, return delay, thickener return, water in
   slurry/tailings, losses, tank storage and overflow. Delivery allocation
   must never exceed available water.
5. Emit raw five-second observations; move averaging/windowing for the new
   profile to Fabric. Keep batching a transport choice: five-second samples
   may be sent together without becoming one averaged sample.
6. Add bounded demonstration scenarios: one line restriction, shared water
   restriction, hopper starvation and one missing sensor. Communication loss
   omits/invalidates observations; it must not emit fabricated zero flow.

Use rate integration over the exact five-second step for balance checks.
Set the numeric tolerance from the model's unrounded precision and test it
explicitly; rounded display values must not drive the process balance.
Do not expose arbitrary fault injection through public controls.

## 3. Fabric

Extend the existing mining-owned Eventstream/Eventhouse path:

- Route the new raw-observation family into a mining-owned raw table with
  preserved source timestamps and actual ingestion timestamps. Validate
  identity, run version, catalog bindings, units, finite values and cadence.
- Deduplicate identical event identities; quarantine conflicts and unknown
  bindings. A receipt for one native-streaming observation is not proof that
  the complete plant batch has arrived.
- Materialize versioned validated observations. Preserve the existing queued
  validation path where classifiers join catalog/profile tables; do not
  enable streaming ingestion on it merely to reduce delay.
- Compute aligned 30/60-second windows in Fabric, exposing count, expected
  sample count, quality, coverage, window bounds and last source/receipt time.
  Six unique scheduled ticks are required for a complete 30-second window;
  twelve for 60 seconds. Explicitly distinguish partial windows from complete
  averages, and never substitute missing samples with zero.
- Provide bounded latest-stream and stream-trend functions, indexed/scoped
  by run and catalog version. Define a common evidence cutoff when comparing
  several streams; do not join independently "latest" samples as simultaneous.
- Reconcile expected raw and validated event identity sets for completed runs.
  Update receipt-size limits and pagination based on the new volume, rather
  than returning truncated, success-shaped results.
- Extend the static Lakehouse topology/ontology with measurement-to-stream
  bindings. Update agent evidence allowlists after validation. Native
  historical reports remain snapshots unless a separate refresh is implemented.

The existing seven-day telemetry retention does not support claims about
months of history. Review retention and capacity at the resource/application
level before enlarging it; this spec does not grant access or change governance.

## 4. Cockpit contract

Return a stream reading with rate/unit, direction, measurement origin,
sample/receipt times, quality/coverage, and state. A missing reading stays
unknown. A genuine zero remains a valid observation.

Use separate, bounded width scales for solids and water. Always label rate
and unit; use endpoint markers for equipment condition rather than overloading
route color. Selecting a stream reveals its endpoint equipment and aligned
upstream/downstream trends. Account for travel time before suggesting buildup.

## 5. Acceptance and rollout

- Cover every catalog stream with explicit quantities/endpoints, or an
  explicit excluded/nonphysical classification. No undocumented "unmeasured"
  physical edges remain in the full-flow demo.
- Test steady state, startup, shutdown/drain-down, splits, return delays and
  restrictions against solids/water conservation and nonnegative inventories.
- Verify missing/bad/duplicate/conflicting/late observations, run changes and
  catalog-version mismatches. Require exact full-run reconciliation.
- Compare raw observations and Fabric windows against independently computed
  expected results. Confirm the twin displays the same quantities without
  changing their meaning.
- Calculate volume before deployment: `flow tags * duration / 5` observations,
  plus other sensor/state families. Enumerate mixture components before fixing
  the tag count. Test backend response limits and query latency at that load.
- Deploy catalog/validators and Fabric functions first, then a new-profile
  simulator canary, bounded read APIs, and finally the full-flow UI. Keep the
  old profile usable throughout. Rollback stops the new publisher and restores
  the prior profile/UI without deleting historical evidence.

Implementation touchpoints: `apps/simulator/src/mining/{catalog,events,simulator}.ts`,
the pinned plant catalog and publish profile, the mining streaming/backend
validators and DTOs, `infra/fabric/eventhouse/Mining*.kql`, the static topology
definitions, and the cockpit's evidence/route/trend rendering.
