# Mining incident evaluation

`apps/streaming-backend/src/mining-incidents/evaluator.ts` is a bounded,
in-memory advisory state machine over curated D01 observations. It is not wired
to an API, runner, Fabric query, persistent store or notification route. It does
not establish live ingestion or mining acceptance. The simulator's diagnostic
alerts are separate and are not authoritative inputs.

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

## Runtime gates

An authorized adapter still needs curated query inputs, durable incident and
acknowledgement persistence, single-owner/fenced scheduling, restart recovery,
authenticated writes, and end-of-run shutdown. The current class cannot restore
incidents after a restart. A future notification adapter must deduplicate
transitions and enforce acknowledgement/reminder cooldowns; no Teams/email
delivery is implemented. These are demonstration advisories, never protective
controls or maintenance authorization.
