"""Offline tests: synthetic service responses, no login, cloud, or file output."""

import base64
import contextlib
import copy
import importlib
import io
import json
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "fabric"))
proof = importlib.import_module("mining_legacy_agent_proof")
MODEL = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
AGENT = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"
OTHER = "cccccccc-dddd-4eee-8fff-000000000001"
OPERATION = "dddddddd-eeee-4fff-8000-000000000002"


def part(path, value):
    return {"path": path, "payloadType": "InlineBase64",
            "payload": base64.b64encode(json.dumps(value).encode()).decode()}


def platform():
    return {"$schema": proof.PLATFORM_SCHEMA,
            "metadata": {"type": "DataAgent", "displayName": proof.AGENT_NAME,
                         "description": "Static Mining D01 topology catalog, not live telemetry."},
            "config": {"version": "2.0", "logicalId": OTHER}}


class ProofTests(unittest.TestCase):
    def setUp(self):
        self.items = [
            {"id": MODEL, "workspaceId": proof.WORKSPACE, "type": "SemanticModel",
             "displayName": proof.MODEL_NAME},
            {"id": AGENT, "workspaceId": proof.WORKSPACE, "type": "DataAgent",
             "displayName": proof.AGENT_NAME},
        ]
        self.files = proof.expected_legacy(MODEL)
        self.definition = {"definition": {"parts": [
            *(part(k, v) for k, v in self.files.items()), part(".platform", platform())
        ]}}
        self.pages = [{"value": self.items}]
        self.calls = []
        self.workspace = {"id": proof.WORKSPACE}

    def read(self, method, url):
        self.calls.append((method, url))
        if method == "GET" and url == proof.BASE:
            return self.workspace
        if method == "GET" and url.startswith(proof.BASE + "/items"):
            return self.pages.pop(0)
        self.assertEqual((method, url), ("POST", proof.BASE + f"/dataAgents/{AGENT}/getDefinition"))
        return self.definition

    def run_proof(self):
        # Every subcase must traverse the intended guard, not fail merely
        # because a previous subcase consumed its synthetic inventory pages.
        pages = copy.deepcopy(self.pages)
        self.calls.clear()
        try:
            result = proof.prove(self.read, authenticated=True)
        finally:
            self.pages = pages
        self.assertTrue(all(type(v) in (bool, int) for v in result.values()))
        output = json.dumps(result)
        for private in (MODEL, AGENT, OTHER, proof.WORKSPACE, "EVALUATE", "payload", "private-sentinel"):
            self.assertNotIn(private, output)
        self.assertFalse(result["RecoverySafe"])
        self.assertFalse(result["OutstandingOperationsProvenClear"])
        return result

    def replace(self, path, value):
        for index, current in enumerate(self.definition["definition"]["parts"]):
            if current["path"] == path:
                self.definition["definition"]["parts"][index] = part(path, value)
                return
        self.fail("Synthetic part absent")

    def test_exact_legacy_pass_leaves_input_definition_unchanged(self):
        before = copy.deepcopy(self.definition)
        result = self.run_proof()
        self.assertTrue(result["ProofPassed"])
        self.assertTrue(result["PlatformValid"])
        self.assertNotIn("PlatformPreservedInMemory", result)
        self.assertEqual((result["Pages"], result["Items"], result["Parts"]), (1, 2, 5))
        self.assertEqual(self.definition, before)

    def test_full_pagination_finds_targets_across_pages(self):
        self.pages = [
            {"value": self.items[:1], "continuationToken": "opaque+token",
             "continuationUri": proof.BASE + "/items?continuationToken=opaque%2Btoken"},
            {"value": self.items[1:]},
        ]
        result = self.run_proof()
        self.assertTrue(result["ProofPassed"])
        self.assertEqual(result["Pages"], 2)
        self.assertIn(("GET", proof.BASE + "/items?continuationToken=opaque%2Btoken"), self.calls)

    def test_only_json_whitespace_and_object_key_order_are_irrelevant(self):
        for current in self.definition["definition"]["parts"]:
            value = json.loads(base64.b64decode(current["payload"]))
            value = dict(reversed(list(value.items())))
            current["payload"] = base64.b64encode(json.dumps(value, indent=4).encode()).decode()
        self.assertTrue(self.run_proof()["ProofPassed"])

    def test_wrong_model_or_workspace_binding_fails(self):
        for field in ("artifactId", "workspaceId"):
            with self.subTest(field=field):
                source = copy.deepcopy(self.files[proof.SOURCE_FOLDER + "datasource.json"])
                source[field] = OTHER
                self.replace(proof.SOURCE_FOLDER + "datasource.json", source)
                result = self.run_proof()
                self.assertFalse(result["ProofPassed"])
                self.assertFalse(result["BindingMatched"])

    def test_all_non_platform_payloads_must_match(self):
        for path, value in self.files.items():
            with self.subTest(path=path):
                saved = copy.deepcopy(self.definition)
                changed = copy.deepcopy(value)
                changed["unknown"] = "private-sentinel"
                self.replace(path, changed)
                result = self.run_proof()
                self.assertFalse(result["ProofPassed"])
                self.assertTrue(result["PlatformValid"])
                self.assertFalse(result["LegacyPayloadsMatched"])
                self.definition = saved

    def test_source_selection_types_ids_and_array_order_cannot_be_normalized(self):
        for change in ("boolean-as-int", "new-id", "reordered-tables", "removed-description"):
            with self.subTest(change=change):
                source = copy.deepcopy(self.files[proof.SOURCE_FOLDER + "datasource.json"])
                if change == "boolean-as-int":
                    source["elements"][0]["is_selected"] = 1
                elif change == "new-id":
                    source["elements"][0]["id"] = OTHER
                elif change == "reordered-tables":
                    source["elements"].reverse()
                else:
                    del source["userDescription"]
                self.replace(proof.SOURCE_FOLDER + "datasource.json", source)
                result = self.run_proof()
                self.assertTrue(result["PlatformValid"])
                self.assertFalse(result["ProofPassed"])

    def test_exact_original_fewshot_values_are_required(self):
        for field in ("id", "question", "query"):
            with self.subTest(field=field):
                fewshots = copy.deepcopy(self.files[proof.SOURCE_FOLDER + "fewshots.json"])
                fewshots["fewShots"][0][field] = "private-sentinel"
                self.replace(proof.SOURCE_FOLDER + "fewshots.json", fewshots)
                result = self.run_proof()
                self.assertTrue(result["PlatformValid"])
                self.assertFalse(result["ProofPassed"])

    def test_duplicate_missing_wrong_type_or_out_of_scope_inventory_fails(self):
        cases = {}
        cases["missing-model"] = self.items[1:]
        cases["missing-agent"] = self.items[:1]
        cases["duplicate-id"] = self.items + [copy.deepcopy(self.items[0])]
        for target in (0, 1):
            duplicate = copy.deepcopy(self.items[target])
            duplicate["id"] = OTHER
            cases[f"duplicate-target-{target}"] = self.items + [duplicate]
        for field, value in (("type", "Report"), ("workspaceId", OTHER),
                             ("id", "not-a-guid"), ("displayName", "wrong-case")):
            changed = copy.deepcopy(self.items)
            changed[0][field] = value
            cases[field] = changed
        for name, items in cases.items():
            with self.subTest(case=name):
                self.pages = [{"value": items}]
                self.calls.clear()
                self.assertFalse(self.run_proof()["ProofPassed"])
                self.assertFalse(any(method == "POST" for method, _ in self.calls))

    def test_malformed_pagination_never_fetches_an_untrusted_uri(self):
        bad_pages = [
            {"value": self.items, "continuationUri": "https://example.invalid/private"},
            {"value": self.items, "continuationToken": "next", "continuationUri": "https://example.invalid/"},
            {"value": self.items, "continuationToken": "next", "continuationUri": proof.BASE + "/items?other=next"},
            {"value": self.items, "continuationToken": 12},
            {"value": self.items, "continuationToken": "unsafe\n"},
            {"value": [], "continuationToken": "next"},
            {"value": {}}, {},
        ]
        for page in bad_pages:
            with self.subTest(case=list(page.keys())):
                self.pages, self.calls = [page], []
                self.assertFalse(self.run_proof()["ProofPassed"])
                self.assertTrue(all(url.startswith(proof.BASE) for _, url in self.calls))

    def test_duplicate_ids_across_pages_and_repeated_tokens_fail(self):
        self.pages = [
            {"value": self.items, "continuationToken": "same"},
            {"value": [self.items[0]], "continuationToken": "same"},
        ]
        self.assertFalse(self.run_proof()["ProofPassed"])
        extra = copy.deepcopy(self.items[0])
        extra["id"] = OTHER
        self.pages = [
            {"value": self.items, "continuationToken": "same"},
            {"value": [extra], "continuationToken": "same"},
        ]
        self.assertFalse(self.run_proof()["ProofPassed"])

    def test_page_and_item_limits_fail_closed(self):
        with patch.object(proof, "MAX_PAGES", 1):
            self.pages = [{"value": self.items, "continuationToken": "next"}]
            self.assertFalse(self.run_proof()["ProofPassed"])
        with patch.object(proof, "MAX_ITEMS", 1):
            self.pages = [{"value": self.items}]
            self.assertFalse(self.run_proof()["ProofPassed"])

    def test_platform_mismatch_or_unknown_structure_fails(self):
        cases = []
        for key, value in (("$schema", "https://example.invalid/schema"),
                           ("unexpected", True)):
            changed = platform()
            changed[key] = value
            cases.append(changed)
        for field, value in (("type", "Report"), ("displayName", "different"),
                             ("description", "private-sentinel"), ("unknown", "value")):
            changed = platform()
            changed["metadata"][field] = value
            cases.append(changed)
        for field, value in (("version", "1.0"), ("logicalId", proof.ZERO),
                             ("logicalId", "malformed"), ("unknown", True)):
            changed = platform()
            changed["config"][field] = value
            cases.append(changed)
        for missing in ("$schema", "config", "metadata"):
            changed = platform()
            del changed[missing]
            cases.append(changed)
        for changed in cases:
            with self.subTest(case=len(json.dumps(changed))):
                self.replace(".platform", changed)
                result = self.run_proof()
                self.assertTrue(result["BindingMatched"])
                self.assertFalse(result["PlatformValid"])
                self.assertFalse(result["ProofPassed"])

    def test_optional_platform_description_can_be_absent(self):
        value = platform()
        del value["metadata"]["description"]
        self.replace(".platform", value)
        self.assertTrue(self.run_proof()["ProofPassed"])

    def test_any_published_or_publish_info_part_fails(self):
        for path in ("Files/Config/published/stage_config.json", "Files/Config/publish_info.json"):
            with self.subTest(path=path):
                self.definition["definition"]["parts"].append(part(path, {}))
                result = self.run_proof()
                self.assertFalse(result["ProofPassed"])
                self.assertFalse(result["UnpublishedPartsOnly"])
                self.definition["definition"]["parts"].pop()

    def test_missing_extra_duplicate_or_malformed_definition_part_fails(self):
        original = copy.deepcopy(self.definition)
        cases = [
            original["definition"]["parts"][:-1],
            original["definition"]["parts"] + [part("unknown.json", {})],
            original["definition"]["parts"] + [copy.deepcopy(original["definition"]["parts"][0])],
        ]
        for field, value in (("payloadType", "Other"), ("payload", "%%%"), ("path", "changed")):
            changed = copy.deepcopy(original["definition"]["parts"])
            changed[0][field] = value
            cases.append(changed)
        for raw in (b'{"$schema":"2.1.0","$schema":"other"}', b"\xff", b"NaN", b"{bad}"):
            changed = copy.deepcopy(original["definition"]["parts"])
            changed[0]["payload"] = base64.b64encode(raw).decode()
            cases.append(changed)
        for parts in cases:
            self.definition = {"definition": {"parts": parts}}
            self.assertFalse(self.run_proof()["ProofPassed"])

    def test_snapshot_digest_and_provenance_tampering_fail(self):
        with patch.object(proof, "SNAPSHOT_SHA256", "incorrect"):
            self.assertFalse(self.run_proof()["ProofPassed"])
        self.pages = [{"value": self.items}]
        with patch.object(proof, "LEGACY_COMMIT", "incorrect"):
            self.assertFalse(self.run_proof()["ProofPassed"])

    def test_provider_errors_never_escape_or_leak(self):
        def fail(*_args):
            raise RuntimeError("private-sentinel")
        self.assertFalse(proof.prove(fail)["ProofPassed"])


