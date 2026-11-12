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

## Mining: offline definition review only

The mining extension shares the existing endpoint and database, not the
triathlon tables. Its proposed ownership ledger is:

| Owned object | Purpose |
| --- | --- |
| `mining_TelemetryRaw`, `mining_PlantStateEvents` | Raw v2 JSON documents and ingestion times; seven-day soft-delete period |
| `mining_PlantCatalog` | Versioned module, equipment, tag and stream records |
| `mining_AlertTransitions` | Alert transitions; 30-day soft-delete period |
| `mining_telemetry_json_map`, `mining_state_json_map` | Root-document JSON mappings on the respective raw tables |
| `mining_telemetry_*`, `mining_state_*` | Two proposed Eventstream filters, derived streams and destinations |

`infra/fabric/eventhouse/MiningSchema.kql` is a proposed definition, not an
apply script. It does not validate v2 events, quarantine malformed events,
deduplicate retries, create the catalog, implement incidents or provide the
five analytics contracts. Do not query these raw tables as validated readings.
Kusto soft-delete periods are minimum availability periods, not guaranteed
immediate deletion; the table-only commands leave database recoverability and
other tables unchanged.

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
snapshot over unrelated edits. Mining table deletion is a separate destructive
decision requiring explicit approval and a check for downstream use; never
tear down the database. The legacy resume helper deliberately rejects this
expanded topology until separately extended and tested. G4 actual ingestion
and G5 queries remain unimplemented and require a hosted verification window.

References: [Eventstream definition](https://learn.microsoft.com/en-us/rest/api/fabric/articles/item-management/definitions/eventstream-definition),
[update definition](https://learn.microsoft.com/en-us/rest/api/fabric/eventstream/items/update-eventstream-definition),
[JSON mapping](https://learn.microsoft.com/en-us/kusto/management/json-mapping?view=microsoft-fabric),
and [retention policy](https://learn.microsoft.com/en-us/kusto/management/retention-policy?view=microsoft-fabric).
