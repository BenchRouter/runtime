"""The app's screens: Connect, Routes, Add eval, Status and Disconnect (plan section 4.1).

Each request reads the admin from the Apps proxy headers, their BenchRouter sign-in from the
app SP's scope, and this workspace's binding from BenchRouter. Nothing else is kept between
requests. A screen asks the admin to act only on what only they can fix; everything that
BenchRouter or the agent job retries is shown as state, with no Retry button.
"""

from __future__ import annotations

import functools
import logging
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from flask import Flask, abort, redirect, render_template, request

from benchrouter_databricks.transport import ApiError, TransportError

from . import api, identity, store, workspace_ops

app = Flask(__name__)
log = logging.getLogger("benchrouter_app")

CLOSED_STATES = {"disconnected", "archived"}
#: A binding still `connecting` after this long had a Connect that stopped partway.
CONNECT_STALE = timedelta(minutes=10)
STATE_LABEL = {"connecting": "Connecting", "verified": "Connected", "agent_silent": "Agent silent",
               "disconnected": "Disconnected", "archived": "Disconnected"}
#: Endpoint names allow a-z, 0-9 and - (plan section 4.2).
ENDPOINT_CHARS = set("abcdefghijklmnopqrstuvwxyz0123456789-")


@dataclass
class Session:
    user_name: str
    user: Any
    sign_in: dict[str, Any] | None
    binding: dict[str, Any] | None = None
    detail: dict[str, Any] | None = None

    @property
    def token(self) -> str:
        assert self.sign_in is not None
        return str(self.sign_in["token"])


def current_session() -> Session:
    user_name = request.headers.get("X-Forwarded-Email") or request.headers.get("X-Forwarded-Preferred-Username")
    forwarded = request.headers.get("X-Forwarded-Access-Token")
    if not user_name or not forwarded:
        abort(403)
    return Session(user_name, identity.user_workspace(forwarded), store.sign_in(identity.app_workspace(), user_name))


def load_binding(session: Session) -> None:
    """This workspace's newest binding of the signed-in account, if it is still open."""
    host = urllib.parse.urlsplit(identity.workspace_url()).hostname
    for binding in api.list_bindings(session.token):
        if binding["host"] == host:
            if binding["state"] not in CLOSED_STATES:
                session.binding = binding
                session.detail = api.get_binding(session.token, binding["id"])
            return


@app.before_request
def same_origin_posts() -> None:
    # The Apps proxy signs the admin in with a cookie, so a form on another site must not post here.
    if request.method == "POST" and request.headers.get("Sec-Fetch-Site", "same-origin") != "same-origin":
        abort(403)


@app.errorhandler(TransportError)
def unreachable(_: Exception):
    return render_template("problem.html", session=None, title="BenchRouter did not answer",
                           detail="The page reloads in a few seconds.", refresh=5), 503


@app.errorhandler(ApiError)
def refused(error: ApiError):
    if error.transient:
        return render_template("problem.html", session=None, title="A service is busy",
                               detail="The page reloads in a few seconds.", refresh=5), 503
    log.warning("api refused status=%s code=%s", error.status, error.code)
    return render_template("problem.html", session=None, title="This request was refused",
                           detail=error.message or f"The answer was {error.status} {error.code or ''}.".strip()), 400


def signed_in(view):
    """Runs `view(session)` for a signed-in admin; else shows Sign in."""
    @functools.wraps(view)
    def wrapper(*args: Any, **kwargs: Any):
        session = current_session()
        if session.sign_in is None:
            return sign_in_screen(session)
        try:
            load_binding(session)
        except ApiError as error:
            if error.status == 401:
                # Expired or revoked: sign in again, as the CLI does.
                store.forget_sign_in(identity.app_workspace(), session.user_name)
                return sign_in_screen(session, notice="Your BenchRouter sign-in ended. Sign in again.")
            raise
        return view(session, *args, **kwargs)
    return wrapper


def page(template: str, session: Session, **values: Any):
    return render_template(template, session=session, state_label=STATE_LABEL, dashboard_url=api.dashboard_url,
                           workspace_url=identity.workspace_url(), default_endpoint=default_endpoint_name, **values)


# Sign-in (AUTH-006: the CLI authorization flow).
def sign_in_screen(session: Session, notice: str | None = None):
    app_sp = identity.app_workspace()
    pending = store.pending_sign_in(app_sp, session.user_name)
    if pending is not None:
        status = api.sign_in_status(pending)
        if status == "approved":
            store.save_sign_in(app_sp, session.user_name, api.finish_sign_in(pending))
            store.forget_pending_sign_in(app_sp, session.user_name)
            return redirect("/")
        if status == "pending":
            return page("sign_in.html", session, pending=pending)
        store.forget_pending_sign_in(app_sp, session.user_name)
        notice = notice or "The sign-in link expired or was declined. Start again."
    return page("sign_in.html", session, pending=None, notice=notice)


