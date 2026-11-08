# Live runtime operations

This runbook describes the **live Azure/Fabric profile**, not an account-free
release or a deployment guide. Use the [configuration inventory](dependencies-and-configuration.md)
to identify resources and identities in your own environment. The commands below
are read-only; replace every placeholder with the exact operator-owned target.
Use PowerShell and an authenticated Azure CLI with access to the intended tenant.
Do not paste tokens, credentials, resource IDs, athlete IDs, raw logs, or actual
metrics into public issues or commits. Query and log output may contain private
configuration or data; inspect and redact it locally.

For diagrams separating live requests, history/telemetry, the synthetic target,
and protected image releases, see [Release architecture](release-architecture.md).

## Release operator handoff

The public demo is the **live cloud-connected Fabric runtime with generated
synthetic data**, not the `DEMO_PROFILE=synthetic` in-memory bypass. Keep the
existing deployed Console running; removing its source and release targets does
not remove its cloud app or identity, and no cleanup is required for this release.
The source baseline includes the readable direct MCP formatter, but that is not
proof that its image has been deployed. Likewise, an image push is not a
deployment: consult the operator's release record for each app's source revision,
digest and traffic-serving revision.

On 8 November 2026, an accepted existing Console-triggered session produced 36
distinct-timestamp `SessionMetric` rows in Eventhouse, including its final
metric. Its 52 simulated minutes span future event timestamps relative to
ingestion, not future ingestion. A separate race observation included 85 fresh
`RaceSplit` rows including the finish. On 7 November, daily job, notebook and
public analytics freshness were observed. These observations are dated and
environment-specific; they do not establish ongoing health or acceptance of
the current serving revision. Direct user WebSocket access returned 403 and
is not proven. Human sign-in and delegated Fabric consent are not proven by
anonymous assistant responses.

The user owns final UAT of the actual public runtime, including the Cockpit
experience and any relevant human sign-in/consent. No further automated release
QA is planned, and this handoff does not claim that UAT passed. The read-only
checks and recovery guidance below remain available for later diagnosis, not as
a required additional release test suite.

## What must become fresh

The checked-in path is:

1. A Container Apps simulator job runs daily generation (default target: the
   current UTC date). It discovers seeded athletes in `SIMULATOR_ENVIRONMENT`,
   updates OneLake history files, records gaps rather than backfilling missed
   days, and skips generation for a day already generated.
2. With at least one seeded athlete, it invokes the Fabric load-history notebook
   once, including on an already-generated retry, and waits for `Completed`.
   With no athletes, the notebook is skipped. The notebook reads
   `Files/history-seeding/{environment}` and MERGEs JSONL into Lakehouse Delta
   tables. A manual notebook run reloads existing files; it does not generate
   a new day.
3. KQL database shortcuts expose five Lakehouse tables to functions in
   `infra/fabric/eventhouse/DatabaseSchema.kql`. The Streaming Backend's live
   analyses and alerts query Eventhouse; the Cockpit proxies these requests
   using its service identity. Its proxy relays upstream responses or returns
   502 if it cannot call the backend.

The schedule is **opt-in**: the Bicep default is a manual job; if enabled, the
default cron is `0 3 * * *` UTC. A bootstrap placeholder image can exit
successfully without generating anything. Inspect the actual job image,
configuration and execution, not just the template or a success status. The
simulator uses its managed identity for Fabric; a manual notebook run using an
operator's credentials does not prove that identity has equivalent access.
The notebook can auto-discover all seeded athletes and its output can contain
their identifiers.

`asOf` on analyses is the maximum available timestamp among several component
queries, not proof that every metric is current. Compare the individual source
dates and expected UTC generation date as well as `asOf`; an empty result or
null metric needs separate investigation. A submitted job, a `Succeeded` job,
a notebook `Completed` run, HTTP 200, and fresh data are different checks.

## Read-only checks

Set placeholders locally. Specify the subscription on **every** Azure resource
command; do not change the CLI's default subscription. Select the backend
revision actually receiving the traffic you intend to diagnose, rather than
assuming the latest revision is serving it.

```powershell
$subscription = '<subscription-id>'
$resourceGroup = '<resource-group>'
$capacity = '<fabric-capacity-name>'
$job = '<simulator-job-name>'
$backend = '<streaming-backend-app-name>'
$revision = '<exact-serving-backend-revision>'

az account show --subscription $subscription --query '{subscription:id,tenant:tenantId}' -o json
az resource show --subscription $subscription --resource-group $resourceGroup `
  --resource-type Microsoft.Fabric/capacities --name $capacity `
  --query '{state:properties.state,provisioning:properties.provisioningState}' -o json
az containerapp job show --subscription $subscription --resource-group $resourceGroup --name $job `
  --query '{trigger:properties.configuration.triggerType,schedule:properties.configuration.scheduleTriggerConfig.cronExpression,containers:properties.template.containers[].{name:name,image:image}}' -o json
