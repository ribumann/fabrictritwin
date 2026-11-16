"""Read-only, memory-only proof for the one isolated Mining legacy DataAgent.

No mutation methods, CLI login, dynamic code execution, receipts, or exports.
Only main() authenticates; prove() accepts an injected read-only transport.
"""

import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import time
import urllib.parse
import urllib.request
import uuid


WORKSPACE = "4a809e56-42a8-4c30-a84f-83a47dd8793f"
TENANT = "ecd6dfda-d2ce-47a8-9901-e35f31fe18dd"
PRINCIPAL = "da635b23-84db-4fe1-a9d2-0204c830a87b"
APPLICATION = "40eca1a3-d05c-4cdf-9770-b59969b4fff2"
AGENT_NAME = "mining-d01-topology-dataagent"
MODEL_NAME = "mining-d01-topology-semanticmodel"
RESOURCE = "https://api.fabric.microsoft.com"
BASE = f"{RESOURCE}/v1/workspaces/{WORKSPACE}"
SOURCE_FOLDER = "Files/Config/draft/semantic-model-Mining D01 topology semantic model/"
OLD_FOLDER = "Files/Config/draft/semantic_model-mining-d01-topology/"
PLATFORM_SCHEMA = (
    "https://developer.microsoft.com/json-schemas/fabric/"
    "gitIntegration/platformProperties/2.0.0/schema.json"
)
LEGACY_COMMIT = "d269dbd419cecac649bfa9cd06747098048a6544"
LEGACY_BLOB = "dc6e254d35b5cc1671c62ac4ce4f16190bce5a92"
LEGACY_SOURCE_SHA256 = "414a1fb67f6ced4edbec26d263a5be4c8676d32950e4cbf429a863ef77b2e5c1"
# Digest of the decoded, zero-target snapshot below, not of a live definition.
SNAPSHOT_SHA256 = "da00e12805ac678610c7dfc8050aa615be5851a4be2cfa14818f399b37163742"
SNAPSHOT = Path(__file__).with_name("fixtures") / "mining-agent-legacy-d269dbd.json"
ZERO = "00000000-0000-0000-0000-000000000000"
MAX_BYTES = 2_000_000
MAX_PAGES = 10
MAX_ITEMS = 1_000
MAX_POLLS = 10


class ProofFailure(Exception):
    """Deliberately contains no provider data."""


def require(condition):
    if not condition:
        raise ProofFailure()


def guid(value, allow_zero=False):
    require(isinstance(value, str))
    require(re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", value))
    require(str(uuid.UUID(value)) == value and (allow_zero or value != ZERO))
    return value


def strict_json(text):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result)
            result[key] = value
        return result

    def reject_constant(_value):
        raise ProofFailure()

    require(isinstance(text, (str, bytes)) and len(text) <= MAX_BYTES)
    if isinstance(text, bytes):
        text = text.decode("utf-8", errors="strict")
    value = json.loads(text, object_pairs_hook=unique, parse_constant=reject_constant)

    def depth(item, level=0):
        require(level <= 64)
        if isinstance(item, dict):
            for child in item.values():
                depth(child, level + 1)
        elif isinstance(item, list):
            for child in item:
                depth(child, level + 1)

    depth(value)
    return value


def canonical(value):
    # Ignore JSON whitespace/property order only, not array order, types, or values.
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def expected_legacy(model_id):
    # Git's LF fixture is also readable in an existing Windows CRLF worktree.
    raw = SNAPSHOT.read_bytes().replace(b"\r\n", b"\n")
    require(hashlib.sha256(raw).hexdigest() == SNAPSHOT_SHA256)
    snapshot = strict_json(raw)
    require(snapshot["provenance"] == {
        "commit": LEGACY_COMMIT,
        "generatorBlob": LEGACY_BLOB,
        "generatorSha256": LEGACY_SOURCE_SHA256,
    })
    files = copy.deepcopy(snapshot["files"])
    source = files[OLD_FOLDER + "datasource.json"]
    require(source["workspaceId"] == ZERO and source["artifactId"] == ZERO)
    source["workspaceId"], source["artifactId"] = WORKSPACE, guid(model_id)
    # The only service normalization accepted by this proof.
    for leaf in ("datasource.json", "fewshots.json"):
        files[SOURCE_FOLDER + leaf] = files.pop(OLD_FOLDER + leaf)
    return files


def result_template():
    return dict.fromkeys((
        "Authenticated", "WorkspaceMatched", "InventoryComplete", "TargetsUnique",
        "LegacyProvenanceMatched", "BindingMatched", "UnpublishedPartsOnly",
        "PlatformValid", "LegacyPayloadsMatched",
        "ProofPassed", "OutstandingOperationsProvenClear", "RecoverySafe",
    ), False) | {"Pages": 0, "Items": 0, "Parts": 0}


