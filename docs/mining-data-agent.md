# Mining D01 native data agent

## Isolated Mining workspace preparation

The approved isolated workspace is `4a809e56-42a8-4c30-a84f-83a47dd8793f`.
`scripts/fabric/Prepare-IsolatedMiningDataAgent.ps1` remains the local definition
generator. The separate `scripts/fabric/Invoke-IsolatedMiningDataAgentBootstrap.ps1`
entry point verifies or creates only the schema-enabled Mining Lakehouse, the
pinned public catalog, the static semantic model, and the native Data Agent in
that workspace. It does not read or copy shared/TriTwin workspace content.

```powershell
$prepared = .\scripts\fabric\Prepare-IsolatedMiningDataAgent.ps1 `
  -LakehouseId '<isolated-lakehouse-guid>' -SemanticModelId '<isolated-model-guid>'
```

The bootstrap target JSON contains the explicitly selected tenant, subscription,
isolated workspace, and dedicated service-principal object IDs; no Lakehouse or
SQL endpoint details need to be copied into it. The script requests tenant-scoped
Fabric, Storage, and SQL tokens from the current Azure CLI profile and validates
the tenant, service-principal object ID, audience, and expiry before use. It does
not require an Azure subscription context or Azure RBAC role; `SubscriptionId`
records the existing capacity association, while Fabric workspace/item access
authorizes the data-plane calls. It resolves the Lakehouse SQL endpoint from
Fabric. It never signs in, changes accounts, assigns roles, or changes capacity.

The existing dedicated service principal is already a Contributor only in this
isolated workspace. Its GitHub Actions federated credential
`mining-native-agent-proof` is configured for issuer
`https://token.actions.githubusercontent.com`, audience
`api://AzureADTokenExchange`, and subject
`repo:ribumann@46997953/fabrictritwin@1449513330:environment:azure-mining-bootstrap`.
The app has no password or certificate credentials. These identity settings are
not managed by the bootstrap. An independent main-branch acceptance workflow
(PR #96, run `43821551686`, merged commit
`71946c3ac4c390162fec19797d2d8738d50f0293`) successfully exchanged the GitHub
OIDC token, matched the expected `oid`, `appid`, and tenant claims, then read the
isolated workspace and its complete paginated item inventory, which contained
zero items at that time. This verifies federation and read-only inventory only;
it did not create or publish items or validate Lakehouse SQL/source access or
agent answers. No raw token or API response was exposed. `azure/login` emitted
a nonfatal Azure CLI version parsing warning but exited successfully.

The main-only `Isolated Mining native agent bootstrap` GitHub Actions workflow
uses the existing environment-scoped OIDC credential. A normal dispatch is
read-only verification. Creating items requires both the `apply` input and the
exact `apply_confirmation` value `CREATE-ISOLATED-MINING-ONLY-ITEMS`; a code push
does not run it. The environment restricts deployments to `main` but has no
required reviewer or wait gate; repository write access and an explicit manual
dispatch are the current controls. The job uses a memory-only Azure CLI cache
and keeps its append-only receipts on runner tmpfs. Receipts are never printed
or uploaded, because this repository is public. Treat any failed post-write run
as potentially partial; do not blindly repeat Apply. The ephemeral
receipt is not recoverable after the runner ends, so inspect the isolated
workspace and reconcile before another write attempt.

The script can also be run locally with an authorized Azure CLI service principal
and private absolute receipt paths:

```powershell
$targetFile = 'C:\private\mining-target.json' # TenantId, SubscriptionId, WorkspaceId, CallerObjectId
.\scripts\fabric\Invoke-IsolatedMiningDataAgentBootstrap.ps1 `
  -TargetPath $targetFile `
  -CatalogReceiptPath 'C:\private\mining-catalog.jsonl' `
  -NativeReceiptPath 'C:\private\mining-native.jsonl' -Apply -WhatIf
