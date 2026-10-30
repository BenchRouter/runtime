"""AUTH-012, DATA-001: replay A.7 takeover through the agent's real HTTP client.

The agent must replace a frozen endpoint, preserve its grants, and report only the fixed
provider-service failure code. The local recorded server also receives the real report.
"""

import copy
import json
import unittest
from itertools import product
from pathlib import Path

from benchrouter_databricks.agent import BenchRouter, handle_item
from benchrouter_databricks.handlers import Context, Failed, disconnect, setup_experiment, setup_results_table
from tests.recorded_workspace import NOT_FOUND, RecordedServer

LIVE = json.loads((Path(__file__).parent / "fixtures" / "takeover" / "answers.json").read_text())
ENDPOINT = LIVE["endpoint_created"]["body"]["name"]
SERVICE = LIVE["provider_managed"]["body"]["name"].removeprefix("model-provider-services/")
EP = f"/api/2.0/serving-endpoints/{ENDPOINT}"
PS = f"/api/2.1/unity-catalog/model-provider-services/{SERVICE}"
PS_ACL = f"/api/2.1/unity-catalog/permissions/model_provider_service/{SERVICE}"
CREATE = "/api/2.0/serving-endpoints"
REPORT = "/v1/databricks/report"
SP = LIVE["endpoint_created"]["body"]["creator"]
OLD_ENDPOINT_ID = LIVE["frozen_endpoint"]["body"]["id"]
NEW_ENDPOINT_ID = LIVE["endpoint_created"]["body"]["id"]
DELETION_PENDING = json.loads((Path(__file__).parent / "fixtures" / "takeover" / "deletion_pending.json").read_text())
MANAGERS = [
    {"type": "user", "name": "admin@example.com"},
    {"type": "service_principal", "name": SP},
    # The @ in this group name also proves that the type, not the name, selects the field.
    {"type": "group", "name": "ops@example.com"},
]
QUERIER = {"type": "group", "name": "account users"}


def default_answers():
    return copy.deepcopy({
        f"GET {EP}": LIVE["frozen_endpoint"],
        f"PUT {EP}/config": LIVE["endpoint_frozen"],
        f"DELETE {EP}": LIVE["endpoint_deleted"],
        f"POST {CREATE}": LIVE["endpoint_created"],
        f"PATCH /api/2.0/permissions/serving-endpoints/{NEW_ENDPOINT_ID}": LIVE["endpoint_acl"],
        f"PATCH /api/2.0/permissions/serving-endpoints/{OLD_ENDPOINT_ID}": LIVE["endpoint_acl"],
        f"GET {PS}": LIVE["provider_managed"],
        f"PATCH {PS}": LIVE["provider_managed"],
        f"PATCH {PS_ACL}": LIVE["endpoint_deleted"],
        f"POST {REPORT}": LIVE["endpoint_deleted"],
    })


def payload():
    return {
        "object": "serving_endpoint", "endpoint_name": ENDPOINT, "provider_service": SERVICE,
        "route_key": "takeover/route", "runtime_key": "test-runtime-key", "api_base": "https://api.example.com",
        "query_principal": copy.deepcopy(QUERIER), "manage_principals": copy.deepcopy(MANAGERS),
    }


def deliver(server, body=None, kind="setup"):
    handle_item(Context(server.workspace(), "recorded-scope", 99), BenchRouter(server.base), "test-poll-key", {
        "id": "recorded-item", "lease_id": "recorded-lease", "kind": kind,
        "payload": payload() if body is None else body,
    })


def reports(server):
    return [body for _, path, _, body in server.calls if path == REPORT]


def assert_acl(server, endpoint_id):
    grants = [(path, body["access_control_list"]) for method, path, _, body in server.calls
              if method == "PATCH" and "/permissions/serving-endpoints/" in path]
    acl_path = f"/api/2.0/permissions/serving-endpoints/{endpoint_id}"
    assert grants == [
        (acl_path, [{"group_name": "account users", "permission_level": "CAN_QUERY"}]),
        (acl_path, [{"user_name": "admin@example.com", "permission_level": "CAN_MANAGE"}]),
        (acl_path, [{"service_principal_name": SP, "permission_level": "CAN_MANAGE"}]),
        (acl_path, [{"group_name": "ops@example.com", "permission_level": "CAN_MANAGE"}]),
    ]
    changes = next(body["changes"] for method, path, _, body in server.calls if path == PS_ACL)
    assert changes == [*({"principal": p["name"], "add": ["MANAGE"]} for p in MANAGERS),
                       {"principal": "account users", "add": ["EXECUTE"]}]


