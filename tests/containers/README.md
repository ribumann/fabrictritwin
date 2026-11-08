# Build-only container validation

`Container images (build only)` is independent of `CI` and the manual deployment
workflow. Every PR (including forks), main push and manual dispatch builds the
four remaining Containerfiles with the repository root as context:

| Local repository | Runtime | Simulator runtime dependency |
| --- | --- | --- |
| `local/simulator` | Job/library, no port | Self |
| `local/cockpit` | HTTP 3300, static UI and Power BI vendor bundle | Yes |
| `local/streaming-backend` | HTTP 3000 | Yes |
| `local/mcp-tools` | HTTP 3100, internal service | No |

Images are tagged with the exact checked-out `github.sha` (the merge revision on
PRs), built for `linux/amd64`, and labelled with that source revision. Checkout is
commit-pinned with persisted credentials disabled. The job requests only
`contents: read` for source checkout; no workflow token is passed to Docker or npm.
Docker uses an empty process-local configuration for anonymous public pulls.
There is no registry login, secret injection, OIDC, protected environment, cache
upload, push, image artifact upload or deployment. Images exist only on the
ephemeral runner. The summary's local config ID is **not** a registry manifest
digest and cannot be used as the deployment workflow's approved ACR digest.

All build, production-dependency and runtime stages use the same pinned public
Node 24 Alpine multi-platform index digest. `npm ci` uses the committed root
lockfile and all four remaining workspace manifests; production installs omit dev
dependencies. Cockpit and backend compile and package Simulator before their
own runtime code. To update Node, resolve and review the public index digest,
replace all 15 `FROM` references together, and require this workflow to pass.
Dependency updates must update the root lockfile and pass CI. Pinning inputs makes
rebuilds reproducible in dependency selection, not guaranteed byte-identical:
BuildKit/npm/platform tooling and file timestamps can still affect image IDs.

The `.dockerignore` is an input allowlist (manifests, TypeScript configuration and
source/static assets only), followed by secret/local-state exclusions. The context
job exports Docker's **actual** filtered context using a scratch image and asserts
both required inputs and forbidden paths, including synthetic root/nested env/key
probes. Never store credentials in application source; extension exclusions are
defence in depth, not a content-aware secret scanner.

Each built production image is tested as the non-root `node` user with no external
network: production imports must resolve, TypeScript/Vitest must be absent, each
HTTP entry point must return its exact `/healthz` service response, and Cockpit's
packaged static/vendor assets must be served. Simulator is imported and its
default no-op library entry point is run; no daily generation, telemetry or cloud
job is invoked. Backend startup requires three OneLake settings even for health
checks: the test container receives synthetic workspace/lakehouse names and an
`example.invalid` URL, never credentials or a real target. Network isolation is
still enforced. Existing full credential-free unit tests remain in `CI`. These
checks prove image packaging/startup, not live Azure/Fabric integration.

For a local Linux/amd64 Docker daemon, from the repository root:

```powershell
./tests/containers/Test-BuildContext.ps1
$revision = git rev-parse HEAD
bash ./scripts/deploy/build-container-image.sh cockpit $revision "local/cockpit:$revision"
./tests/containers/Test-ContainerImage.ps1 -App cockpit -Image "local/cockpit:$revision"
```

The separately gated publication workflow reuses this build helper, context
verification and smoke test. See [the publication contract](../../scripts/deploy/README.md)
for its protected environment, read-only identity preflight, permissions and
digest handoff. Passing this build-only workflow neither enables publishing nor
authorizes live deployment.
