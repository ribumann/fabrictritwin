"""Credential-free execution tests for the inline Mining Fabric identity proof."""

import base64
import contextlib
import io
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch
import urllib.error
import urllib.parse
import urllib.request


WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "mining-fabric-identity-proof.yml"
TEXT = WORKFLOW.read_text(encoding="utf-8")
SCRIPT = "\n".join(
    line[10:] for line in TEXT.split("          python3 - <<'PY'\n", 1)[1].split(
        "\n          PY", 1
    )[0].splitlines()
)
PROOF = {"__name__": "workflow_test"}
exec(compile(SCRIPT, str(WORKFLOW), "exec"), PROOF)


class Response:
    def __init__(self, data, status=200):
        self.body = data if isinstance(data, bytes) else json.dumps(data).encode()
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, size):
        return self.body[:size]


class MiningFabricIdentityWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.workspace = PROOF["WORKSPACE"]
        self.base = PROOF["BASE"]
        self.claims = {
            "tid": PROOF["TENANT"], "oid": PROOF["PRINCIPAL"], "appid": PROOF["CLIENT"]
        }
        self.requests = []
        self.pages = [{"id": self.workspace}, {"value": []}]
        self.token_failure = None
        self.token_override = None
        self.result = None

    def token(self, command, **kwargs):
        self.assertEqual(command, [
            "az", "account", "get-access-token", "--resource", PROOF["RESOURCE"],
            "--tenant", PROOF["TENANT"], "--query", "accessToken", "--output", "tsv",
            "--only-show-errors",
        ])
        self.assertEqual(kwargs, {
            "capture_output": True, "text": True, "timeout": 30, "check": True,
        })
        if self.token_failure:
            raise self.token_failure
        payload = base64.urlsafe_b64encode(json.dumps(self.claims).encode()).decode().rstrip("=")
        self.result = self.token_override or f"private-header.{payload}.private-signature"
        return subprocess.CompletedProcess(command, 0, self.result, "")

    def open(self, request, timeout):
        self.assertEqual(timeout, 30)
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.get_header("Authorization"), f"Bearer {self.result}")
        self.assertIsNone(request.data)
        self.requests.append(request.full_url)
        self.assertLessEqual(len(self.requests), 11)
        self.assertTrue(
            request.full_url in [self.base, self.base + "/items"]
            or request.full_url.startswith(self.base + "/items?continuationToken=")
        )
        page = self.pages.pop(0)
        if isinstance(page, Exception):
            raise page
        return page if isinstance(page, Response) else Response(page)

    def run_proof(self):
        output = io.StringIO()
        opener = type("FakeOpener", (), {"open": lambda _, req, timeout: self.open(req, timeout)})()
        with patch.object(subprocess, "run", side_effect=self.token), patch.object(
            urllib.request, "build_opener", return_value=opener
        ) as build, contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            try:
                PROOF["main"]()
            except SystemExit as error:
                output.write(str(error))
                success = False
            else:
                success = True
            if build.called:
                self.assertIsInstance(build.call_args.args[0], PROOF["NoRedirect"])
        text = output.getvalue()
        for private in [self.result, "private-body", "private-transport", "private-auth"]:
            if private:
                self.assertNotIn(private, text)
        return success, text

    def test_empty_inventory_succeeds_after_both_exact_gets(self):
        success, text = self.run_proof()
        self.assertTrue(success)
        self.assertIn("0 items, 1 pages", text)
        self.assertIn("does not prove absence of write permissions", text)
        self.assertEqual(self.requests, [self.base, self.base + "/items"])

    def test_v2_client_claim(self):
        self.claims["azp"] = self.claims.pop("appid")
        self.assertTrue(self.run_proof()[0])

    def test_wrong_or_missing_caller_claim_fails_before_network(self):
        for claim in ["tid", "oid", "appid"]:
            for value in [None, "different-principal"]:
                with self.subTest(claim=claim, value=value):
                    original = self.claims[claim]
                    self.claims[claim] = value
                    self.assertFalse(self.run_proof()[0])
                    self.assertEqual(self.requests, [])
                    self.claims[claim] = original

    def test_delegated_token_rejected(self):
        self.claims["scp"] = "Workspace.Read.All"
        self.assertFalse(self.run_proof()[0])
        self.assertEqual(self.requests, [])

    def test_token_failures_never_reach_fabric_or_leak_details(self):
        for error in [
            subprocess.CalledProcessError(1, ["az"], output="private-auth", stderr="private-auth"),
            subprocess.TimeoutExpired(["az"], 30, output="private-auth"),
        ]:
            with self.subTest(error=type(error).__name__):
                self.token_failure = error
                self.assertFalse(self.run_proof()[0])
                self.assertEqual(self.requests, [])

    def test_malformed_token_is_sanitized(self):
        for token in ["private-auth", "a.@@@.b", "a.bnVsbA.b"]:
            with self.subTest(token=token):
                self.token_override = token
                self.assertFalse(self.run_proof()[0])
                self.assertEqual(self.requests, [])

    def test_workspace_mismatch_stops_before_inventory(self):
        self.pages = [{"id": "different-workspace"}]
        self.assertFalse(self.run_proof()[0])
        self.assertEqual(self.requests, [self.base])

    def test_http_and_transport_failures_are_sanitized(self):
        for code in [301, 302, 307, 401, 403, 404, 429, 500]:
            with self.subTest(code=code):
                self.pages = [urllib.error.HTTPError(
                    self.base, code, "private-body", {}, io.BytesIO(b"private-body")
                )]
                success, text = self.run_proof()
                self.assertFalse(success)
                self.assertIn(f"HTTP {code}", text)
        self.pages = [urllib.error.URLError("private-transport")]
        self.assertFalse(self.run_proof()[0])

    def test_redirect_handler_never_forwards_bearer(self):
        handler = PROOF["NoRedirect"]()
        for code in [301, 302, 303, 307, 308]:
            self.assertIsNone(handler.redirect_request(
                None, None, code, "private-body", {}, "https://untrusted.invalid"
            ))

    def test_invalid_or_oversized_response_fails(self):
        for data in [b"private-body", b"[]", b"x" * 2_000_001, Response({}, status=204)]:
            with self.subTest(data_type=type(data).__name__):
                self.pages = [data if isinstance(data, Response) else Response(data)]
                self.assertFalse(self.run_proof()[0])

    def test_inventory_shape_and_scope_fail_closed(self):
        for inventory in [
            {}, {"value": None}, {"value": {}}, {"value": [None]},
            {"value": [{"id": "item", "workspaceId": "shared-workspace"}]},
            {"value": [{"id": "item"}]}, {"value": [{"workspaceId": self.workspace}]},
        ]:
            with self.subTest(inventory=inventory):
                self.pages = [{"id": self.workspace}, inventory]
                self.assertFalse(self.run_proof()[0])

    def test_pagination_rebuilds_only_pinned_url_and_counts_complete_inventory(self):
        continuation = "https://untrusted.invalid/?x=y&z=+/%"
        self.pages[1] = {
            "value": [{"id": "item", "workspaceId": self.workspace}],
            "continuationToken": continuation, "continuationUri": "https://untrusted.invalid",
        }
        self.pages.append({"value": []})
        success, text = self.run_proof()
        self.assertTrue(success)
        self.assertIn("1 items, 2 pages", text)
        self.assertEqual(self.requests[-1], self.base + "/items?" + urllib.parse.urlencode(
            {"continuationToken": continuation}
        ))

    def test_uri_without_token_and_invalid_or_looping_continuation_fail(self):
        for extra in [
            {"continuationUri": "https://untrusted.invalid"},
            {"continuationToken": 12}, {"continuationToken": ["bad"]},
        ]:
            self.pages = [{"id": self.workspace}, {"value": [], **extra}]
            self.assertFalse(self.run_proof()[0])
        page = {"value": [], "continuationToken": "same"}
        self.pages = [{"id": self.workspace}, page, page]
        self.assertFalse(self.run_proof()[0])

    def test_page_bound_fails_instead_of_reporting_partial_success(self):
        self.pages = [{"id": self.workspace}] + [
            {"value": [], "continuationToken": str(n)} for n in range(10)
        ]
        success, text = self.run_proof()
        self.assertFalse(success)
        self.assertIn("exceeded 10 pages", text)
        self.assertEqual(len(self.requests), 11)

    def test_workflow_has_main_environment_job_scoped_oidc_and_no_mutation(self):
        self.assertIn("on:\n  workflow_dispatch:\n", TEXT)
        self.assertIn("permissions: {}\n", TEXT)
        self.assertIn("github.repository == 'ribumann/fabrictritwin' && github.ref == 'refs/heads/main'", TEXT)
        self.assertIn("environment: azure-mining-bootstrap", TEXT)
        self.assertIn("    permissions:\n      id-token: write\n", TEXT)
        self.assertIn("timeout-minutes: 10", TEXT)
        self.assertIn("timeout-minutes: 2", TEXT)
        self.assertIn("timeout-minutes: 7", TEXT)
        self.assertIn("azure/login@7184910d9eb2b1c5e48f7073824a90609bb9b6d6", TEXT)
        self.assertIn("allow-no-subscriptions: true", TEXT)
        self.assertIn("audience: api://AzureADTokenExchange", TEXT)
        self.assertIn("client-id: " + PROOF["CLIENT"], TEXT)
        self.assertIn("tenant-id: " + PROOF["TENANT"], TEXT)
        self.assertIn("if: failure() && steps.login.outcome == 'failure'", TEXT)
        self.assertIn("Authentication is NOT proven", TEXT)
        self.assertIn("AZURE_CONFIG_DIR: /dev/shm/mining-fabric-identity", TEXT)
        self.assertIn('test "$(findmnt -n -o FSTYPE --target /dev/shm)" = tmpfs', TEXT)
        for forbidden in [
            "secrets.", "vars.", "subscription-id:", "creds:", "continue-on-error:",
            "actions/checkout", "upload-artifact", "workflow_call:", "schedule:", "pull_request:",
            "set -x", "GITHUB_OUTPUT", "GITHUB_ENV", "GITHUB_STEP_SUMMARY", "az rest",
        ]:
            self.assertNotIn(forbidden, TEXT)


if __name__ == "__main__":
    unittest.main()