@app.post("/sign-in")
def start_sign_in():
    session = current_session()
    host = urllib.parse.urlsplit(identity.workspace_url()).hostname
    store.save_pending_sign_in(identity.app_workspace(), session.user_name, api.start_sign_in(f"Databricks {host}"))
    return redirect("/")


@app.post("/sign-out")
def sign_out():
    session = current_session()
    store.forget_sign_in(identity.app_workspace(), session.user_name)
    return redirect("/")


# Connect.
@app.get("/")
@signed_in
def home(session: Session):
    if session.binding is None:
        return connect_screen(session)
    if session.binding["state"] == "connecting":
        return redirect("/status")
    return redirect("/routes")


def connect_screen(session: Session, **values: Any):
    return page("connect.html", session, warehouses=workspace_ops.warehouses(session.user),
                form=values.pop("form", {"catalog": "workspace", "schema": "default"}), **values)


@app.post("/connect")
@signed_in
def connect(session: Session):
    if session.binding is not None and session.binding["disconnect_requested_at"] is not None:
        return redirect("/status")
    form = {name: (request.form.get(name) or "").strip() for name in ("catalog", "schema", "warehouse_id")}
    if not all(form.values()):
        return connect_screen(session, form=form, error="Choose a catalog, a schema and a SQL warehouse.")
    try:
        result = workspace_ops.connect(session.token, session.user, session.user_name,
                                       form["catalog"], form["schema"], form["warehouse_id"])
    except ApiError as error:
        if error.code == "connect_superseded":
            # Another Connect of this workspace finished after this one began; Status shows it.
            return redirect("/status")
        return connect_screen(session, form=form, error=error.message or f"Connect was refused ({error.code or error.status}).")
    if result.refusal is not None:
        return connect_screen(session, form=form, refusal=result.refusal)
    return redirect("/status")


# Routes: every route of the account, New route and Expose.
def routes_screen(session: Session, **values: Any):
    detail = session.detail or {}
    exposures = {entry["route_key"]: entry for entry in detail.get("exposures", [])}
    serving = {entry["route_key"]: entry for entry in api.account_routes(session.token)}
    products = sorted({route["route_key"].split("/", 1)[0] for route in detail.get("routes", [])})
    return page("routes.html", session, routes=detail.get("routes", []), exposures=exposures, serving=serving,
                products=products, models=api.catalog_models(), **values)


@app.get("/routes")
@signed_in
def routes(session: Session):
    if session.binding is None:
        return redirect("/")
    created = request.args.get("created")
    exposed = request.args.get("exposed")
    return routes_screen(session, created=created, exposed=exposed)


@app.post("/routes/new")
@signed_in
def new_route(session: Session):
    form = {name: (request.form.get(name) or "").strip() for name in ("product", "name", "model")}
    if not all(form.values()):
        return routes_screen(session, new_route_form=form, new_route_error="Fill in the product, the route name and the model.")
    try:
        created = api.create_route(session.token, form["product"], form["name"], form["model"])
    except ApiError as error:
        return routes_screen(session, new_route_form=form, new_route_error=error.message or "The route was not created.")
    return redirect(f"/routes?created={urllib.parse.quote(created['route_key'])}")


def default_endpoint_name(route_key: str) -> str:
    name = "".join(char if char in ENDPOINT_CHARS else "-" for char in route_key.lower())
    return f"br-{name}"[:63].strip("-")


@app.post("/routes/expose")
@signed_in
def expose(session: Session):
    if session.binding is None:
        return redirect("/")
    route_key = request.form.get("route_key") or ""
    endpoint = (request.form.get("endpoint_name") or default_endpoint_name(route_key)).strip()
    # Unity Catalog grants EXECUTE on the provider service, so the caller group must be an account
    # group: it answers 404 for the workspace-local `users` and `admins` (plan section 4.6).
    query_group = (request.form.get("query_principal") or "account users").strip()
    try:
        api.expose_route(session.token, session.binding["id"], {
            "route_key": route_key, "endpoint_name": endpoint,
            "admin_user_name": session.user_name, "query_principal": query_group,
        })
    except ApiError as error:
        return routes_screen(session, expose_error={"route_key": route_key, "message": error.message or "Expose was refused."})
    workspace_ops.start_agent(session.binding.get("agent_job_id"))
    return redirect(f"/routes?exposed={urllib.parse.quote(route_key)}")