class TransportTests(unittest.TestCase):
    def test_http_transport_disables_redirects_and_bounds_response_reads(self):
        class Response:
            status = 200
            headers = {}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, size):
                self.requested_size = size
                return b'{"value":[]}'

        response = Response()
        opener = type("Opener", (), {"open": lambda _self, _request, timeout: response})()
        with patch.object(proof.urllib.request, "build_opener", return_value=opener) as build:
            self.assertEqual(proof.http_json("GET", proof.BASE)[0], 200)
            self.assertIsInstance(build.call_args.args[0], proof.NoRedirect)
        self.assertEqual(response.requested_size, proof.MAX_BYTES + 1)
        self.assertIsNone(proof.NoRedirect().redirect_request(None, None, 302, "", {}, "https://example.invalid"))

    def test_oversized_http_response_and_duplicate_json_keys_fail(self):
        class Response:
            status = 200
            headers = {}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, size):
                return b"x" * size

        opener = type("Opener", (), {"open": lambda _self, _request, timeout: Response()})()
        with patch.object(proof.urllib.request, "build_opener", return_value=opener):
            with self.assertRaises(proof.ProofFailure):
                proof.http_json("GET", proof.BASE)
        with self.assertRaises(proof.ProofFailure):
            proof.strict_json('{"value":[],"value":[]}')

    def test_read_only_request_allowlist_and_no_body(self):
        calls = []

        def send(method, url, **kwargs):
            calls.append((method, url, kwargs))
            return 200, {}, {}

        client = proof.FabricReads("private-sentinel", send=send)
        for method, url in (
            ("POST", proof.BASE + f"/dataAgents/{AGENT}/updateDefinition"),
            ("POST", proof.BASE + f"/dataAgents/{AGENT}/staging/publish"),
            ("GET", proof.RESOURCE + "/v1/workspaces/" + OTHER),
            ("DELETE", proof.BASE), ("POST", proof.BASE + "/items"),
            ("GET", proof.BASE + "/items?continuationToken=ok&other=unsafe"),
            ("GET", proof.RESOURCE + "/v1/operations/" + OPERATION),
        ):
            with self.assertRaises(proof.ProofFailure):
                client(method, url)
        self.assertFalse(calls)
        client("POST", proof.BASE + f"/dataAgents/{AGENT}/getDefinition")
        self.assertEqual(calls[-1][2], {"bearer": "private-sentinel"})

    def test_definition_lro_is_bounded_and_only_polls_its_returned_id(self):
        responses = [
            (202, {"x-ms-operation-id": OPERATION, "retry-after": "0",
                   "location": "https://example.invalid/do-not-follow"}, None),
            (200, {"retry-after": "1"}, {"status": "Running"}),
            (200, {}, {"status": "Succeeded"}),
            (200, {}, {"definition": {"parts": []}}),
        ]
        calls, sleeps = [], []

        def send(method, url, **_kwargs):
            calls.append((method, url))
            return responses.pop(0)

        client = proof.FabricReads("private-sentinel", send=send, sleep=sleeps.append)
        self.assertEqual(client("POST", proof.BASE + f"/dataAgents/{AGENT}/getDefinition"),
                         {"definition": {"parts": []}})
        self.assertEqual(sleeps, [0, 1])
        self.assertTrue(all(url.startswith(proof.RESOURCE + "/") for _, url in calls))
        self.assertEqual(calls[-1], ("GET", proof.RESOURCE + f"/v1/operations/{OPERATION}/result"))

    def test_lro_missing_headers_failure_unknown_state_timeout_fail_closed(self):
        for first, following in (
            ((202, {}, None), []),
            ((202, {"x-ms-operation-id": OPERATION}, None), []),
            ((202, {"x-ms-operation-id": OPERATION, "retry-after": "99"}, None), []),
            ((302, {}, None), []),
            ((202, {"x-ms-operation-id": OPERATION, "retry-after": "0"}, None),
             [(200, {}, {"status": "Failed"})]),
            ((202, {"x-ms-operation-id": OPERATION, "retry-after": "0"}, None),
             [(200, {}, {"status": "Unknown"})]),
            ((202, {"x-ms-operation-id": OPERATION, "retry-after": "0"}, None),
             [(200, {"retry-after": "0"}, {"status": "Running"})]),
        ):
            responses = [first, *following]
            client = proof.FabricReads("private-sentinel", send=lambda *_a, **_k: responses.pop(0),
                                       sleep=lambda _delay: None)
            with self.subTest(status=first[0]), patch.object(proof, "MAX_POLLS", 1):
                with self.assertRaises(proof.ProofFailure):
                    client("POST", proof.BASE + f"/dataAgents/{AGENT}/getDefinition")


