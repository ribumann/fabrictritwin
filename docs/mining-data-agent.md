# Mining D01 native data agent

## Isolated Mining workspace preparation

The approved isolated workspace is `4a809e56-42a8-4c30-a84f-83a47dd8793f`.
`scripts/fabric/Prepare-IsolatedMiningDataAgent.ps1` prepares only the pinned
public repository catalog and the static model definition for a supplied
Lakehouse ID. When a real model ID is supplied, it also generates the agent
definition bound to that workspace and model. It does not create a Lakehouse,
model or agent, publish anything, or validate an agent response.

```powershell
$prepared = .\scripts\fabric\Prepare-IsolatedMiningDataAgent.ps1 `
  -LakehouseId '<isolated-lakehouse-guid>' -SemanticModelId '<isolated-model-guid>'
```

After an authorized operator creates a schema-enabled Lakehouse in the isolated
workspace, the existing catalog loader can verify or materialize its twelve
tables through this wrapper. Set `$targetFile` to an exact target JSON containing
`TenantId`, `SubscriptionId`, `WorkspaceId`, `StaticLakehouseId`, `SourceSchema`
(`dbo`), `CallerObjectId`, `SqlEndpointId`, `SqlServer` and `SqlDatabase`.
Resolve these from the isolated Lakehouse, not the shared workspace. The
receipt must be an absolute path in an existing private directory.

```powershell
.\scripts\fabric\Prepare-IsolatedMiningDataAgent.ps1 -LakehouseId '<isolated-lakehouse-guid>' `
  -Mode CatalogApply -TargetPath $targetFile -ReceiptPath $newPrivateReceipt
.\scripts\fabric\Prepare-IsolatedMiningDataAgent.ps1 -LakehouseId '<isolated-lakehouse-guid>' `
  -Mode CatalogVerify -TargetPath $targetFile -ReceiptPath $newPrivateReceipt
```

Apply performs cloud writes; it is not run by generation. It refuses an existing
receipt and verifies existing table contents instead of overwriting them.
Reconcile uncertain operations before using a new receipt. See
[catalog-only loading](../scripts/mining-ontology/README.md#catalog-only-loading)
for permissions, verification, and failure handling.

Model and agent creation, agent publish, and their repeatable reconciliation are
not implemented by this wrapper. The existing analytics deployment script also
creates a report and requires a signed-in user, so it is not an unattended
service-principal bootstrap. The documented Data Agent create and publish APIs
below do not by themselves establish that this definition is accepted or that
the resulting agent answers correctly.

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
supported. We did not grant the public app a workspace role or test a service
principal here. A safe anonymous bridge is therefore **not verified**.

The legacy Foundry Fabric data-agent tool is documented as deprecated in favor of
[Fabric IQ](https://learn.microsoft.com/azure/foundry/agents/how-to/tools/fabric-iq).
That guidance distinguishes Foundry connection OAuth/user identity from direct
MCP client service-principal access. Do not assume a Foundry wrapper can use an
anonymous caller or transfer a delegated user token.