```

Without `-Apply`, the bootstrap is read-only and fails if a required resource is
absent. The explicit `-Apply` path can create the Lakehouse, materialize its
twelve public catalog tables, create the static model and Data Agent, then
publish the Data Agent. It validates exact names/types/IDs and reads back
definitions; it never updates an existing item or replaces mismatched table
contents. The JSONL receipts must be absolute paths in an existing private
directory. They are append-only write-ahead journals: an uncertain create or
publish outcome is reconciled from inventory, operation status, and definition
readback rather than blindly resubmitted. Resolve a malformed or unreconciled
receipt manually; do not delete it to force another attempt.

The static model and agent definitions are generated locally from the pinned
Mining catalog and existing repository generators. Creating/publishing an item
is not proof that its answers are correct; validate agent behavior separately.
See [catalog-only loading](../scripts/mining-ontology/README.md#catalog-only-loading)
for catalog permissions, verification, and failure handling. Two Apply attempts
were rejected while creating the Lakehouse with HTTP 400 (`InvalidInput`).
Microsoft's [Lakehouse naming rules](https://learn.microsoft.com/en-us/fabric/data-engineering/create-lakehouse)
allow only letters, numbers, and underscores after the initial letter; the
fixed name was corrected to `mining_d01_static_lakehouse`. The next Apply
created workspace items but stopped on Data Agent definition readback; a
subsequent read-only inventory reports four workspace items. Do not retry
Apply until the existing definitions are reconciled. Rejected creates report
only the HTTP status and Fabric `errorCode`, and Data Agent mismatch
diagnostics report only missing/unexpected part paths, never payloads.

### Failed Verify and blocked stale-draft reconciliation

After PR #101 merged, read-only main Verify run `43836621309` authenticated
successfully but found the source under
`Files/Config/draft/semantic-model-Mining D01 topology semantic model/`,
rather than the generator's legacy `semantic_model-mining-d01-topology/`.
The reported draft contains `datasource.json`, unsupported `fewshots.json`,
and a service-generated `.platform` part. This is path evidence, not an exact
definition capture or proof of unpublished state.

The local generator now uses the documented `semantic-model-` prefix followed
by the source display name verbatim and emits no fewshots, source description,
or source instructions for a semantic-model source. Relationship guidance is
retained in stage `aiInstructions`, and all source elements have stable UUIDs.
This correction has **not** been applied to Fabric. Public Microsoft Learn
references were independently searched and fetched for this correction; the
verified basis and the element-ID documentation discrepancy are described below.
No authenticated Azure/Fabric calls or cloud mutations were made. Offline tests
do not establish live service acceptance or answer quality.

No update/reconciliation write path has been added. Exact definition comparison
still rejects unsupported fewshots, unexpected `.platform` metadata, unknown
parts, and payload differences. The bootstrap never treats matching names or
the historical zero-item inventory as ownership proof. Even a corrected draft
cannot be published through Apply without its matching creation receipt.

The original authorized Apply's tmpfs-only receipts are gone. Before a narrowly
scoped repair can be reviewed, a separately authorized read-only investigation
must privately capture:

- The exact isolated workspace, Data Agent item ID/type/name, and bound semantic
  model ID/workspace; name matching alone is insufficient.
- The complete current definition, including `.platform`, with a frozen exact
  legacy preimage/hash and documented treatment of service-owned metadata.
  The reported paths alone do not prove which payloads the service retained.
- Authoritative unpublished state, including absence of published configuration,
  plus resolution of any outstanding create/update/publish operations.
- An explicitly reviewed recovery/ownership authorization bound to those exact
  IDs and preimage, because the lost receipt cannot be reconstructed from a
  prior empty inventory.

Only then can a repair implement an explicit Apply gate and a durable private
write-ahead receipt recording exact target, preimage and replacement hashes,
attempt and operation state **before** mutation. It must recheck the guards
immediately before updating, read back the corrected definition, recognize an
already-correct result without repeating writes, and block uncertain outcomes
rather than retry blindly. Publishing requires separate verified ownership and
authorization; it must not be used to discover whether a repair worked.
Do not fabricate a receipt, delete/recreate the item, broadly ignore unknown
parts, or dispatch Apply to bypass this blocker.

## Existing private agent

The private, published `mining-d01-topology-dataagent` uses the existing DirectLake
semantic model, not the public cockpit assistant. It describes **static catalog
topology**, not live telemetry. It does not provide an anonymous bridge.

- Workspace: `db05aacb-bd7c-405a-a19b-90cc1c67d87b`
- Data agent: `77228112-cefb-448c-b054-79c1cd7a12b2`
- Semantic model: `34a2e63a-f3d3-4d8f-8d26-58f298d876be`
- Published MCP endpoint:
  `https://api.fabric.microsoft.com/v1/mcp/workspaces/db05aacb-bd7c-405a-a19b-90cc1c67d87b/dataagents/77228112-cefb-448c-b054-79c1cd7a12b2/agent`