INVALID_PRINCIPALS = ["admin@example.com", {"type": "unknown", "name": "admin"}, {"type": "user", "name": ""},
                      {"type": "group", "name": "  "}, {"type": "user"}, {"type": [], "name": "admin"}]


class TakeoverTest(unittest.TestCase):
    def setUp(self):
        self.server = RecordedServer(default_answers())

    def tearDown(self):
        self.server.close()

    def reset(self):
        self.server.calls.clear()
        self.server.answers = default_answers()

    def test_auth_012_frozen_endpoint_is_replaced_with_new_key_and_acl(self):
        server = self.server
        for case in product(["setup", "rotate_key"], ["endpoint_frozen", "endpoint_frozen_admin"]):
            with self.subTest(case=case):
                self.reset()
                kind, answer = case
                server.answers[f"PUT {EP}/config"] = LIVE[answer]
                deliver(server, kind=kind)
                assert server.paths()[:4] == [("GET", EP), ("PUT", f"{EP}/config"), ("DELETE", EP), ("POST", CREATE)]
                assert server.paths().count(("PUT", f"{EP}/config")) == 1
                created = next(body for method, path, _, body in server.calls if (method, path) == ("POST", CREATE))
                updated = next(body for method, path, _, body in server.calls if method == "PUT")
                assert created == {"name": ENDPOINT, "config": updated}
                assert updated["served_entities"][0]["external_model"]["custom_provider_config"]["bearer_token_auth"] == {"token_plaintext": "test-runtime-key"}
                service_config = next(body["config"] for method, path, _, body in server.calls if (method, path) == ("PATCH", PS))
                assert service_config["custom"]["direct"]["api_key"] == {"plaintext": "test-runtime-key"}
                assert_acl(server, NEW_ENDPOINT_ID)
                assert reports(server)[0]["outcome"] == "done"
                if kind == "rotate_key":
                    assert reports(server)[0]["result"] == {}

    def test_auth_012_every_apply_grants_endpoint_managers(self):
        server = self.server
        for case in [False, True]:
            with self.subTest(case=case):
                self.reset()
                exists = case
                server.answers[f"GET {EP}"] = LIVE["frozen_endpoint"] if exists else NOT_FOUND
                server.answers[f"PUT {EP}/config"] = LIVE["endpoint_deleted"]
                deliver(server)
                assert ("DELETE", EP) not in server.paths()
                assert_acl(server, OLD_ENDPOINT_ID if exists else NEW_ENDPOINT_ID)
                assert reports(server)[0]["outcome"] == "done"

    def test_auth_012_provider_create_also_grants_typed_principals(self):
        server = self.server
        server.answers[f"GET {PS}"] = NOT_FOUND
        server.answers["POST /api/2.1/unity-catalog/model-provider-services"] = LIVE["provider_managed"]
        deliver(server)
        assert ("PATCH", PS) not in server.paths()
        assert_acl(server, NEW_ENDPOINT_ID)
        assert reports(server)[0]["outcome"] == "done"

    def test_auth_012_delete_still_settling_defers_until_next_delivery(self):
        server = self.server
        server.answers[f"POST {CREATE}"] = [DELETION_PENDING, LIVE["endpoint_created"]]
        deliver(server)
        assert server.paths() == [("GET", EP), ("PUT", f"{EP}/config"), ("DELETE", EP), ("POST", CREATE)]
        assert reports(server) == []
        # The next lease finds the endpoint gone. It creates once, without another config update.
        server.answers[f"GET {EP}"] = NOT_FOUND
        deliver(server)
        assert server.paths().count(("PUT", f"{EP}/config")) == 1
        assert server.paths().count(("POST", CREATE)) == 2
        assert reports(server)[0]["outcome"] == "done"
        assert_acl(server, NEW_ENDPOINT_ID)

    def test_auth_012_data_001_unmanageable_provider_reports_only_fixed_code(self):
        server = self.server
        for case in product([(PS, "provider_update_refused"), (PS, "provider_update_admin_refused"),
                             (PS_ACL, "provider_manage_refused"), (PS_ACL, "provider_manage_admin_refused")],
                            ["setup", "rotate_key"]):
            with self.subTest(case=case):
                self.reset()
                (step, answer), kind = case
                server.answers[f"GET {PS}"] = LIVE["provider_orphan"]
                server.answers[f"PATCH {step}"] = LIVE[answer]
                deliver(server, kind=kind)
                assert reports(server) == [{"item_id": "recorded-item", "lease_id": "recorded-lease", "outcome": "failed",
                                            "result": {}, "error_code": "provider_service_unmanageable"}]
                assert ("DELETE", PS) not in server.paths()
                assert server.paths().count(("PATCH", step)) == 1
                assert ("PATCH", f"/api/2.0/permissions/serving-endpoints/{NEW_ENDPOINT_ID}") in server.paths()

    def test_auth_012_takeover_requires_permission_denied_before_message_classification(self):
        # Negative contract variants retain the recorded message but change the HTTP classification.
        cases = [("PUT", f"{EP}/config", "endpoint_frozen"),
                 ("PATCH", PS, "provider_update_refused"), ("PATCH", PS_ACL, "provider_manage_refused")]
        for target, (status, code) in product(cases, [(400, "PERMISSION_DENIED"), (403, "BAD_REQUEST"),
                                                    (429, "PERMISSION_DENIED"), (500, "PERMISSION_DENIED")]):
            with self.subTest(target=target, status=status, code=code):
                self.reset()
                method, path, answer = target
                variant = copy.deepcopy(LIVE[answer])
                variant["status"] = status
                variant["body"]["error_code"] = code
                self.server.answers[f"{method} {path}"] = variant
                deliver(self.server)
                assert self.server.paths().count((method, path)) == 1
                if status in (429, 500):
                    # Transient errors leave the lease unreported, so the normal retry path applies.
                    assert reports(self.server) == []
                else:
                    step = {"endpoint_frozen": "endpoint_update", "provider_update_refused": "service_update",
                            "provider_manage_refused": "service_grant"}[answer]
                    assert reports(self.server)[0]["error_code"] == f"{step}_http_{status}"
                if answer == "endpoint_frozen":
                    assert ("DELETE", EP) not in self.server.paths()
                    assert ("POST", CREATE) not in self.server.paths()

    def test_auth_012_other_refusals_keep_their_fixed_code(self):
        server = self.server
        for case in [
            ("PUT", f"{EP}/config", "endpoint_manage_refused", "endpoint_update_http_403"),
            ("DELETE", EP, "endpoint_delete_refused", "endpoint_delete_http_403"),
            ("PATCH", PS, "provider_use_refused", "service_update_http_403"),
            ("PATCH", PS_ACL, "provider_use_refused", "service_grant_http_403"),
        ]:
            with self.subTest(case=case):
                self.reset()
                method, path, answer, code = case
                server.answers[f"{method} {path}"] = LIVE[answer]
                deliver(server)
                assert reports(server)[0]["error_code"] == code
                if method == "PUT":
                    assert ("DELETE", EP) not in server.paths()
                    assert ("POST", CREATE) not in server.paths()

    def test_auth_012_invalid_exposure_principal_reports_before_any_workspace_write(self):
        server = self.server
        for case in product(["manage_principals", "query_principal"], INVALID_PRINCIPALS):
            with self.subTest(case=case):
                self.reset()
                field, invalid = case
                body = payload()
                body[field] = [invalid] if field == "manage_principals" else invalid
                deliver(server, body)
                assert server.paths() == [("POST", REPORT)]
                assert reports(server)[0]["error_code"] == "payload_invalid"

    def test_auth_012_null_query_principal_grants_only_managers(self):
        body = payload()
        body["query_principal"] = None
        deliver(self.server, body)
        acls = [body["access_control_list"] for method, path, _, body in self.server.calls
                if method == "PATCH" and "/permissions/serving-endpoints/" in path]
        assert len(acls) == len(MANAGERS)
        assert all(acl[0]["permission_level"] == "CAN_MANAGE" for acl in acls)
        changes = next(body["changes"] for _, path, _, body in self.server.calls if path == PS_ACL)
        assert changes == [{"principal": manager["name"], "add": ["MANAGE"]} for manager in MANAGERS]
        assert reports(self.server)[0]["outcome"] == "done"

    def test_auth_012_invalid_reader_or_owner_fails_before_writes(self):
        server = self.server
        for case in product([(setup_experiment, "read_principals"), (setup_results_table, "read_principals"), (disconnect, "results_owner")], INVALID_PRINCIPALS):
            with self.subTest(case=case):
                self.reset()
                (handler, field), invalid = case
                body = {"agent_principal": {"type": "service_principal", "name": SP},
                        field: invalid if field == "results_owner" else [invalid]}
                with self.assertRaises(Failed) as refused:
                    handler(Context(server.workspace(), "recorded-scope", 99), body)
                assert refused.exception.code == "payload_invalid"
                assert server.calls == []

    def test_auth_012_agent_principal_is_required_and_checked_before_workspace_writes(self):
        invalid_agents = [*INVALID_PRINCIPALS, None, MANAGERS[0], MANAGERS[2],
                          {"type": "service_principal", "name": ""}]
        for handler, invalid in product([setup_results_table, disconnect], ["missing", *invalid_agents]):
            with self.subTest(handler=handler, invalid=invalid):
                self.reset()
                body = {"table": "workspace.br_design.results", "results_table": "workspace.br_design.results",
                        "warehouse_id": "recorded", "columns": [{"name": "written_at", "type": "TIMESTAMP"}],
                        "exposures": [{"endpoint_name": ENDPOINT, "provider_service": SERVICE}], "volumes": []}
                if invalid != "missing":
                    body["agent_principal"] = invalid
                with self.assertRaises(Failed) as refused:
                    handler(Context(self.server.workspace(), "recorded-scope", 99), body)
                assert refused.exception.code == "payload_invalid"
                assert self.server.calls == []

    def test_auth_012_disconnect_uses_typed_owner_for_sql_and_experiment(self):
        server = self.server
        for case in [*MANAGERS, None]:
            with self.subTest(case=case):
                self.reset()
                owner = case
                handover = json.loads((Path(__file__).parent / "fixtures" / "handover" / "visible_table_owner_refused.json").read_text())
                succeeded = json.loads((Path(__file__).parent / "fixtures" / "reinstall" / "answers.json").read_text())["statement_succeeded"]
                server.answers.update({
                    "GET /api/2.1/unity-catalog/tables/workspace.br_design.results": {"status": 200, "body": {**handover["table_get"], "owner": SP}},
                    "POST /api/2.0/sql/statements": succeeded,
                    "GET /api/2.0/mlflow/experiments/get-by-name": {"status": 200, "body": {"experiment": {"experiment_id": "77"}}},
                    "PATCH /api/2.0/permissions/experiments/77": LIVE["endpoint_acl"],
                })
                outcome = disconnect(Context(server.workspace(), "recorded-scope", 99), {
                    "results_owner": owner, "results_table": "workspace.br_design.results", "warehouse_id": "recorded",
                    "experiment_path": "/Shared/benchrouter/recorded", "agent_principal": {"type": "service_principal", "name": SP}, "volumes": [],
                })
                writes = [(path, body) for method, path, _, body in server.calls if method != "GET"]
                assert outcome.result == {}
                if owner is None:
                    assert writes == []
                else:
                    assert writes[0][1]["statement"] == f"ALTER TABLE `workspace`.`br_design`.`results` OWNER TO `{owner['name']}`"
                    field = {"user": "user_name", "service_principal": "service_principal_name", "group": "group_name"}[owner["type"]]
                    assert writes[1] == ("/api/2.0/permissions/experiments/77", {
                        "access_control_list": [{field: owner["name"], "permission_level": "CAN_MANAGE"}],
                    })


if __name__ == "__main__":
    unittest.main()
