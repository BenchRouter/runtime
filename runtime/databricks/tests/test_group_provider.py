"""SERVE-001 / AUTH-012: replay frozen group items through the agent's real HTTP clients.

Responses are from the 2026-11-02 multi-target probe and A.7 takeover recordings.
The socket logs the whole-config PATCH, grants, readback and report.
"""
import copy
import hashlib
import json
import unittest
from pathlib import Path

from benchrouter_databricks.agent import BenchRouter, handle_item
from benchrouter_databricks.handlers import Context, Failed, disconnect, retire
from benchrouter_databricks.transport import ApiError
from tests.recorded_workspace import NOT_FOUND, RecordedServer

FIXTURES = Path(__file__).parent / "fixtures"
LIVE = json.loads((FIXTURES / "group-provider" / "answers.json").read_text())
TAKEOVER = json.loads((FIXTURES / "takeover" / "answers.json").read_text())
SERVICE = LIVE["created"]["body"]["name"].removeprefix("model-provider-services/")
PS = f"/api/2.1/unity-catalog/model-provider-services/{SERVICE}"
ACL = f"/api/2.1/unity-catalog/permissions/model_provider_service/{SERVICE}"
REPORT = "/v1/databricks/report"
TARGETS = [target["model"] for target in LIVE["created"]["body"]["config"]["targets"]]
MANAGERS = [{"type": "user", "name": "admin@example.com"}, {"type": "group", "name": "provider-owners"}]


def payload(targets=TARGETS):
    return {"object": "provider_service", "service_id": "dbxs_recorded", "service_name": SERVICE,
            "group_name": "Demo", "revision": 2, "targets": targets, "api_base": "https://api.benchrouter.com",
            "runtime_key": "br_live_test_key", "manage_principals": copy.deepcopy(MANAGERS),
            "query_principal": {"type": "group", "name": "account users"}, "replace_services": []}


def deliver(server, body, kind="setup"):
    handle_item(Context(server.workspace(), "recorded-scope", 99), BenchRouter(server.base), "recorded-poll-key",
                {"id": "recorded-item", "lease_id": "recorded-lease", "kind": kind, "payload": body})


