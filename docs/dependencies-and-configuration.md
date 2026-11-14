# Dependencies, configuration, identities, and cloud resources

This inventory describes dependencies visible in the checked-in application,
infrastructure templates, and scripts. It is not an inventory of any live tenant
or a promise that every optional Microsoft preview feature is available in every
region. Names and identifiers are supplied by each operator; no tenant, account,
subscription, endpoint, or credential is preconfigured here.

The repository includes an account-free **local** synthetic demo. Hosted/live
application paths still require the operator's Azure, Fabric, Entra, and (for
selected features) Power BI or Foundry resources.

## Runtime profiles

| Profile | Dependencies |
|---|---|
| Local development and mock/unit tests | Node.js 24+, npm, PowerShell 7, and Pester 5.6.1 for PowerShell tests. No Azure credentials are needed for the documented credential-free build and tests. |
| Live Azure/Fabric application | An Azure subscription and Entra tenant; Fabric capacity and workspace; deployed Container Apps, identities, registry, logging and Key Vault resources; Fabric items and the operator-supplied runtime connections described below. |
| Live assistant and report enhancements | Foundry project/model and configured connections for the assistant; Power BI workspace/report/model and a dedicated embedding service principal for embedded reports. Human sign-in and tenant/admin consent are required for specific delegated Fabric paths. These features are not required for local unit tests. |

The `location`, `fabricLocation`, and `foundryLocation` Bicep defaults are
independent examples, not universal availability guarantees. Confirm service,
model, capacity, and preview-feature availability in the chosen tenant and
regions before deployment.

For live freshness checks and operator-controlled recovery, see
[Live runtime operations](live-runtime-operations.md).

## Configuration inventory