def inventory(read, result):
    workspace = read("GET", BASE)
    require(isinstance(workspace, dict) and workspace.get("id") == WORKSPACE)
    result["WorkspaceMatched"] = True
    url, seen_tokens, seen_ids, items = BASE + "/items", set(), set(), []
    for page_number in range(1, MAX_PAGES + 1):
        page = read("GET", url)
        require(isinstance(page, dict) and isinstance(page.get("value"), list))
        require(len(items) + len(page["value"]) <= MAX_ITEMS)
        for item in page["value"]:
            require(isinstance(item, dict) and item.get("workspaceId") == WORKSPACE)
            item_id = guid(item.get("id"))
            require(item_id not in seen_ids)
            require(isinstance(item.get("type"), str) and bool(item["type"]))
            require(isinstance(item.get("displayName"), str) and bool(item["displayName"]))
            seen_ids.add(item_id)
            items.append(item)
        result["Pages"], result["Items"] = page_number, len(items)
        token, uri = page.get("continuationToken"), page.get("continuationUri")
        if token is None or token == "":
            require(uri is None or uri == "")
            result["InventoryComplete"] = True
            return items
        require(isinstance(token, str) and 0 < len(token) <= 8192)
        require(all(ord(char) > 32 for char in token))
        require(token not in seen_tokens and bool(page["value"]))
        seen_tokens.add(token)
        url = BASE + "/items?continuationToken=" + urllib.parse.quote(token, safe="")
        # Never follow provider-supplied URLs, including same-host substitutions.
        require(uri is None or uri == "" or uri == url)
    raise ProofFailure()


def platform_valid(value, agent):
    require(isinstance(value, dict))
    require(set(value) == {"$schema", "metadata", "config"})
    require(value["$schema"] == PLATFORM_SCHEMA)
    metadata, config = value["metadata"], value["config"]
    require(isinstance(metadata, dict) and isinstance(config, dict))
    require({"type", "displayName"} <= set(metadata) <= {"type", "displayName", "description"})
    require(metadata["type"] == agent["type"] == "DataAgent")
    require(metadata["displayName"] == agent["displayName"] == AGENT_NAME)
    if "description" in metadata:
        require(metadata["description"] == "Static Mining D01 topology catalog, not live telemetry.")
    require(set(config) == {"version", "logicalId"} and config["version"] == "2.0")
    guid(config["logicalId"])
    # logicalId is a Git cross-workspace ID, NOT the Fabric item ID. Association
    # comes from retrieving this definition using the uniquely resolved item ID.


def definition_parts(definition):
    require(isinstance(definition, dict) and isinstance(definition.get("parts"), list))
    require(0 < len(definition["parts"]) <= 20)
    require(set(definition) <= {"format", "parts"})
    if "format" in definition:
        require(definition["format"] == "JSON")
    parts = {}
    for part in definition["parts"]:
        require(isinstance(part, dict) and set(part) == {"path", "payload", "payloadType"})
        path, payload = part["path"], part["payload"]
        require(isinstance(path, str) and path not in parts)
        require(part["payloadType"] == "InlineBase64" and isinstance(payload, str))
        require(0 < len(payload) <= MAX_BYTES)
        parts[path] = base64.b64decode(payload, validate=True)
    require(sum(map(len, parts.values())) <= MAX_BYTES)
    return parts


def prove(read, authenticated=False):
    """Returns ONLY fixed booleans/counts. All errors, including injected ones, are suppressed."""
    result = result_template()
    result["Authenticated"] = bool(authenticated)
    try:
        items = inventory(read, result)
        agents = [i for i in items if i["type"] == "DataAgent" and i["displayName"] == AGENT_NAME]
        models = [i for i in items if i["type"] == "SemanticModel" and i["displayName"] == MODEL_NAME]
        require(len(agents) == len(models) == 1)
        agent, model = agents[0], models[0]
        require(agent["id"] != model["id"])
        result["TargetsUnique"] = True
        expected = expected_legacy(model["id"])
        result["LegacyProvenanceMatched"] = True
        definition = read("POST", BASE + f"/dataAgents/{agent['id']}/getDefinition")
        parts = definition_parts(definition["definition"])
        result["Parts"] = len(parts)
        require(not any(p.startswith("Files/Config/published/") or
                        p == "Files/Config/publish_info.json" for p in parts))
        result["UnpublishedPartsOnly"] = True
        require(set(parts) == set(expected) | {".platform"})
        source = strict_json(parts[SOURCE_FOLDER + "datasource.json"])
        require(source.get("workspaceId") == WORKSPACE and source.get("artifactId") == model["id"])
        result["BindingMatched"] = True
        platform_valid(strict_json(parts[".platform"]), agent)
        result["PlatformValid"] = True
        for path, value in expected.items():
            require(canonical(strict_json(parts[path])) == canonical(value))
        result["LegacyPayloadsMatched"] = True
        result["ProofPassed"] = True
    except Exception:
        pass
    # Neither a snapshot nor a definition-retrieval LRO proves absence of other
    # operations/writers. A successful proof is NOT a recovery authorization.
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def http_json(method, url, bearer=None, form=None):
    """Bounded HTTP, no redirects, no logging, no provider errors escaping main."""
    headers = {"Accept": "application/json"}
    if bearer is not None:
        headers["Authorization"] = "Bearer " + bearer
    data = None
    if form is not None:
        data = urllib.parse.urlencode(form).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    request = urllib.request.Request(url, headers=headers, data=data, method=method)
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open(request, timeout=30) as response:
        raw = response.read(MAX_BYTES + 1)
        require(len(raw) <= MAX_BYTES)
        value = strict_json(raw) if raw else None
        require(value is None or isinstance(value, dict))
        return response.status, {k.lower(): v for k, v in response.headers.items()}, value


