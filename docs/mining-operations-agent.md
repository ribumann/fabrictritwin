# Mining source-freshness Operations Agent

The private `mining-d01-operations-agent` is an advisory native Fabric experience,
not the public Cockpit assistant, a plant controller, or a notification service.
Its only source is the isolated Mining KQL database. Five-minute demo publishers
deliberately stop: missing samples mean **source stale or demo idle**, not plant
failure or healthy operation.

## Authoring and review

`scripts/fabric/New-MiningOperationsDefinition.ps1` generates an offline
`Configurations.json` definition using the
[current native schema](https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/operations-agent-definition):

```powershell
& .\scripts\fabric\New-MiningOperationsDefinition.ps1 `
    -WorkspaceId '<Mining workspace GUID>' -KqlDatabaseId '<Mining KQL database GUID>'
```

The result has no actions, recipient, sponsor, or generated playbook, and
`shouldRun` is false. It does not create, update, start or grant access to anything.
Updating a native definition replaces it: review the exact target, retain its
preimage and preserve any existing metadata rather than applying this new-item
template indiscriminately.

The [documented Operations Agent MCP endpoints](https://learn.microsoft.com/fabric/real-time-intelligence/mcp-remote-operations-agent)
support configuring a specific authorized agent, generating its playbook, reading
rules, and querying activity. Use the current delegated identity and native
consent. Do not transfer a token to the public app or register a global connection
as a shortcut.

Generation is not acceptance. Read `get_generate_playbook_status`, then
`get_playbook_rules` and each `get_rule_details`. Save the latter tool's decoded
JSON text and review it with:

```powershell
& .\scripts\fabric\Assert-MiningOperationsRule.ps1 -RuleDetailsPath .\native-rule.json
```

This is a deliberately narrow **exact-template gate**, not a general KQL safety
parser. It permits line-ending differences, not query rewrites. A different but
apparently equivalent generated query must be independently reviewed and executed;
do not weaken the gate merely to make it pass. Verify the complete rule inventory
contains only the intended rule, the saved source is Mining-only, and no external
action or destination exists. The gate does not start monitoring or establish
native execution/consent.

The reviewed query in
`infra/fabric/mining-operations-agent/source-freshness.kql` scans at most the
preceding 15 event-time minutes, then aggregates without a grouping key so empty
input still produces one assessment row. It distinguishes five-minute sample
absence from missing ingestion reconciliation. Run it against actual source data
and check both empty and fresh cases before starting monitoring. Then inspect
actual native rule state and activity; a green API response is not proof of correct
evaluation or delivered notification.

## Observed deployment, 2026-11-15

Mining workspace `db05aacb-bd7c-405a-a19b-90cc1c67d87b` contains agent
`e8810801-cc6a-4a01-b9dc-0b053f561fc1`, bound to KQL database
`62177ca4-73f8-4573-b0c6-8e9317e7dacc`.

The first native generated rule incorrectly equated exact sample and minute-window
timestamps and used `count()` over a left outer join. An unmatched assessment row
was counted as an event. Executed against the actual idle source, it returned zero
stale windows out of 15, whereas the reviewed aggregate returned zero recent events
and `NoEventsInLast5m = true`. The agent was **not started**.

Instructions were corrected with the independently executed aggregate. The next
generation failed with a native source-schema rate-limit error. This is a
generation failure, not a credential denial or successful monitoring. Do not
blindly regenerate an unknown request; inspect its exact playbook status first and
honor source throttling.

No notification recipient, Teams message, external action or plant control was
configured or invoked. Native monitoring/activity acceptance and standalone
Activator rules remain incomplete.