@app.post("/routes/unexpose")
@signed_in
def unexpose(session: Session):
    if session.binding is None:
        return redirect("/")
    try:
        api.unexpose_route(session.token, session.binding["id"], request.form.get("route_key") or "")
    except ApiError as error:
        if error.status != 404:
            raise
    workspace_ops.start_agent(session.binding.get("agent_job_id"))
    return redirect("/routes")


# Add eval.
def evals_screen(session: Session, **values: Any):
    detail = session.detail or {}
    return page("evals.html", session, routes=detail.get("routes", []),
                form=values.pop("form", {"route_key": request.args.get("route", ""), "eval_folder": ""}), **values)


@app.get("/evals")
@signed_in
def evals(session: Session):
    if session.binding is None:
        return redirect("/")
    return evals_screen(session)


@app.post("/evals")
@signed_in
def add_eval(session: Session):
    if session.binding is None:
        return redirect("/")
    form = {name: (request.form.get(name) or "").strip().rstrip("/") for name in ("route_key", "eval_folder")}
    try:
        manifest = workspace_ops.read_manifest(session.user, form["eval_folder"], form["route_key"])
    except workspace_ops.ManifestInvalid as invalid:
        return evals_screen(session, form=form, error=str(invalid))
    except ApiError as error:
        return evals_screen(session, form=form, error=error.message or "The eval folder could not be read.")
    try:
        api.add_eval(session.token, session.binding["id"], form["route_key"], form["eval_folder"])
    except ApiError as error:
        declaration = error.detail.get("declaration") if error.code == "route_eval_in_repo" else None
        return evals_screen(session, form=form, error=error.message or "Add eval was refused.", declaration=declaration)
    refusal = workspace_ops.share_eval(session.user, session.binding["warehouse_id"], form["eval_folder"], manifest.cases_table)
    if refusal is not None:
        return evals_screen(session, form=form, refusal=refusal)
    workspace_ops.start_agent(session.binding.get("agent_job_id"))
    return redirect(f"/status?added={urllib.parse.quote(form['route_key'])}")


# Status.
@app.get("/status")
@signed_in
def status(session: Session):
    if session.binding is None:
        return redirect("/")
    detail = session.detail or {}
    app_sp = identity.app_workspace()
    serving = {entry["route_key"]: entry for entry in api.account_routes(session.token)}
    evals = []
    for entry in detail.get("evals", []):
        if entry["state"] != "attached":
            continue
        try:
            manifest = workspace_ops.read_manifest(app_sp, entry["eval_folder"], entry["route_key"])
            secrets, manifest_error = workspace_ops.check_secrets(app_sp, manifest.secrets), None
        except workspace_ops.ManifestInvalid as invalid:
            secrets, manifest_error = [], str(invalid)
        except ApiError:
            secrets, manifest_error = [], "The app cannot read this folder. Add the eval again to share it."
        evals.append({"eval": entry, "route": serving.get(entry["route_key"]), "secrets": secrets, "manifest_error": manifest_error})
    updated = datetime.fromisoformat(session.binding["updated_at"].replace("Z", "+00:00"))
    stalled = session.binding["state"] == "connecting" and datetime.now(timezone.utc) - updated > CONNECT_STALE
    return page("status.html", session, evals=evals, exposures=detail.get("exposures", []),
                app_sp=identity.app_sp_client_id(), added=request.args.get("added"), stalled=stalled)


# Disconnect.
@app.get("/disconnect")
@signed_in
def disconnect_screen(session: Session):
    if session.binding is None:
        return redirect("/")
    return page("disconnect.html", session, exposures=(session.detail or {}).get("exposures", []))


@app.post("/disconnect")
@signed_in
def disconnect(session: Session):
    if session.binding is None:
        return redirect("/")
    results_owner = (request.form.get("results_owner") or "").strip() or None
    try:
        outcome = api.disconnect(session.token, session.binding["id"], results_owner)
    except ApiError as error:
        return page("disconnect.html", session, exposures=(session.detail or {}).get("exposures", []),
                    error=error.message or "Disconnect was refused.")
    if outcome.get("cleanup") == "queued":
        workspace_ops.start_agent(session.binding.get("agent_job_id"))
        return redirect("/status")
    # No agent ever polled, so no agent cleans up: delete the job and the scope Connect made.
    workspace_ops.remove_agent(identity.app_workspace())
    return redirect("/")