class GroupProviderTest(unittest.TestCase):
    def setUp(self):
        self.server = RecordedServer({
            f"GET {PS}": copy.deepcopy(LIVE["created"]),
            f"PATCH {PS}": copy.deepcopy(LIVE["created"]),
            "POST /api/2.1/unity-catalog/model-provider-services": copy.deepcopy(LIVE["created"]),
            f"PATCH {ACL}": copy.deepcopy(LIVE["grant"]),
            f"POST {REPORT}": TAKEOVER["endpoint_deleted"],
        })

    def tearDown(self):
        self.server.close()

    def report(self):
        return next(body for _, path, _, body in self.server.calls if path == REPORT)

    def test_serve_001_create_whole_target_list_grant_once_and_report_readback(self):
        self.server.answers[f"GET {PS}"] = [NOT_FOUND, LIVE["created"]]
        deliver(self.server, payload())
        create = next((query, body) for method, path, query, body in self.server.calls
                      if method == "POST" and path == "/api/2.1/unity-catalog/model-provider-services")
        self.assertEqual(create[0], {"parent": "schemas/workspace.br_probe_pschema", "model_provider_service_id": "br_probe_multi"})
        self.assertEqual(create[1]["comment"], "BenchRouter group Demo")
        self.assertEqual([target["model"] for target in create[1]["config"]["targets"]], TARGETS)
        self.assertEqual(create[1]["config"]["custom"]["direct"]["api_key"], {"plaintext": "br_live_test_key"})
        grants = [body["changes"] for _, path, _, body in self.server.calls if path == ACL]
        self.assertEqual(grants, [[{"principal": "admin@example.com", "add": ["MANAGE"]},
                                   {"principal": "provider-owners", "add": ["MANAGE"]},
                                   {"principal": "account users", "add": ["EXECUTE"]}]])
        digest = hashlib.sha256(json.dumps(sorted(TARGETS), separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(self.report()["result"], {"object": "provider_service", "service_name": SERVICE, "targets_hash": digest})
        self.assertFalse(any("serving-endpoints" in path for _, path in self.server.paths()))

    def test_serve_001_list_only_patch_sends_current_key_and_replaces_targets_without_merging(self):
        targets = [target["model"] for target in LIVE["updated_without_key"]["body"]["config"]["targets"]]
        self.server.answers[f"GET {PS}"] = [LIVE["created"], LIVE["updated_without_key"]]
        body = payload(targets)
        deliver(self.server, body)
        patches = [(query, data) for method, path, query, data in self.server.calls if method == "PATCH" and path == PS]
        self.assertEqual(len(patches), 1)
        patch = patches[0]
        self.assertEqual(patch[0], {"update_mask": "config"})
        self.assertEqual(patch[1]["config"]["targets"], LIVE["updated_without_key"]["body"]["config"]["targets"])
        self.assertNotIn("demo/route-c", [target["model"] for target in patch[1]["config"]["targets"]])
        self.assertEqual(patch[1]["config"]["custom"]["direct"], {
            "base_url": "https://api.benchrouter.com/v1", "api_key": {"plaintext": body["runtime_key"]},
        })
        self.assertEqual(self.report()["outcome"], "done")

    def test_auth_012_service_without_runtime_key_fails_before_any_workspace_call(self):
        for existing in [LIVE["created"], NOT_FOUND]:
            with self.subTest(existing=existing["status"]):
                self.server.calls.clear()
                self.server.answers[f"GET {PS}"] = existing
                body = payload()
                del body["runtime_key"]
                deliver(self.server, body)
                self.assertEqual(self.server.paths(), [("POST", REPORT)])
                self.assertEqual(self.report(), {"item_id": "recorded-item", "lease_id": "recorded-lease",
                                                "outcome": "failed", "result": {}, "error_code": "runtime_key_missing"})

    def test_auth_012_rotation_sends_new_service_key_and_readback_hash(self):
        deliver(self.server, payload())
        patch = next(body for method, path, _, body in self.server.calls if method == "PATCH" and path == PS)
        self.assertEqual(patch["config"]["custom"]["direct"]["api_key"], {"plaintext": "br_live_test_key"})
        self.assertEqual(self.server.paths().count(("GET", PS)), 2)
        self.assertEqual(self.report()["outcome"], "done")

    def test_auth_012_late_old_key_patch_is_followed_by_repair_with_current_key(self):
        current = payload()
        stale = payload()
        stale["runtime_key"] = "br_live_old_key"
        deliver(self.server, current)
        deliver(self.server, stale)
        deliver(self.server, current)
        keys = [body["config"]["custom"]["direct"]["api_key"]["plaintext"]
                for method, path, _, body in self.server.calls if method == "PATCH" and path == PS]
        self.assertEqual(keys, ["br_live_test_key", "br_live_old_key", "br_live_test_key"])
        self.assertEqual([body["outcome"] for _, path, _, body in self.server.calls if path == REPORT], ["done"] * 3)

    def test_auth_012_orphan_update_and_grant_report_fixed_code_without_endpoint_work(self):
        for step, answer in [(PS, "provider_update_refused"), (ACL, "provider_manage_refused")]:
            with self.subTest(step=step):
                self.server.calls.clear()
                self.server.answers[f"PATCH {PS}"] = LIVE["created"]
                self.server.answers[f"PATCH {ACL}"] = LIVE["grant"]
                self.server.answers[f"PATCH {step}"] = TAKEOVER[answer]
                deliver(self.server, payload())
                self.assertEqual(self.report(), {"item_id": "recorded-item", "lease_id": "recorded-lease",
                                                 "outcome": "failed", "result": {}, "error_code": "provider_service_unmanageable"})

    def test_auth_012_non_orphan_permission_refusal_keeps_its_code_and_never_deletes(self):
        for step, code in [(PS, "service_update_http_403"), (ACL, "service_grant_http_403")]:
            with self.subTest(step=step):
                self.server.calls.clear()
                self.server.answers[f"PATCH {PS}"] = LIVE["created"]
                self.server.answers[f"PATCH {ACL}"] = LIVE["grant"]
                self.server.answers[f"PATCH {step}"] = TAKEOVER["provider_use_refused"]
                deliver(self.server, payload())
                self.assertEqual(self.report()["error_code"], code)
                self.assertFalse(any(method == "DELETE" for method, _ in self.server.paths()))

    def test_auth_012_readback_reports_observed_targets_when_a_late_writer_changed_them(self):
        self.server.answers[f"GET {PS}"] = [LIVE["created"], LIVE["updated_without_key"]]
        deliver(self.server, payload())
        observed = sorted(target["model"] for target in LIVE["updated_without_key"]["body"]["config"]["targets"])
        digest = hashlib.sha256(json.dumps(observed, separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(self.report()["result"]["targets_hash"], digest)
        expected = hashlib.sha256(json.dumps(sorted(TARGETS), separators=(",", ":")).encode()).hexdigest()
        self.assertNotEqual(digest, expected)

    def test_auth_012_legacy_deletion_is_separate_from_apply_and_absent_is_done(self):
        body = payload()
        body["replace_services"] = ["workspace.evals.br_legacy"]
        deliver(self.server, body)
        self.assertFalse(any(method == "DELETE" for method, _ in self.server.paths()))
        retire(Context(self.server.workspace(), "recorded-scope", 99),
               {"object": "legacy_provider_services", "services": body["replace_services"]})
        self.assertIn(("DELETE", "/api/2.1/unity-catalog/model-provider-services/workspace.evals.br_legacy"), self.server.paths())

    def test_auth_012_refused_legacy_and_group_deletion_fail_the_item_so_the_server_lists_them(self):
        self.server.answers[f"DELETE {PS}"] = TAKEOVER["provider_use_refused"]
        for payload_ in ({"object": "provider_service", "service_id": "dbxs_recorded", "service_name": SERVICE},
                         {"object": "legacy_provider_services", "services": [SERVICE]}):
            with self.assertRaises(Failed) as refused:
                retire(Context(self.server.workspace(), "recorded-scope", 99), payload_)
            self.assertEqual(refused.exception.code, "service_delete_http_403")

    def test_serve_001_retire_endpoint_does_not_delete_its_group_provider(self):
        retire(Context(self.server.workspace(), "recorded-scope", 99), {"endpoint_name": "br-recorded"})
        self.assertEqual(self.server.paths(), [("DELETE", "/api/2.0/serving-endpoints/br-recorded")])

    def test_serve_001_group_retire_deletes_only_the_named_service_and_absent_succeeds(self):
        retire(Context(self.server.workspace(), "recorded-scope", 99),
               {"object": "provider_service", "service_id": "dbxs_recorded", "service_name": SERVICE})
        self.assertEqual(self.server.paths(), [("DELETE", PS)])

    def test_auth_012_disconnect_deletes_each_distinct_service_once(self):
        disconnect(Context(self.server.workspace(), "recorded-scope", 99), {
            "agent_principal": {"type": "service_principal", "name": "recorded-sp"},
            "results_owner": None, "results_table": "workspace.evals.results", "experiment_path": "/Shared/recorded",
            "exposures": [{"endpoint_name": "br-one"}, {"endpoint_name": "br-two"}],
            "provider_services": [SERVICE, SERVICE, "workspace.evals.br_orphan"], "volumes": [],
        })
        deletions = [(method, path) for method, path in self.server.paths() if method == "DELETE"]
        self.assertEqual(deletions, [("DELETE", "/api/2.0/serving-endpoints/br-one"),
                                     ("DELETE", "/api/2.0/serving-endpoints/br-two"),
                                     ("DELETE", PS),
                                     ("DELETE", "/api/2.1/unity-catalog/model-provider-services/workspace.evals.br_orphan")])

    def disconnect_payload(self):
        return {"agent_principal": {"type": "service_principal", "name": "recorded-sp"},
                "results_owner": None, "results_table": "workspace.evals.results", "experiment_path": "/Shared/recorded",
                "exposures": [], "provider_services": [SERVICE, "workspace.evals.br_next"], "known_orphans": [SERVICE], "volumes": []}

    def test_auth_012_disconnect_skips_orphan_delete_permission_denied_and_reports_done_before_self_removal(self):
        self.server.answers.update({
            f"DELETE {PS}": TAKEOVER["provider_use_refused"],
            "POST /api/2.0/secrets/scopes/delete": TAKEOVER["endpoint_deleted"],
            "POST /api/2.2/jobs/delete": TAKEOVER["endpoint_deleted"],
        })
        deliver(self.server, self.disconnect_payload(), "disconnect")
        self.assertEqual(self.report(), {"item_id": "recorded-item", "lease_id": "recorded-lease",
                                        "outcome": "done", "result": {}})
        self.assertEqual(self.server.paths(), [
            ("DELETE", PS),
            ("DELETE", "/api/2.1/unity-catalog/model-provider-services/workspace.evals.br_next"),
            ("GET", "/api/2.1/unity-catalog/tables/workspace.evals.results"),
            ("GET", "/api/2.0/mlflow/experiments/get-by-name"),
            ("POST", REPORT),
            ("POST", "/api/2.0/secrets/scopes/delete"),
            ("POST", "/api/2.2/jobs/delete"),
        ])

    def test_auth_012_disconnect_fails_on_a_refused_service_the_server_never_recorded_as_orphan(self):
        self.server.answers[f"DELETE {PS}"] = TAKEOVER["provider_use_refused"]
        body = self.disconnect_payload()
        body["known_orphans"] = []
        with self.assertRaises(Failed) as refused:
            disconnect(Context(self.server.workspace(), "recorded-scope", 99), body)
        self.assertEqual(refused.exception.code, "service_delete_http_403")

    def test_auth_012_disconnect_service_delete_500_fails_and_leaves_lease_unreported(self):
        # Negative contract variant: preserve the recorded error body, change only the HTTP status.
        answer = copy.deepcopy(TAKEOVER["provider_use_refused"])
        answer["status"] = 500
        self.server.answers[f"DELETE {PS}"] = answer
        with self.assertRaises(ApiError) as refused:
            disconnect(Context(self.server.workspace(), "recorded-scope", 99), self.disconnect_payload())
        self.assertEqual(refused.exception.status, 500)
        self.server.calls.clear()
        deliver(self.server, self.disconnect_payload(), "disconnect")
        self.assertEqual(self.server.paths(), [("DELETE", PS)])


if __name__ == "__main__":
    unittest.main()
