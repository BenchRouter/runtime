"""Plan 4.1 and 4.7: each install keeps its sign-ins and its poll key in a scope of its own.

B11 smoke (2026-10-29): the customer deleted the app without Disconnect, so the scope `benchrouter`
that the deleted SP made stayed, with its ACL. A new install's SP could not write it, and sign-in
failed before Connect could run. Now the scope is named from the app SP, so a new install never
touches an old one's scope, and Status offers the old scope's deletion as an optional clean-up.

The Secrets API answers replay the documented shapes (fixtures/scopes) over a local socket,
through the app's own HTTP client.
"""

import json
import os
import unittest
from pathlib import Path

from benchrouter_app import main, store, workspace_ops
from benchrouter_databricks.manifest import ManifestError, is_benchrouter_scope
from tests.recorded_workspace import RecordedServer
from tests.test_app_manifest import MANIFEST, ROUTE

ANSWERS = json.loads((Path(__file__).parent / "fixtures" / "scopes" / "answers.json").read_text())
THIS_SP = ANSWERS["this_sp"]
#: The same vectors as test/replay-databricks-install-scope.test.ts: the app and Connect agree.
THIS_SCOPE = "benchrouter-219f290838be"
OLD_SP_SCOPE = "benchrouter-47f05528eaed"


class InstallScope(unittest.TestCase):
    def setUp(self) -> None:
        self.saved = {name: os.environ.get(name) for name in ("DATABRICKS_CLIENT_ID", "DATABRICKS_HOST")}
        os.environ["DATABRICKS_CLIENT_ID"] = THIS_SP
        os.environ["DATABRICKS_HOST"] = "https://dbc-reinstall.cloud.databricks.com"
        self.server = RecordedServer({
            "POST /api/2.0/secrets/scopes/create": ANSWERS["scope_created"],
            "POST /api/2.0/secrets/put": ANSWERS["secret_put"],
            "GET /api/2.0/secrets/scopes/list": ANSWERS["scopes_listed"],
        })

    def tearDown(self) -> None:
        self.server.close()
        for name, value in self.saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

    def test_the_scope_is_named_from_the_app_sp_as_connect_names_it(self) -> None:
        self.assertEqual(store.scope(), THIS_SCOPE)
        self.assertEqual(store.install_scope(THIS_SP.upper()), THIS_SCOPE)
        self.assertEqual(store.install_scope("6f1c2b0e-1d2a-4c3b-9e8f-0a1b2c3d4e5f"), OLD_SP_SCOPE)

    def test_a_sign_in_is_kept_in_this_installs_scope(self) -> None:
        store.save_sign_in(self.server.workspace(), "admin@example.com", {"token": "br_ctrl_recorded"})
        writes = [(path, body["scope"]) for method, path, _, body in self.server.calls if method == "POST"]
        self.assertEqual(writes, [("/api/2.0/secrets/scopes/create", THIS_SCOPE), ("/api/2.0/secrets/put", THIS_SCOPE)])

    def test_status_names_every_other_benchrouter_scope_and_never_its_own(self) -> None:
        self.assertEqual(workspace_ops.stale_scopes(self.server.workspace()), ["benchrouter", OLD_SP_SCOPE])
        self.server.answers["GET /api/2.0/secrets/scopes/list"] = ANSWERS["scopes_only_own"]
        self.assertEqual(workspace_ops.stale_scopes(self.server.workspace()), [])

    def test_a_refused_scope_list_shows_nothing(self) -> None:
        self.server.answers["GET /api/2.0/secrets/scopes/list"] = ANSWERS["scopes_list_refused"]
        self.assertEqual(workspace_ops.stale_scopes(self.server.workspace()), [])

    def test_status_shows_the_clean_up_as_an_optional_note_with_the_command(self) -> None:
        binding = {"state": "verified", "host": "dbc-reinstall.cloud.databricks.com", "id": "dbxb_scope", "disconnect_requested_at": None,
                   "last_poll_at": None, "last_agent_version": None, "cadence_seconds": 3600, "catalog": "workspace", "schema": "br_b11",
                   "agent_job_id": None, "eval_job_id": None}
        session = main.Session("admin@example.com", None, None, binding, {})

        def render(stale: list[str]) -> str:
            with main.app.test_request_context("/status"):
                return str(main.page("status.html", session, evals=[], exposures=[], app_sp=THIS_SP, scope=THIS_SCOPE, stale_scopes=stale,
                                     added=None, stalled=False, disconnect_failure=None, setup_failure=None))

        page = render([OLD_SP_SCOPE])
        self.assertIn("Clean up (optional)", page)
        self.assertIn(f"databricks secrets delete-scope {OLD_SP_SCOPE}", page)
        self.assertIn("holds only revoked keys", page)
        self.assertNotIn("notice bad", page)
        self.assertNotIn("Clean up", render([]))


class SignInNamesTheWorkspace(unittest.TestCase):
    """AUTH-006: the app's sign-in records its workspace host, which a Reconnect by a new app SP uses
    to revoke only that workspace's old sign-ins (src/databricks/connect.ts)."""

    def test_the_authorization_carries_the_host(self) -> None:
        from benchrouter_app import api

        server = RecordedServer({"POST /v1/cli/authorizations": {"status": 201, "body": {
            "transaction_id": "cliauth_recorded", "authorize_url": "https://benchrouter.com/cli/authorize?transaction=cliauth_recorded",
            "expires_at": "2026-10-29T15:00:00.000Z", "poll_after_ms": 1000}}})
        saved = api.API_BASE
        api.API_BASE = server.base
        try:
            api.start_sign_in("dbc-513858aa-8b30.cloud.databricks.com")
        finally:
            api.API_BASE = saved
            server.close()
        body = server.calls[0][3]
        self.assertEqual({name: body[name] for name in ("client_name", "token_name", "databricks_host")}, {
            "client_name": "BenchRouter Databricks app", "token_name": "Databricks dbc-513858aa-8b30.cloud.databricks.com",
            "databricks_host": "dbc-513858aa-8b30.cloud.databricks.com"})


class ReservedScopes(unittest.TestCase):
    def test_a_manifest_may_name_no_benchrouter_scope(self) -> None:
        from benchrouter_databricks.manifest import load_manifest

        for scope in ("benchrouter", "BenchRouter", THIS_SCOPE, OLD_SP_SCOPE.upper()):
            with self.assertRaises(ManifestError) as raised:
                load_manifest(MANIFEST.replace("secret_scope: acme-evals", f"secret_scope: {scope}"), ROUTE)
            self.assertEqual(raised.exception.code, "secret_scope_reserved")
        self.assertEqual(load_manifest(MANIFEST.replace("acme-evals", "benchrouter_evals"), ROUTE).secrets[0].scope, "benchrouter_evals")
        self.assertFalse(is_benchrouter_scope("acme-benchrouter"))


if __name__ == "__main__":
    unittest.main()