def oidc_access_token(env):
    require(env.get("GITHUB_REPOSITORY") == "ribumann/fabrictritwin")
    require(env.get("GITHUB_REF") == "refs/heads/main")
    require(env.get("GITHUB_EVENT_NAME") == "workflow_dispatch")
    require(env.get("GITHUB_WORKFLOW_REF") ==
            "ribumann/fabrictritwin/.github/workflows/mining-legacy-agent-proof.yml@refs/heads/main")
    url = env["ACTIONS_ID_TOKEN_REQUEST_URL"]
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == "https" and parsed.port in (None, 443))
    require(parsed.hostname and parsed.hostname.endswith(".actions.githubusercontent.com"))
    require(not parsed.username and not parsed.password and not parsed.fragment)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    require(not any(k == "audience" for k, _ in query))
    query.append(("audience", "api://AzureADTokenExchange"))
    url = urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(query)))
    status, _, oidc = http_json("GET", url, bearer=env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"])
    require(status == 200 and isinstance(oidc.get("value"), str))
    status, _, access = http_json(
        "POST", f"https://login.microsoftonline.com/{TENANT}/oauth2/v2.0/token",
        form={"client_id": APPLICATION, "scope": RESOURCE + "/.default",
              "grant_type": "client_credentials",
              "client_assertion_type": "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
              "client_assertion": oidc["value"]},
    )
    require(status == 200 and isinstance(access.get("access_token"), str))
    token = access["access_token"]
    segments = token.split(".")
    require(len(segments) == 3)
    claims = strict_json(base64.urlsafe_b64decode(segments[1] + "=" * (-len(segments[1]) % 4)))
    require(claims.get("tid") == TENANT and claims.get("oid") == PRINCIPAL)
    require(claims.get("appid", claims.get("azp")) == APPLICATION and "scp" not in claims)
    require(claims.get("aud") in (RESOURCE, RESOURCE + "/"))
    require(type(claims.get("exp")) is int and claims["exp"] > time.time() + 60)
    # Identity sanity check only; Fabric verifies the token's signature.
    return token


class FabricReads:
    """URL/method allowlist. Only getDefinition is POST; it has no request body."""

    def __init__(self, token, send=http_json, sleep=time.sleep):
        self.token, self.send, self.sleep = token, send, sleep
        self.operations = set()

    def request(self, method, url):
        allowed = method == "GET" and (url == BASE or url == BASE + "/items" or
            (url.startswith(BASE + "/items?continuationToken=") and
             re.fullmatch(r"(?:[A-Za-z0-9_.~-]|%[0-9A-F]{2})+",
                          url.split("?continuationToken=", 1)[1]) is not None))
        allowed |= method == "POST" and re.fullmatch(
            re.escape(BASE) +
            r"/dataAgents/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/getDefinition",
            url) is not None
        allowed |= method == "GET" and any(
            url in (f"{RESOURCE}/v1/operations/{op}", f"{RESOURCE}/v1/operations/{op}/result")
            for op in self.operations)
        require(allowed)
        return self.send(method, url, bearer=self.token)

    @staticmethod
    def retry_after(headers):
        value = headers.get("retry-after", "")
        require(isinstance(value, str) and re.fullmatch(r"\d{1,2}", value) is not None)
        seconds = int(value)
        require(0 <= seconds <= 30)
        return seconds

    def __call__(self, method, url):
        status, headers, body = self.request(method, url)
        if status == 200:
            require(isinstance(body, dict))
            return body
        require(method == "POST" and status == 202)
        operation = guid(headers.get("x-ms-operation-id"))
        self.operations.add(operation)
        delay = self.retry_after(headers)
        for _attempt in range(MAX_POLLS):
            self.sleep(delay)
            status, headers, body = self.request("GET", f"{RESOURCE}/v1/operations/{operation}")
            require(status == 200 and isinstance(body, dict))
            if body.get("status") == "Succeeded":
                status, _, body = self.request("GET", f"{RESOURCE}/v1/operations/{operation}/result")
                require(status == 200 and isinstance(body, dict))
                return body
            require(body.get("status") in ("NotStarted", "Running"))
            delay = self.retry_after(headers)
        raise ProofFailure()


def main():
    result = result_template()
    try:
        # No args/targets/tokens may be supplied on the command line.
        import sys
        require(len(sys.argv) == 1)
        token = oidc_access_token(os.environ)
        result = prove(FabricReads(token), authenticated=True)
    except Exception:
        pass
    print(json.dumps(result, sort_keys=True))
    return 0 if result["Authenticated"] and result["ProofPassed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