class AuthenticationTests(unittest.TestCase):
    def setUp(self):
        self.env = {
            "GITHUB_REPOSITORY": "ribumann/fabrictritwin", "GITHUB_REF": "refs/heads/main",
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_WORKFLOW_REF":
                "ribumann/fabrictritwin/.github/workflows/mining-legacy-agent-proof.yml@refs/heads/main",
            "ACTIONS_ID_TOKEN_REQUEST_URL":
                "https://run-actions-test.actions.githubusercontent.com/idtoken?api-version=2.0",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "private-request",
        }
        self.claims = {"tid": proof.TENANT, "oid": proof.PRINCIPAL, "appid": proof.APPLICATION,
                       "aud": proof.RESOURCE, "exp": int(time.time()) + 600}
        self.calls = []

    def send(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if len(self.calls) == 1:
            self.assertEqual(method, "GET")
            self.assertIn("audience=api%3A%2F%2FAzureADTokenExchange", url)
            return 200, {}, {"value": "private-oidc"}
        self.assertEqual((method, url),
                         ("POST", f"https://login.microsoftonline.com/{proof.TENANT}/oauth2/v2.0/token"))
        self.assertEqual(kwargs["form"]["scope"], proof.RESOURCE + "/.default")
        self.assertEqual(kwargs["form"]["client_assertion"], "private-oidc")
        encoded = base64.urlsafe_b64encode(json.dumps(self.claims).encode()).decode().rstrip("=")
        return 200, {}, {"access_token": "header." + encoded + ".signature"}

    def test_direct_oidc_exchange_has_no_cli_or_persistent_cache(self):
        with patch.object(proof, "http_json", side_effect=self.send):
            self.assertTrue(proof.oidc_access_token(self.env))
        self.assertEqual(len(self.calls), 2)

    def test_off_main_wrong_repo_event_workflow_or_oidc_host_fails_before_network(self):
        for key, value in (
            ("GITHUB_REF", "refs/heads/other"), ("GITHUB_REPOSITORY", "different/repo"),
            ("GITHUB_EVENT_NAME", "push"), ("GITHUB_WORKFLOW_REF", "different"),
            ("ACTIONS_ID_TOKEN_REQUEST_URL", "https://example.invalid/idtoken"),
        ):
            env = self.env | {key: value}
            with self.subTest(key=key), patch.object(proof, "http_json") as send:
                with self.assertRaises(proof.ProofFailure):
                    proof.oidc_access_token(env)
                send.assert_not_called()

    def test_wrong_claims_expired_or_delegated_token_fail(self):
        original = copy.deepcopy(self.claims)
        for key, value in (("tid", OTHER), ("oid", OTHER), ("appid", OTHER),
                           ("aud", "different"), ("exp", 0), ("scp", "delegated")):
            self.claims = original | {key: value}
            self.calls.clear()
            with self.subTest(key=key), patch.object(proof, "http_json", side_effect=self.send):
                with self.assertRaises(proof.ProofFailure):
                    proof.oidc_access_token(self.env)

    def test_main_prints_only_sanitized_flags_and_counts_even_on_auth_failure(self):
        output = io.StringIO()
        with patch.object(proof, "oidc_access_token", side_effect=RuntimeError("private-sentinel")), \
                patch.object(sys, "argv", ["proof"]), contextlib.redirect_stdout(output):
            self.assertEqual(proof.main(), 1)
        result = json.loads(output.getvalue())
        self.assertTrue(all(type(v) in (bool, int) for v in result.values()))
        self.assertNotIn("private-sentinel", output.getvalue())

    def test_main_suppresses_private_provider_error_after_authentication(self):
        output = io.StringIO()
        with patch.object(proof, "oidc_access_token", return_value="private-token"), \
                patch.object(proof.FabricReads, "__call__", side_effect=RuntimeError("private-provider-body")), \
                patch.object(sys, "argv", ["proof"]), contextlib.redirect_stdout(output):
            self.assertEqual(proof.main(), 1)
        result = json.loads(output.getvalue())
        self.assertTrue(result["Authenticated"])
        self.assertFalse(result["ProofPassed"])
        self.assertNotIn("private-provider-body", output.getvalue())
        self.assertNotIn("private-token", output.getvalue())

    def test_workflow_is_manual_main_only_and_has_no_cloud_write_or_upload_steps(self):
        text = (ROOT / ".github/workflows/mining-legacy-agent-proof.yml").read_text()
        self.assertIn("workflow_dispatch:", text)
        self.assertIn("github.ref == 'refs/heads/main'", text)
        self.assertIn("environment: azure-mining-bootstrap", text)
        self.assertIn("id-token: write", text)
        self.assertIn("persist-credentials: false", text)
        self.assertIn("python3 -B scripts/fabric/mining_legacy_agent_proof.py", text)
        for forbidden in ("upload-artifact@", "azure/login@", "updateDefinition", "staging/publish",
                          "GITHUB_STEP_SUMMARY", "schedule:", "pull_request:", "\n  push:"):
            self.assertNotIn(forbidden, text)


if __name__ == "__main__":
    unittest.main()
