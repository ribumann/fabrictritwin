# Synthetic history and insights foundation

This is a backend/library foundation, **not a runnable anonymous Cockpit demo**.
There is no new UI, public trigger, deployment change, fake assistant, or change
to live authorization. Race/session execution, ingestion, race summaries, MCP
tools, and assistant calls still use their existing live paths.

## Explicit provider selection

`DEMO_PROFILE=synthetic` selects an in-memory provider for the Streaming Backend's
existing analyses/alerts routes and alert listener. The only synthetic athlete is
`11111111-1111-4111-8111-111111111111`. The profile must match exactly. Unset
means `live`; `live` preserves Eventhouse behavior. Empty/unknown values fail
explicitly, and live configuration/query failures never fall back to synthetic
data. Supplying a live query executor in the synthetic profile is rejected.

The provider needs no Azure/Fabric account, credential, storage, or outbound
network. It seeds one bounded 112-day history in memory from the incumbent
periodization, metrics, and anomaly generators. The default reference date is
fixed at `2026-09-07` and the seed is `DEFAULT_HISTORY_SEED`; library callers can
supply a valid date and unsigned 32-bit seed. It does not cache arbitrary athlete
IDs, write cloud data, or mutate the seed when queries run. Restarting recreates
the same data.

Both REST endpoints **still require the existing athlete authorization**.
Tests use the existing fictional principal-to-athlete map; this is not a visitor
authentication design or authorization bypass. Do not configure or expose the
live simulation endpoints as account-free controls based on this profile.

Responses carry `provenance.source = "synthetic"`, seed, reference date, and a
human-readable label. Streamed alerts additionally carry `context.source =
"synthetic"` and synthetic detail text. Live response shapes are unchanged.
Consumers must display provenance before presenting these responses publicly.

## Reusable dataset and calculations

`generateSeedHistoryDataset({ athleteId, referenceDate, seed? })` is exported by
`@triathlon-twin/simulator`. It returns the same typed athlete, plan, races,
equipment, health, nutrition, telemetry, and injected anomalies used by live
`seedHistory`, without invoking the persistence/publishing service. An explicit
valid `YYYY-MM-DD` date is mandatory; there is no wall-clock default. Each call
returns independent data. Importing the package loads SDK modules but does not
construct Azure credentials/clients or perform network operations.

The synthetic insights provider derives workload ratio, recovery score, sleep
debt, taper index, and live-session nutrition adequacy using the history-backed
formula semantics in `infra/fabric/eventhouse/DatabaseSchema.kql` (including
averaging populated training days and sample HRV standard deviation). These are
demonstration calculations, not medical advice or a replacement for Eventhouse
execution. Nutrition adequacy is null when the snapshot has no live session.
ACWR, overdue-session, and fueling alerts are derived from the snapshot with the
existing thresholds. The fixed reference date is the overdue-session clock.
Without live telemetry it does not fabricate sustained-high-HR or race-drift
alerts.

## Verification and remaining work

Credential-free Vitest coverage exercises deterministic bounded model output,
invalid inputs, isolation from live defaults/failures, preserved route auth,
explicit REST errors, provenance, and alert-listener deduplication. Azure client
constructors and outbound HTTPS/fetch are forbidden in provider tests.

Remaining releases must add bounded account-free session/race execution and
public-read authorization, wire the single Cockpit to this provider and label its
provenance, implement anonymous concurrency/rate limits, and independently prove
the local and hosted demos. No Azure resources are needed or changed by this PR.