## Reproduce the definition

The definition generator selects the twelve model tables and their columns,
exposes model measures, and retains line-to-plant guidance in its instructions.
It emits exactly these three JSON parts:

- `Files/Config/data_agent.json`
- `Files/Config/draft/stage_config.json`
- `Files/Config/draft/semantic-model-Mining D01 topology semantic model/datasource.json`

The folder prefix is `semantic-model-`, while the datasource and element type
values remain `semantic_model` and `semantic_model.*`. Spaces and capitalization
in the source display name are preserved. Semantic-model sources do not support
source descriptions, source instructions, or example queries, so
`userDescription`, `dataSourceInstructions`, `fewshots.json`, and embedded
fewShots/query replacements are omitted. The generator does not manufacture
`.platform` or published parts. It only generates JSON; it never creates,
updates, or publishes an item.

```powershell
$workspace = 'db05aacb-bd7c-405a-a19b-90cc1c67d87b'
$model = '34a2e63a-f3d3-4d8f-8d26-58f298d876be'
$definition = & .\scripts\fabric\New-MiningDataAgentDefinition.ps1 -WorkspaceId $workspace -SemanticModelId $model
```

### Verified Microsoft Learn basis

The following official references were searched and fetched on 2026-11-16:

- [Add and configure data sources — Semantic Model supported configurations](https://learn.microsoft.com/fabric/data-science/data-agent-add-datasources#configure-your-data-source)
  explicitly supports agent instructions but not data-source instructions,
  data-source descriptions, or example queries for semantic models. The generic
  definition schema's optional fields do not override this source-specific
  support matrix.
- [Data Agent definition](https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/data-agent-definition)
  documents the named source-folder structure, `$schema: 2.1.0` for the agent,
  `$schema: 1.0.0` for the datasource and stage, the `semantic_model` /
  `semantic_model.*` types, and the required stage `aiInstructions`. Those
  schema values and source-selection fields are retained.
- [Semantic model best practices — Prep for AI](https://learn.microsoft.com/fabric/data-science/semantic-model-best-practices#prep-for-ai-make-semantic-model-ai-ready)
  says agent instructions are not passed to the DAX generation tool.
  Line/plant relationship context remains in the supported stage field for
  agent-level interpretation, not as a claim that it configures DAX joins.
  Query-engine-specific instructions and Verified Answers belong in the
  semantic model's Power BI **Prep for AI**, which this local fix does not
  configure.

#### Required element IDs versus the incomplete example

The definition reference's **DataSourceElement** property table explicitly
requires `id` of type `string(uuid)`, while its warehouse example omits element
IDs (and even omits a column's required `is_selected`). The example is therefore
not evidence that required fields may be omitted. This generator follows the
explicit property contract: all 12 tables, 36 columns, and 14 measures have
nonempty, distinct UUIDs as well as `display_name`, `type`, and `is_selected`.

The reference does not prescribe an ID-generation algorithm or describe these
IDs as semantic-model lineage tags. Our local choice is deterministic UUIDv5
in the standard URL namespace, using
`mining-d01-data-agent-elements/v1/{workspaceId}/{semanticModelId}/{elementPath}`.
Paths include the kind and parent table (`table/Plant`,
`column/Line/parent_id`, `measure/Plant/Plant count`), preventing repeated column
names from sharing IDs. Identical target/path inputs retain their IDs; changing
the target changes them. Tests check all 62 UUIDs, uniqueness, repeatability,
target scoping, and independently calculated UUIDv5 vectors. These are
definition-local identifiers, not invented cloud item IDs or evidence about
the stale draft's actual preimage. Any service normalization still requires
separately authorized readback; comparison and reconciliation remain fail-closed.

### Authorized submission boundary

For a new Mining-owned item, submit this definition with a unique display name
using the [create Data Agent API](https://learn.microsoft.com/rest/api/fabric/dataagent/items/create-data-agent).
For the specific existing **private** Mining item, an authorized operator can
submit it to
the [update definition API](https://learn.microsoft.com/rest/api/fabric/dataagent/items/update-data-agent-definition).
**Update replaces the item definition**: verify the workspace and item IDs first;
never apply it to a TriTwin agent. This is not a recovery procedure for the
isolated stale draft above, which remains blocked. Follow the returned
long-running operation to success, inspect the saved definition, then use the
[publish API](https://learn.microsoft.com/rest/api/fabric/dataagent/items/publish-data-agent).
Do not treat item creation or publish as proof that questions work.

Use the current authorized Azure CLI identity, a Fabric-audience token held only in
memory, and a workspace role permitted to create or update the item. These APIs
require the appropriate delegated scopes. Do not copy tokens to files or logs.

## Query and observed evidence

With Python 3.10+ and the `mcp` Python package installed, authenticate the Azure CLI
to the intended tenant and run:

```powershell
python .\scripts\fabric\query-mining-data-agent.py --workspace db05aacb-bd7c-405a-a19b-90cc1c67d87b --agent 77228112-cefb-448c-b054-79c1cd7a12b2 "What are the names of the production lines and which plant do they belong to?"
```

The client uses the documented Fabric MCP handshake and current Azure CLI identity;
it does not save tokens. It reports MCP errors instead of treating them as answers.
Check answers against the source rather than relying on a successful tool call.

On 2026-11-15, the published agent returned 1 plant, 4 lines, 24 modules, 64
equipment items, 56 tags, 50 streams and 248 catalog relationship rows for three
separate count questions. For the line-to-plant question it returned A, B, C and
shared, all under **Diamond recovery / three-line plant** (D01). Independently
executed Power BI `executeQueries` DAX against the semantic model returned those
four lines and plant mapping; the DAX example in the old definition was also
executed against that model. That historical query check does not establish
support for semantic-model fewshots; the corrected generator omits them.
The MCP response provides answer text, not the generated DAX,
so that independent query establishes source ground truth rather than proving the
agent's internal query provenance. Before exposing the relevant columns and adding
the tested example, the same native question incorrectly returned no data. These
are observations, not a guarantee of accuracy for other prompts.

## Identity and bridge boundary

Microsoft's [service-principal preview guidance](https://learn.microsoft.com/fabric/data-science/data-agent-service-principal)
documents direct service-principal calls for semantic-model-backed agents, but
requires workspace access and prescribes Member or Contributor, plus source read
access and the tenant setting for Fabric APIs. Managed identities are not supported
for this authentication and KQL-connected agent service-principal calls are not
supported. The existing Contributor assignment is scoped to the isolated
workspace; native source access and agent queries have not been tested. A safe
anonymous bridge is therefore **not verified**.

The legacy Foundry Fabric data-agent tool is documented as deprecated in favor of
[Fabric IQ](https://learn.microsoft.com/azure/foundry/agents/how-to/tools/fabric-iq).
That guidance distinguishes Foundry connection OAuth/user identity from direct
MCP client service-principal access. Do not assume a Foundry wrapper can use an
anonymous caller or transfer a delegated user token.
