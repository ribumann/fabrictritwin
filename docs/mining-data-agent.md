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
SQL endpoint details need to be copied into it. The script confirms that Azure
CLI is already using that exact service principal in the target tenant and
subscription, obtains a Fabric token in memory, and resolves the Lakehouse SQL
endpoint from Fabric. It never signs in, changes accounts, assigns roles, or
changes capacity.

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
for catalog permissions, verification, and failure handling. The isolated
bootstrap has not been run against Fabric as part of this repository change.

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

The definition generator selects the twelve model tables and their columns, exposes
model measures, and includes a DAX example for line-to-plant mapping. It only
generates JSON; it never creates, updates, or publishes an item.

```powershell
$workspace = 'db05aacb-bd7c-405a-a19b-90cc1c67d87b'
$model = '34a2e63a-f3d3-4d8f-8d26-58f298d876be'
$definition = & .\scripts\fabric\New-MiningDataAgentDefinition.ps1 -WorkspaceId $workspace -SemanticModelId $model
```

For a new Mining-owned item, submit this definition with a unique display name
using the [create Data Agent API](https://learn.microsoft.com/rest/api/fabric/dataagent/items/create-data-agent).
For the specific existing Mining item, an authorized operator can submit it to
the [update definition API](https://learn.microsoft.com/rest/api/fabric/dataagent/items/update-data-agent-definition).
**Update replaces the item definition**: verify the workspace and item IDs first;
never apply it to a TriTwin agent. Follow the returned long-running operation to
success, inspect the saved definition, then use the
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
four lines and plant mapping; the DAX example in the definition was also executed
against that model. The MCP response provides answer text, not the generated DAX,
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