az containerapp job execution list --subscription $subscription --resource-group $resourceGroup --name $job `
  --query '[].{name:name,status:properties.status,start:properties.startTime,end:properties.endTime}' -o json
az containerapp revision list --subscription $subscription --resource-group $resourceGroup --name $backend `
  --query '[].{name:name,active:properties.active,traffic:properties.trafficWeight,health:properties.healthState,replicas:properties.replicas}' -o json
az containerapp revision show --subscription $subscription --resource-group $resourceGroup --name $backend `
  --revision $revision --query '{name:name,active:properties.active,traffic:properties.trafficWeight,health:properties.healthState,containers:properties.template.containers[].{name:name,image:image}}' -o json
```

Check command failures explicitly and stop rather than treating missing output as
healthy. In the Fabric portal, verify the workspace is on the intended active
capacity, the intended notebook instance's terminal status and environment,
and the latest relevant Delta table dates. Check its private run details for
failure reasons without publishing them. The notebook instance associated with
a simulator execution must be identified from that execution's private output,
not inferred from a different manual run. A `Failed`, `Cancelled`, `Deduped`,
or timed-out notebook is not `Completed`.

Verify that the KQL database has `sc_TrainingSession`, `sc_NutritionLog`,
`sc_RecoveryMetrics`, `sc_SleepSession`, and `sc_TrainingBlockPhase` pointing
to the intended Lakehouse `Tables/dbo` paths. Provisioning can skip a shortcut
when its target table has not yet been created. Use the Fabric query interface
with the intended identity to inspect the relevant functions and source dates;
do not expose query results. A local DNS or metadata check only proves reachability
from that client, not from a hosted Container Apps replica. Diagnose hosted
DNS, network, identity and Eventhouse access in the backend's environment.

For the intended, authorized athlete, call the Cockpit
`GET /api/analyses/{athleteId}` and `GET /api/alerts/{athleteId}` through the
actual configured public surface, using its applicable authorization. Inspect
status and redacted response locally; compare `asOf` and component dates to
the expected data, not merely to the request time. Backend 500 responses such
as `analyses_query_failed` differ from Cockpit 502 proxy failures. A healthy
Cockpit alone does not establish backend-to-Eventhouse connectivity.

## Recovery decision points

The following are **operator-controlled writes**, not part of the read-only
checks. Confirm target, permissions, service impact and cost before taking any
action. Capacity, Spark/notebook executions, Container Apps and other cloud
resources can incur charges; an active capacity remains billable until managed
according to the operator's policy.

- If capacity is paused, an authorized operator can review and run
  `scripts/fabric/resume-capacity.ps1` with explicit `-SubscriptionId`,
  `-ResourceGroupName` and `-CapacityName`, then verify `Active` and
  provisioning state. Resume is not a data refresh.
- Investigate the exact backend serving revision and its private diagnostics
  before considering a restart of that existing revision. The Kusto client is
  cached in the Streaming Backend process, not the Cockpit; restarting the
  Cockpit alone does not reset it. A restart is disruptive and is not a
  guaranteed DNS or data-freshness fix, especially with multiple replicas.
- If files are current but Delta tables are stale, an authorized operator can
  review `scripts/simulate/load-history-to-tables.ps1` and run it with explicit
  subscription, workspace, notebook and matching environment. It starts a
  billable notebook and waits for completion; a manual success does not prove
  the scheduled job's managed identity works.
- If files themselves are old, investigate the existing simulator job,
  schedule, seeded athletes, gap state and notebook permissions. An authorized
  operator may start the correctly configured existing daily-generation job,
  follow that execution through its own notebook completion, and then verify
  Delta, KQL and public API freshness. It generates the target day, not missed
  days. Review existing executions before starting another to avoid overlap.
  If shortcuts are missing after tables exist, review the provisioning script
  and its broader effects before any separately approved repair.

One environment has demonstrated recovery from a hosted query failure by
restarting the existing backend revision, followed by a successful daily job,
its completed notebook and a newer public analyses timestamp. A manual
notebook alone had reloaded old data. This is an example, not a guarantee or
evidence that another environment is healthy.

## Boundaries and evidence

The default backend profile is `live`; `DEMO_PROFILE=synthetic` selects a
separate in-memory analyses/alerts foundation with fixed reference data, no
live fallback, and unchanged route authorization. See
[Synthetic history and insights foundation](synthetic-runtime-foundation.md).
Neither local mock tests nor a synthetic response proves live Fabric health.
The live history path above alone does not verify real-time telemetry ingestion,
WebSocket delivery, race summaries, Power BI, or an account-free release.
An anonymous assistant response using grounded MCP tools is a separate check;
the native Fabric Data Agent requires delegated human sign-in.

Simulation's in-memory single-flight lock is process-local. The checked-in
backend permits up to three replicas, so it is not an environment-wide
concurrency guarantee unless deployment strictly enforces a single instance.
Do not infer safe anonymous concurrency or release readiness from this runbook.