Mining has a separate Fabric streaming profile and default-off backend
publisher, read, start, cancel, and run-coordination paths. Provision its
Eventstream, Eventhouse, and KQL database with
`provision-fabric-items.ps1 -Profile MiningStreaming`; apply the mining KQL
definitions separately with `scripts/fabric/apply-mining-definitions.ps1`.
These paths do not share the triathlon Eventstream or database, and the main
application deployment does not enable them. See the
[mining configuration and permission contract](mining-run-coordination.md) and
[mining readiness evidence](release-architecture.md#isolated-d01-mining-path-readiness-gated).

Cockpit's live **Direct MCP Query** panel formats JSON-RPC responses, SSE event
messages, and JSON text content as labeled summaries and tables. It keeps every
returned array and nested field, displays reported errors without inferring
athlete health, and adds units only for known tool fields. Timestamps use the
browser's locale; date-only strings remain unchanged. The expandable **Raw
response** preserves the received body for diagnostics. Readable previews are
limited to 100 rows/items/fields per section, 1,000 values, 12 nesting levels,
and 2,000 characters per text value; omitted content remains in the raw response.
This is presentation only: endpoints, authentication, and synthetic-profile
availability are unchanged.

The deployment entry point is `infra/bicep/main.bicep`; its modules and the
PowerShell scripts are the authoritative configuration interface. Script
parameters are declared in each script's `param` block. Pass a tenant and
subscription explicitly to provisioning commands; do not rely on the current
Azure CLI default account.

### Runtime settings

The table lists settings read by the application or supplied to it by deployment
templates/scripts. A setting absent from a local process may use the stated
default or make that live feature unavailable. Do not copy real values into
tracked `.env` files, issue comments, or logs.

| Setting(s) | Purpose and handling |
|---|---|
| `PORT` | Listener port; source defaults are 3000 (backend), 3100 (MCP tools), and 3300 (Cockpit). |
| `AZURE_CLIENT_ID` | Selects the workload's user-assigned managed identity in Azure. It is an identifier, not a credential. Local development may use the Azure Identity default credential chain. |
| `KEY_VAULT_URI` | URI passed to workloads by Bicep. Current app source does not retrieve secrets from Key Vault; do not assume it is the runtime secret source. |
| `SIMULATOR_ENVIRONMENT`, `SIMULATOR_MODE` | Select the logical simulator environment and daily-generation mode. The cloud schedule is opt-in and disabled by default. |
| `LAKEHOUSE_ONELAKE_ACCOUNT_URL`, `LAKEHOUSE_ONELAKE_FILESYSTEM`, `LAKEHOUSE_ONELAKE_PATH` | OneLake DFS destination used by history seeding. The account URL is the Fabric OneLake service endpoint; filesystem and path identify operator-created items. |
| `FABRIC_WORKSPACE_ID`, `LOAD_HISTORY_NOTEBOOK_ITEM_ID` | Fabric workspace and notebook identifiers used by daily generation. These are configuration identifiers, not credentials. |
| `EVENTSTREAM_EVENTHUB_CONNECTION_STRING` | Fabric Eventstream custom-endpoint SAS connection string. Treat the full value as a secret; Bicep marks the input secure and the runtime stores it as a Container Apps secret. |
| `EVENTHOUSE_QUERY_URI`, `EVENTHOUSE_DATABASE_NAME` | Operator-resolved Kusto query endpoint and database used by the backend and MCP tools. Authenticate with the workload managed identity. |
| `MINING_EVENTSTREAM_EVENTHUB_CONNECTION_STRING`, `MINING_EVENTHOUSE_QUERY_URI`, `MINING_EVENTHOUSE_DATABASE_NAME` | Separate Mining Eventstream SAS and Mining KQL target. The SAS is a secret; the Mining publisher and query paths remain disabled by default until explicitly enabled and configured. |
| `MINING_PUBLISHER_ENABLED`, `MINING_READ_ENABLED`, `MINING_START_ENABLED`, `MINING_CANCEL_ENABLED`, `MINING_RUN_COORDINATION_ENABLED` | Independent, explicit mining runtime gates; absent or false settings keep the corresponding path unavailable. Operator allow-lists, approved run/catalog/profile values, and delegated scopes are specified in the mining contract. |
| `MINING_VIEWER_PRINCIPAL_IDS`, `MINING_START_OPERATOR_PRINCIPAL_IDS`, `MINING_CANCEL_OPERATOR_PRINCIPAL_IDS`, `MINING_START_DELEGATED_SCOPE`, `MINING_CANCEL_DELEGATED_SCOPE` | Mining caller allow-lists and exact delegated scopes. Principal IDs are private identifiers, not credentials; scopes require the applicable Entra API configuration and consent. |
| `MINING_APPROVED_RUN_ID`, `MINING_APPROVED_CATALOG_VERSION`, `MINING_APPROVED_PROFILE_VERSION`, `MINING_CURATED_SOURCE_VERSION`, `MINING_CURATED_QUERY_VERSION`, `MINING_READ_CONFIGURATION_JSON` | Approved run and contract bindings plus the private, independently approved read configuration. Missing or mismatched values fail closed; this JSON contains configuration, not access tokens. |
| `MINING_FINAL_FLUSH_MILLISECONDS`, `MINING_CATALOG_DIR` | Optional bounded publisher flush budget and source-catalog directory; neither grants access or changes readiness. |
| `MINING_STATE_BLOB_ENDPOINT`, `MINING_STATE_CONTAINER`, `MINING_MANAGED_IDENTITY_CLIENT_ID` | Dedicated private Blob run-coordination store and selected user-assigned identity. No connection-string or in-memory fallback is allowed; enabling it requires container-scoped Blob Data Contributor access. |
| `EVENTHOUSE_QUERY_TIMEOUT_MS`, `ALERT_POLL_INTERVAL_MS` | Optional Kusto query timeout and alert polling interval. The application uses bounded defaults for absent or invalid values. |
| `ATHLETE_PRINCIPAL_MAP`, `DEFAULT_ATHLETE_ID` | Non-secret authorization/configuration mapping from authenticated Entra object IDs to the seeded synthetic athlete, and the optional default athlete. Keep real principal IDs private; an empty map fails closed. |
| `STREAMING_BACKEND_BASE_URL`, `STREAMING_BACKEND_SCOPE` | Backend URL and Entra audience scope used by Cockpit service-to-service calls. The deployed URL is generated by Container Apps. |
| `MCP_TOOLS_ALLOWED_HOST`, `ATHLETE_ASSISTANT_MCP_INTERNAL_URL`, `ATHLETE_ASSISTANT_MCP_PROXY_URL` | Internal MCP Host-header validation and the assistant's internal/public MCP bridge URLs. These are generated from the Container Apps environment. |
| `FOUNDRY_PROJECT_ENDPOINT`, `ATHLETE_ASSISTANT_AGENT_NAME`, `ATHLETE_ASSISTANT_MODEL_DEPLOYMENT_NAME`, `ATHLETE_ASSISTANT_FABRIC_PROJECT_CONNECTION_ID`, `ATHLETE_ASSISTANT_MCP_PROJECT_CONNECTION_ID` | Foundry project, agent/model, and project-connection configuration. Connection IDs are identifiers, not secrets. |
| `ASSISTANT_AUTH_TENANT_ID`, `ASSISTANT_AUTH_CLIENT_ID`, `ASSISTANT_AUTH_ALLOWED_CLIENT_ID`, `ASSISTANT_AUTH_BACKEND_CLIENT_ID` | Entra tenant and API/client application identifiers used by Easy Auth and assistant authentication. These IDs are not credentials but are tenant-specific. |
| `ASSISTANT_AUTH_CLIENT_SECRET` | Confidential-client credential used for delegated On-Behalf-Of token exchange. Keep it only in the Container Apps native secret store under the provisioning flow. |
| `ASSISTANT_AUTH_CREDENTIAL_KEY_ID`, `ASSISTANT_AUTH_TOKEN_STORE_EXPIRY_VERSION` | Non-secret credential-rotation and optional token-store renewal metadata written by assistant-auth provisioning. |
| `POWERBI_TENANT_ID`, `POWERBI_CLIENT_ID`, `POWERBI_WORKSPACE_ID`, `POWERBI_REPORT_ID`, `POWERBI_SEMANTIC_MODEL_ID`, `POWERBI_ALLOWED_PRINCIPAL_IDS` | Power BI embedding tenant, service principal, report/model, workspace, and explicit viewer allow-list. Treat user/object IDs as private configuration. |
| `POWERBI_CLIENT_SECRET` | Dedicated Power BI embedding service-principal secret. It is delivered to the Cockpit through a Container Apps secret reference, not a plain environment value. |
| `POWERBI_CREDENTIAL_KEY_ID`, `POWERBI_CONNECTION_ID`, `POWERBI_CONNECTION_NAME`, `POWERBI_CONNECTION_CREDENTIAL_KEY_ID` | Non-secret identifiers/state retained by embedding provisioning to reconcile the dedicated Fabric connection and credential lifecycle. |

### Bicep inputs and script parameters

The main Bicep parameters cover:

- Deployment scope and sizing: `location`, `fabricLocation`, `foundryLocation`,
  `namePrefix`, `tags`, `fabricCapacitySkuName`, `acrSkuName`, `imageTag`, and
  `preservedWorkloads`.
- Human and workload identity configuration:
  `fabricCapacityAdminUpn`, `authClientId`, `foundryUserPrincipalIds`, and
  `operatorPrincipalId`.
- Simulator and Fabric data wiring: `simulatorDailyScheduleCron`,
  `enableSimulatorSchedule`, `simulatorEnvironment`,
  `lakehouseOneLakeAccountUrl`, `lakehouseOneLakeFileSystem`,
  `lakehouseOneLakePath`, `eventstreamEventHubConnectionString`,
  `eventhouseQueryUri`, `eventhouseDatabaseName`, `defaultAthleteId`, and
  `athletePrincipalMapJson`.
- Power BI: `powerBiWorkspaceId`, `powerBiReportId`,
  `powerBiSemanticModelId`, `powerBiClientId`, `powerBiTenantId`,
  `powerBiClientSecret`, `powerBiAllowedPrincipalIds`,
  `powerBiCredentialKeyId`, `powerBiConnectionId`, `powerBiConnectionName`,
  and `powerBiConnectionCredentialKeyId`.
- Assistant wiring: `athleteAssistantFabricProjectConnectionId` and
  `athleteAssistantMcpProjectConnectionId`.

Only `eventstreamEventHubConnectionString` and `powerBiClientSecret` are
`@secure()` main-template inputs. Other identifiers and principal mappings are
not secrets, but may be tenant-specific or personal and should not be published.
The optional `infra/bicep/assistant-auth-token-store.bicep` has separate inputs
for a dedicated storage account/container, an ownership marker, an optional
operator principal, and a narrowly scoped public-network policy exemption.

Provisioning scripts also accept resource names, workspace/item IDs, UPNs,
tenant/subscription IDs, selected users, model and image names, and explicit
feature/consent switches. Inspect each script's help and parameter validation
before use; in particular, `scripts/teardown/teardown-all.ps1` is destructive.

## Credentials and identity

| Credential or identity | Purpose and storage boundary |
|---|---|
| Azure CLI/operator sign-in | Used by provisioning and deployment scripts for Azure Resource Manager, Microsoft Graph, Fabric, and Power BI calls. Tokens are obtained in-process; do not export or paste them. Scripts require an explicitly selected subscription/tenant where supported. |
| Per-workload user-assigned managed identities | Separate identities are created for Streaming Backend, MCP tools, Cockpit, Simulator, provisioning, and Foundry. They are used for Azure resource access, image pulls, and service-to-service authentication; no shared ACR admin password is enabled. |
| Foundry project identity | The project has a system-assigned identity. Runtime connection setup grants only the role/access required by the configured Foundry, Fabric Data Agent, and MCP paths. |
| Entra application registrations | Provisioning creates/configures an Easy Auth API registration and, when assistant OBO is enabled, a dedicated Cockpit confidential client. Power BI embedding uses a separate service principal. Application/client IDs are identifiers; passwords and tokens are secrets. |
| Eventstream SAS | Triathlon uses `EVENTSTREAM_EVENTHUB_CONNECTION_STRING`; Mining requires a distinct `MINING_EVENTSTREAM_EVENTHUB_CONNECTION_STRING`. Each is Fabric-issued and secret. The triathlon secret is stored as a native Container Apps secret for its backend and simulator job; Mining's separate publisher remains disabled until its own secret is configured. The Fabric-managed backing Event Hubs namespace is not created as a visible Azure resource by this repository. |
| Assistant OBO client secrets | Generated through Microsoft Graph and stored as native Container Apps secrets. The user assertion is forwarded only for the On-Behalf-Of exchange; do not log it or app-held access tokens. When the optional Easy Auth token store is enabled, delegated session token state is stored in the dedicated private blob container. The native Fabric Data Agent tool requires a signed-in human and delegated On-Behalf-Of flow; anonymous assistant calls use MCP tools only. |
| Power BI embedding secret | Generated for a dedicated service principal and stored as a Cockpit native Container Apps secret. An expiring embed token is generated for use, not stored as the long-term credential. |
| Optional token-store SAS | When the assistant token-store flow is explicitly configured, a short-lived HTTPS user-delegation SAS is container-scoped and held as a native secret. The dedicated container is private; shared-key access is disabled. |
| Mining run-state access | Mining coordination uses its own private Blob container and the selected backend managed identity, not the assistant token store or SAS. The container and container-scoped `Storage Blob Data Contributor` grant have not been provisioned; both require explicit approval. |
| Key Vault | The main deployment creates a RBAC-enabled vault and assigns Secrets User/Officer roles. The current app source does not read secrets from it; do not assume this vault is populated or used by the runtime. |

Access assignments in the checked-in templates/scripts are scoped rather than
blanket subscription grants: ACR Pull on the registry; Key Vault Secrets User
for designated workloads and Secrets Officer for the provisioning identity
(optionally an operator); Foundry User at the Foundry account/project boundary;
and Fabric workspace/connection roles for specific service principals. The
Power BI setup may assign its service principal workspace Member and connection
User roles. The optional token store grants Storage Blob Delegator only to the
operator who mints user-delegation SAS tokens.

The provisioning scripts can require tenant-approved Microsoft Graph
application permissions such as `Application.ReadWrite.All`, `User.Read.All`,
`DelegatedPermissionGrant.ReadWrite.All`, and `AppRoleAssignment.ReadWrite.All`.
These are setup prerequisites, not credentials to copy into app configuration.
Power BI tenant settings and Fabric preview features require their respective
administrators; the scripts do not silently grant blanket tenant access.

Active GitHub Actions include credential-free CI and image builds, Copilot
setup, manual read-only OIDC proofs, main-only app image publication/deployment,
and the manual Mining state-bootstrap workflow. The read-only proofs establish
only that their specific identity can exchange a token and read its configured
resource group; they do not prove write permissions or Mining Blob access. On
14 November 2026, the `azure-canary` and `azure-deploy` read-only proofs
succeeded for those limited checks. The Mining-specific read-only OIDC proof
must be configured and run separately before granting bootstrap write rights.
Mining bootstrap uses the separate `azure-mining-bootstrap` environment and
requires a dedicated OIDC identity, independent environment protection, and
explicitly reviewed permissions before it can be used. Files under
`.github/disabled-workflows/` are intentionally suffixed `.yml.disabled`, so
GitHub Actions does not run them; do not rename or enable them without a
separate security and target review.

## Network endpoints and exposure

The code uses the following service endpoints; account, tenant, cluster, and
Container Apps names are supplied or resolved at deployment time.

| Endpoint | Use |
|---|---|
| `https://management.azure.com/` | Azure Resource Manager deployments and resource configuration. |
| `https://login.microsoftonline.com/{tenant}` and its v2.0 discovery/keys endpoints | Entra sign-in, token acquisition, issuer validation, and signing keys. |
| `https://graph.microsoft.com/v1.0` | Entra application/service-principal and credential provisioning. |
| `https://api.fabric.microsoft.com/v1` | Fabric workspace/items, capacity assignment, Eventstream, notebook, connection and role APIs. |
| `https://onelake.dfs.fabric.microsoft.com` | OneLake DFS history writes and data paths. |
| `https://{cluster}.{region}.kusto.windows.net` | Operator-supplied Eventhouse/Kusto query endpoint; the workload uses Entra managed identity. |
| `https://{account}.services.ai.azure.com/api/projects/{project}` | Foundry project API and assistant runtime; endpoint is generated from the account/project names. |
| `https://ai.azure.com/.default` | Entra token audience/scope used by the assistant to call Foundry. |
| `https://api.powerbi.com/v1.0/myorg` and `https://app.powerbi.com/reportEmbed` | Power BI report/semantic-model APIs and browser embedding; the service-principal token scope is `https://analysis.windows.net/powerbi/api/.default`. |
| `sb://{namespace}/` in the Eventstream connection string | Fabric Eventstream custom-endpoint telemetry publishing. Triathlon and Mining use separate Fabric-issued SAS connection strings; each is secret. |
| `https://{storage-account}.blob.core.windows.net/{container}` | Optional private assistant token-store endpoint, accessed with a short-lived user-delegation SAS. |
| `https://{storage-account}.blob.core.windows.net/` | Optional private Mining run-coordination account root, accessed by the explicitly selected managed identity; the dedicated container name is configured separately. No private mining-state container or container-scoped role grant has been provisioned. |
| Generated Container Apps HTTPS FQDNs | Cockpit and Streaming Backend use external ingress; the MCP Tool Server has internal-only ingress. The Simulator is a job and has no ingress. |
| `https://registry.npmjs.org`, Docker Hub's `node:24-alpine`, and `mcr.microsoft.com` | Package restore and container image builds. MCR quickstart/Azure CLI images are placeholders for bootstrap; deploy real project images before running workloads. |
| `http://localhost:{3000,3001,3100,3200,3300}` | Local service defaults/health checks; these loopback URLs are not production endpoints. |

The default network design is public-network Azure services with HTTPS service
calls, not a VNet/private-endpoint design. Container Apps' Cockpit ingress allows
anonymous access to its public demo surface; the backend uses Entra Easy Auth.
The MCP app is internal-only. Bicep enables public network access for
Foundry and Key Vault; the optional token-store template also enables the public
network path while keeping blob access private and SAS-scoped. Review these
postures against your organization's network policy before deployment.

## Cloud resources

| Provider | Resources represented in code | Provisioning source and qualification |
|---|---|---|
| Azure | Resource group; Container Apps managed environment; Log Analytics workspace; Azure Container Registry; Cockpit, Streaming Backend and MCP Container Apps; Simulator Container Apps Job; RBAC role assignments; Key Vault; managed identities. | `infra/bicep/main.bicep` and `infra/bicep/modules/*.bicep`; created/updated by `scripts/provision/provision-azure-resources.ps1`. Existing workloads are deliberately preserved and updated by overlay/deployment scripts. |
| Azure AI Foundry | AI Services account, project, model deployment, Foundry account role assignments, and project connections. The account disables local/API-key authentication; the actual prompt-agent definition is created/updated by the backend at runtime. | `infra/bicep/modules/foundry-agent.bicep` and `scripts/provision/configure-runtime-connections.ps1`; model availability, quota, and Fabric tool support are tenant/region dependent. |
| Fabric | Capacity and workspace; triathlon Eventhouse/KQL database/Eventstream; a separate Mining Eventhouse/KQL database/Eventstream and mining-owned raw/curated tables; Lakehouse; notebook; semantic model and report; Fabric Data Agent; and, where enabled/available, Digital Twin Builder, Ontology, and Activator/Reflex items. Mining shares the existing workspace/capacity only, not the triathlon stream or database. | Capacity is in Bicep. `scripts/provision/provision-fabric-items.ps1` provisions the separate Mining items with `-Profile MiningStreaming`; `scripts/fabric/apply-mining-definitions.ps1` applies mining tables, policies, and functions. Preview-dependent items can be skipped when unavailable or disabled by tenant policy. |
| Power BI/Fabric connections | Dedicated embedding service principal, semantic-model connection and report embedding configuration; explicit allowed viewer principal IDs. | `scripts/provision/configure-powerbi-embedding.ps1`; requires an authorized operator and may require separately approved tenant settings. |
| Entra ID | Easy Auth API application, optional assistant confidential client, service principals, callback URIs, delegated consent, and managed/workload service principals. | `scripts/provision/provision-entra-app-registrations.ps1`, `configure-assistant-auth.ps1`, and `configure-runtime-connections.ps1`; Graph permissions and admin consent are required for applicable changes. |
| Optional Azure Storage | Dedicated StorageV2 account and private blob container for assistant delegated-token state, plus an optional narrowly scoped policy exemption. | Separate `infra/bicep/assistant-auth-token-store.bicep`, invoked only by the explicit assistant-auth setup path; not part of the main deployment. |
| Optional Mining run-state storage | Private Blob container for durable Mining coordination in an operator-selected StorageV2 account. The backend requires a container-scoped `Storage Blob Data Contributor` assignment; this state store is distinct from assistant delegated-token storage and is not provisioned or enabled by the main deployment. | Explicit `MINING_STATE_BLOB_ENDPOINT` and `MINING_STATE_CONTAINER` configuration under the contract in `docs/mining-run-coordination.md`; the requested container and scoped role grant remain unprovisioned. |
| Optional integrations | Azure Event Hubs as an alternative Eventstream source; Fabric Operations Agent with Teams channel destination and Power Automate action. | The Event Hubs topology is a fallback template under `infra/fabric/eventstream/`. The Operations Agent configuration is a reference with `shouldRun` disabled and requires operator-supplied IDs and supported portal setup. Neither is provisioned as an always-on integration by the main application deployment; Teams and Power Automate are not called directly by the app. |

The resource list is the deployment footprint defined by this repository, not a
claim that every optional item is created in every run or that a live environment
contains no additional resources. Review `scripts/provision/`, `scripts/deploy/`,
`scripts/fabric/`, `scripts/simulate/`, and `scripts/teardown/` before running
cloud operations. In particular, check exact targets and the impact of teardown
before approving any write or deletion.

## Legacy Console retirement boundary

The legacy Console app, image, Bicep module, and managed-identity wiring are no
longer part of the source deployment. This is a source/configuration retirement,
not evidence that a deployed `$NamePrefix-console` Container App or
`$NamePrefix-id-console` user-assigned identity has been removed. Incremental
Bicep deployments do not delete resources merely because their declarations
were removed. The provisioning scripts no longer discover or update the Console,
and future runs no longer add its callback URI or identity to the desired
backend caller map.
Runtime overlays preserve pre-existing/unknown principal and allowed-caller
entries, and Entra registration updates preserve existing redirect URIs; they do
not automatically prune legacy state.

Before any separate cloud cleanup, an operator must read and confirm the exact
subscription, resource group, name prefix, existing Console app resource ID,
managed-identity resource ID, principal/client IDs, Easy Auth allowed-app entry,
athlete-map entry, and any Console callback URI. Deletion or access changes are
not part of this repository change. If later explicitly approved, remove only
the verified Console app and its dedicated identity, then remove only their
verified caller/map/callback entries. Do not delete or alter the shared Easy Auth
registration, backend or Cockpit identities, backend APIs, operator seeding
scripts, or any unverified principal/callback.
