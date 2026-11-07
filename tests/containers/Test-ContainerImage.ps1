#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('simulator', 'cockpit', 'streaming-backend', 'mcp-tools', 'console')]
    [string]$App,
    [Parameter(Mandatory)]
    [ValidatePattern('^local/(simulator|cockpit|streaming-backend|mcp-tools|console):[a-f0-9]{40}$')]
    [string]$Image
)

$ErrorActionPreference = 'Stop'
if ($Image -cnotmatch "^local/${App}:") { throw 'Image repository must match the selected app.' }
$inspection = docker image inspect $Image
if ($LASTEXITCODE -ne 0) { throw 'Image inspection failed.' }
$metadata = ($inspection | ConvertFrom-Json)[0]
if ($metadata.Config.User -cne 'node' -or $metadata.Os -cne 'linux' -or $metadata.Architecture -cne 'amd64') {
    throw 'Expected a non-root Linux amd64 production image.'
}
$assertProduction = @'
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
assert.notEqual(process.getuid(), 0);
assert.equal(process.env.NODE_ENV, 'production');
assert.ok(existsSync('dist/index.js'));
const require = createRequire(import.meta.url);
for (const dependency of ['typescript', 'vitest']) {
  assert.throws(() => require.resolve(dependency), { code: 'MODULE_NOT_FOUND' });
}
assert.ok(!existsSync('/workspace/.git'));
assert.ok(!existsSync('/workspace/.env'));
await import('./dist/index.js');
'@
docker run --rm --network none --entrypoint node $Image --input-type=module -e $assertProduction
if ($LASTEXITCODE -ne 0) { throw "Production dependency/import checks failed for $App." }

if ($App -eq 'simulator') {
    docker run --rm --network none $Image
    if ($LASTEXITCODE -ne 0) { throw 'Simulator default entry point failed.' }
    Write-Host 'Simulator library and default entry point verified; no simulation job started.'
    return
}

$ports = @{ cockpit = 3300; 'streaming-backend' = 3000; 'mcp-tools' = 3100; console = 3200 }
$container = docker run --detach --network none $Image
if ($LASTEXITCODE -ne 0) { throw "Could not start $App." }
try {
    $probe = @'
import assert from 'node:assert/strict';
const [app, port] = process.argv.slice(1);
const base = `http://127.0.0.1:${port}`;
let response;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
    break;
  } catch (error) {
    if (attempt === 29) throw error;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), { status: 'ok', service: app });
if (app === 'cockpit') {
  for (const route of ['/', '/app.js', '/styles.css', '/vendor/powerbi.js']) {
    const asset = await fetch(`${base}${route}`);
    assert.equal(asset.status, 200, route);
    assert.ok((await asset.text()).length > 0, route);
  }
}
'@
    docker exec $container node --input-type=module -e $probe $App ([string]$ports[$App])
    if ($LASTEXITCODE -ne 0) {
        docker logs $container
        throw "Runtime health/assets checks failed for $App."
    }
    Write-Host "$App production entry point and health response verified."
}
finally {
    docker rm --force $container
    if ($LASTEXITCODE -ne 0) { throw "Could not remove test container $container." }
}
