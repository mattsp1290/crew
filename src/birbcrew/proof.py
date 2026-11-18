import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import httpx
from pydantic_ai.durable_exec.temporal import PydanticAIPlugin
from temporalio.client import Client

from birbcrew import store
from birbcrew.beans import FixtureHub
from birbcrew.config import settings, write_private
from birbcrew.domain import workflow_id
from birbcrew.provider import ENDPOINT, MODEL, preflight_account

REPO = Path(__file__).resolve().parents[2]
POSTGRES = "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"
PROMPT = (
    "Review the disposable coding fixture notes. Record one synthetic work item to add "
    "a regression test for conversation reconnection. Ask me whether to inspect or test "
    "next. After I answer, summarize the item and my choice. No real repository actions."
)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for(predicate, description, timeout=90):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            result = predicate()
            if result:
                return result
        except (httpx.TransportError, OSError) as error:
            last = type(error).__name__
        time.sleep(0.15)
    raise AssertionError(f"Timed out waiting for {description}; last error={last}")


class Proof:
    def __init__(self, args):
        self.root = Path(tempfile.mkdtemp(prefix="birbcrew-proof-"))
        print(f"FIXTURE {self.root}", flush=True)
        self.args = args
        self.processes = {}
        self.generations = {}
        self.container = f"birbcrew-proof-{uuid4().hex[:12]}"
        self.report = {
            "started_at": datetime.now(UTC).isoformat(),
            "mode": args.mode,
            "gates": {
                name: {"status": "NOT VERIFIED", "evidence": "Not exercised in this run"}
                for name in [
                    "normal_interaction",
                    "duplicate_submission",
                    "reconnect",
                    "gateway_restart",
                    "worker_interruption",
                    "human_wait",
                    "conflicting_response",
                    "explicit_cancellation",
                    "isolation",
                    "shared_context",
                    "telemetry",
                    "real_subscription",
                ]
            },
            "process_terminations": [],
            "conversations": [],
            "fixture_root": str(self.root),
        }
        self.tokens = {p: secrets.token_urlsafe(32) for p in ["owner", "stranger"]}
        self.port = free_port()
        self.temporal_port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.client = httpx.Client(
            base_url=self.url,
            timeout=40,
            headers={"Authorization": "Bearer " + self.tokens["owner"]},
        )

    def start(self, name, command):
        generation = self.generations.get(name, 0) + 1
        self.generations[name] = generation
        path = self.root / f"{name}-{generation}.log"
        with path.open("w") as log:
            process = subprocess.Popen(
                command,
                cwd=REPO,
                env={
                    k: v
                    for k, v in os.environ.items()
                    if k not in {"PYTHONPATH", "LD_PRELOAD"} and not k.startswith(("DD_", "OTEL_"))
                }
                | {
                    "DD_TRACE_ENABLED": "false",
                    "DD_INJECTION_ENABLED": "false",
                    "DD_INSTRUMENTATION_TELEMETRY_ENABLED": "false",
                },
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        self.processes[name] = process
        return process

    def stop(self, name, kill=False):
        process = self.processes.pop(name, None)
        if process and process.poll() is None:
            process.send_signal(signal.SIGKILL if kill else signal.SIGTERM)
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            self.report["process_terminations"].append(
                {
                    "process": name,
                    "pid": process.pid,
                    "signal": "SIGKILL" if kill else "SIGTERM",
                    "at": datetime.now(UTC).isoformat(),
                }
            )

    def boot(self):
        fixture = FixtureHub(self.root / "beans")
        fixture.seed()
        notes = fixture.capture()
        self.report["beans"] = notes.model_dump(mode="json")
        password = secrets.token_urlsafe(24)
        env_file = self.root / "postgres.env"
        env_file.write_text(
            f"POSTGRES_PASSWORD={password}\nPOSTGRES_USER=birbcrew\nPOSTGRES_DB=birbcrew\n"
        )
        env_file.chmod(0o600)
        subprocess.run(
            [
                "docker",
                "run",
                "-d",
                "--rm",
                "--name",
                self.container,
                "--env-file",
                str(env_file),
                "-p",
                "127.0.0.1::5432",
                POSTGRES,
            ],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        port = (
            subprocess.check_output(["docker", "port", self.container, "5432/tcp"], text=True)
            .strip()
            .rsplit(":", 1)[1]
        )
        config = {
            "database_url": f"postgresql://birbcrew:{password}@127.0.0.1:{port}/birbcrew",
            "temporal_address": f"127.0.0.1:{self.temporal_port}",
            "task_queue": f"proof-{self.root.name}",
            "token_hashes": {
                p: hashlib.sha256(t.encode()).hexdigest() for p, t in self.tokens.items()
            },
            "context": notes.model_dump(mode="json"),
            "evidence_dir": str(self.root),
            "mode": self.args.mode,
            "interrupt_after_effect": self.args.mode == "test",
        }
        write_private(self.root / "config.json", config)
        write_private(self.root / "clients.json", {"url": self.url, "tokens": self.tokens})
        os.environ["BIRBCREW_CONFIG"] = str(self.root / "config.json")
        settings.cache_clear()
        wait_for(
            lambda: (
                subprocess.run(
                    [
                        "docker",
                        "exec",
                        self.container,
                        "pg_isready",
                        "-h",
                        "127.0.0.1",
                        "-U",
                        "birbcrew",
                    ],
                    capture_output=True,
                ).returncode
                == 0
            ),
            "PostgreSQL",
        )
        asyncio.run(store.migrate())
        self.start(
            "temporal",
            [
                str(REPO / ".proof/bin/temporal"),
                "server",
                "start-dev",
                "--ip",
                "127.0.0.1",
                "--port",
                str(self.temporal_port),
                "--headless",
                "--db-filename",
                str(self.root / "temporal.db"),
            ],
        )
        wait_for(lambda: self.temporal_ready(), "Temporal")
        self.start_worker()
        self.start_gateway()
        self.report["versions"] = {
            "python": sys.version.split()[0],
            **{
                p: importlib.metadata.version(p)
                for p in [
                    "pydantic-ai-slim",
                    "pydantic",
                    "ag-ui-protocol",
                    "temporalio",
                    "psycopg",
                    "fastapi",
                    "uvicorn",
                    "opentelemetry-sdk",
                    "httpx-sse",
                ]
            },
            "temporal": subprocess.check_output(
                [str(REPO / ".proof/bin/temporal"), "--version"], text=True
            ).strip(),
            "postgres": subprocess.check_output(
                ["docker", "exec", self.container, "postgres", "--version"], text=True
            ).strip(),
            "bn": subprocess.check_output(
                [
                    "bn",
                    "--hub",
                    str(fixture.hub),
                    "--project",
                    "birbcrew",
                    "--actor",
                    "birbcrew-proof",
                    "--version",
                ],
                text=True,
            ).strip(),
        }

    def temporal_ready(self):
        with socket.socket() as s:
            return s.connect_ex(("127.0.0.1", self.temporal_port)) == 0

    def start_worker(self):
        process = self.start("worker", [sys.executable, "-I", "-m", "birbcrew.worker"])
        logfile = self.root / f"worker-{self.generations['worker']}.log"

        def ready():
            if process.poll() is not None:
                raise AssertionError(f"Worker exited. Inspect {logfile}")
            return "worker-ready" in logfile.read_text()

        wait_for(ready, "worker ready")

    def start_gateway(self):
        self.start(
            "gateway",
            [
                sys.executable,
                "-I",
                "-m",
                "uvicorn",
                "birbcrew.api:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(self.port),
                "--no-access-log",
            ],
        )
        wait_for(lambda: self.client.get("/health").status_code == 200, "gateway")

    def request(self, method, path, status=200, **kwargs):
        response = self.client.request(method, path, **kwargs)
        assert response.status_code == status, (method, path, response.status_code, response.text)
        return response.json()

    def state(self, cid):
        return self.request("GET", f"/conversations/{cid}")

    def phase(self, cid, phase, timeout=100):
        def check():
            state = self.state(cid)
            if state["phase"] == "failed":
                raise AssertionError(
                    f"Conversation failed: {state['failure']}. Inspect {self.root}"
                )
            return state if state["phase"] == phase else None

        return wait_for(check, phase, timeout)

    def gate(self, name, evidence):
        self.report["gates"][name] = {"status": "VERIFIED", "evidence": evidence}
        print(f"VERIFIED {name}", flush=True)
        self.save_report()

    def new_conversation(self):
        cid = str(uuid4())
        self.request("POST", "/conversations", json={"id": cid})
        self.report["conversations"].append({"id": cid, "workflow_id": workflow_id(cid)})
        return cid

    def submit(self, cid):
        payload = {"request_id": str(uuid4()), "text": PROMPT}
        result = self.request("POST", f"/conversations/{cid}/inputs", json=payload)
        return payload, result

    def client_start(self, name, cid, after=None):
        return self.start(
            name,
            [
                str(REPO / ".proof/bin/node"),
                "clients/observe.mjs",
                str(self.root / "clients.json"),
                cid,
                str(self.root / f"{name}.jsonl"),
                *([str(after)] if after is not None else []),
            ],
        )

    def journey(self):
        cid = self.new_conversation()
        self.client_start("client-a", cid)
        wait_for(lambda: self.client_has("client-a", "STATE_SNAPSHOT"), "client A connected")
        payload, accepted = self.submit(cid)
        repeated = self.request("POST", f"/conversations/{cid}/inputs", json=payload)
        assert repeated["request_id"] == accepted["request_id"]
        self.request(
            "POST",
            f"/conversations/{cid}/inputs",
            status=409,
            json={**payload, "text": "different payload"},
        )
        if self.args.mode == "test":
            rows = wait_for(lambda: asyncio.run(store.operation_rows(cid)), "committed effect")
            assert len(rows) == 1
            wait_for(lambda: self.client_has("client-a", "TOOL_CALL_START"), "tool progress", 5)
            active = self.state(cid)
            assert active["phase"] == "running"
            self.client_start("client-b-midrun", cid, after=active["cursor"])
            wait_for(
                lambda: self.client_has("client-b-midrun", "TOOL_CALL_START"),
                "mid-run client B",
                10,
            )
            assert self.state(cid)["phase"] == "running"
            assert self.processes["client-b-midrun"].poll() is None
            assert self.client_has("client-b-midrun", "STEP_STARTED")
            self.report["mid_run_reconnect"] = {
                "phase_before_and_after_attach": "running",
                "client": "B",
                "sdk_tool_start_received": True,
                "sdk_step_start_received": True,
                "cursor": active["cursor"],
                "effect_not_acknowledged": True,
            }
            self.stop("client-b-midrun")
            self.stop("client-a")
            self.stop("worker", kill=True)
            self.stop("gateway", kill=True)
            self.report["interruption_point"] = {
                "operation_id": rows[0]["operation_id"],
                "rows_before_kill": len(rows),
                "workflow_activity_result": "not acknowledged; tool blocked after commit",
            }
            self.start_gateway()
            self.start_worker()
        pending = self.phase(cid, "waiting", timeout=400)
        self.stop("client-a")
        assert pending["human"] and len(pending["inputs"]) == 1
        rows = asyncio.run(store.operation_rows(cid))
        assert len(rows) == 1
        self.report["operations"] = rows
        self.gate(
            "duplicate_submission",
            {"input_count": 1, "operation_count": len(rows), "conflicting_payload_http": 409},
        )
        if self.args.mode == "test":
            assert rows[0]["deliveries"] >= 2
            self.gate(
                "worker_interruption",
                self.report["interruption_point"]
                | {"deliveries_after_recovery": rows[0]["deliveries"], "effect_rows": 1},
            )
        assert pending["context"] == self.report["beans"]
        assert "UNRELATED_FIXTURE" not in json.dumps(pending)
        self.gate(
            "shared_context",
            {
                "context": pending["context"],
                "unrelated_note_absent": "UNRELATED_FIXTURE" not in json.dumps(pending),
            },
        )
        assert pending["context"] == self.report["beans"]
        assert "UNRELATED_FIXTURE" not in json.dumps(pending)
        self.stop("worker", kill=True)
        self.stop("gateway", kill=True)
        self.start_worker()
        self.start_gateway()
        reconnected = self.state(cid)
        assert pending["native_messages"] == reconnected["native_messages"]
        assert pending["messages"] == reconnected["messages"]
        assert pending["human"] == reconnected["human"]
        self.gate(
            "gateway_restart",
            {"messages": len(reconnected["messages"]), "same_finalized_history": True},
        )
        self.client_start("client-b", cid, after=reconnected["cursor"])
        self.client_start("client-a", cid)
        wait_for(lambda: self.client_has("client-b", "STATE_SNAPSHOT"), "client B connected")
        self.isolation(cid, payload, pending)
        human = pending["human"]
        response = {
            "request_id": human["id"],
            "version": human["version"],
            "choice": "test",
        }
        self.request(
            "POST", f"/conversations/{cid}/human", status=409, json={**response, "version": 0}
        )
        result = subprocess.check_output(
            [
                str(REPO / ".proof/bin/node"),
                "clients/resolve.mjs",
                str(self.root / "clients.json"),
                cid,
                human["id"],
                str(human["version"]),
                "test",
            ],
            cwd=REPO,
            text=True,
        )
        self.report["client_b_resolution"] = json.loads(result)
        self.request("POST", f"/conversations/{cid}/human", json=response)
        self.request(
            "POST",
            f"/conversations/{cid}/human",
            status=409,
            json={**response, "choice": "inspect"},
        )
        final = self.phase(cid, "idle", timeout=400)
        assert final["inputs"][0]["outcome"] == "completed"
        assert final["decisions"][0]["resolution"] == "test"
        assert len(asyncio.run(store.operation_rows(cid))) == 1
        for before, after in zip(pending["native_messages"], final["native_messages"]):
            assert before.get("timestamp") == after.get("timestamp")
            for old_part, new_part in zip(before["parts"], after["parts"]):
                assert old_part == new_part
        self.report["framework_history_preserved_after_replay"] = True
        assert len({m["id"] for m in final["messages"]}) == len(final["messages"])
        self.gate(
            "human_wait",
            {
                "request": human,
                "resolution": final["decisions"][0],
                "survived_worker_and_gateway_restart": True,
            },
        )
        self.gate(
            "conflicting_response",
            {"wrong_version_http": 409, "conflict_http": 409, "identical_retry_accepted": True},
        )
        self.gate(
            "reconnect",
            {
                "same_conversation": cid,
                "accepted_inputs": len(final["inputs"]),
                "unique_finalized_message_ids": len(final["messages"]),
            },
        )
        wait_for(lambda: self.client_has("client-b", "TEXT_MESSAGE_CONTENT"), "AG-UI text")
        for name in ["client-a", "client-b"]:
            path = self.root / f"{name}.jsonl.messages.json"
            wait_for(
                lambda: path.exists() and json.loads(path.read_text()) == final["messages"],
                f"{name} authoritative finalized messages",
            )
            self.stop(name)
        self.validate_events()
        self.gate(
            "normal_interaction",
            {"sdk": "@ag-ui/client 1.0.4", "text_tool_and_finalized_messages": True},
        )
        self.report["final_snapshot"] = final
        if self.args.mode == "test":
            self.second_turn(cid, final)
            self.cancel_human_wait(cid)
            self.cancel_journey()
            self.cursor_expiry(self.new_conversation())
        self.request("POST", f"/conversations/{cid}/cancel", status=202)
        self.phase(cid, "cancelled")
        self.capture_history()
        result = subprocess.check_output(
            [
                sys.executable,
                "-I",
                "-m",
                "birbcrew.replay",
                *map(str, self.root.glob("*-history.json")),
            ],
            cwd=REPO,
            text=True,
        )
        self.report["replay"] = json.loads(result)
        self.telemetry()
        if self.args.mode == "live":
            models = self.returned_models(final)
            urls = sorted(
                {
                    message.get("provider_url", "").rstrip("/")
                    for message in final["native_messages"]
                    if message.get("kind") == "response"
                }
            )
            assert models == [MODEL], ("Unexpected live model identity", models)
            assert urls == [ENDPOINT], ("Unexpected live provider endpoint", urls)
            self.gate(
                "real_subscription",
                {
                    "preflight": self.report["account"],
                    "provider_model": models,
                    "provider_url": urls,
                },
            )

    def second_turn(self, cid, previous):
        payload, accepted = self.submit(cid)
        pending = self.phase(cid, "waiting")
        assert pending["human"]["id"] != previous["decisions"][0]["id"]
        self.request(
            "POST",
            f"/conversations/{cid}/human",
            json={
                "request_id": pending["human"]["id"],
                "version": 1,
                "choice": "inspect",
            },
        )
        final = self.phase(cid, "idle")
        assert [i["ordinal"] for i in final["inputs"]] == [0, 1]
        assert all(i["outcome"] == "completed" for i in final["inputs"])
        assert final["messages"][: len(previous["messages"])] == previous["messages"]
        assert len(asyncio.run(store.operation_rows(cid))) == 2
        self.report["second_turn"] = {
            "inputs": final["inputs"],
            "decisions": final["decisions"],
            "effect_rows": 2,
            "prefix_preserved": True,
        }

    def client_has(self, name, kind):
        path = self.root / f"{name}.jsonl"
        return path.exists() and any(
            json.loads(line).get("type") == kind for line in path.read_text().splitlines()
        )

    def validate_events(self):
        events = []
        for name in ["client-a", "client-b"]:
            path = self.root / f"{name}.jsonl"
            events += [json.loads(line) for line in path.read_text().splitlines()]
        types = {e["type"] for e in events}
        assert {"TEXT_MESSAGE_CONTENT", "TOOL_CALL_START", "MESSAGES_SNAPSHOT"} <= types, types
        self.report["agui_event_types"] = sorted(types)

    def isolation(self, cid, payload, pending):
        headers = {"Authorization": "Bearer " + self.tokens["stranger"]}
        for method, suffix, body in [
            ("GET", "", None),
            ("POST", "/inputs", payload),
            ("POST", "/cancel", None),
            (
                "POST",
                "/human",
                {
                    "request_id": pending["human"]["id"],
                    "version": 1,
                    "choice": "test",
                },
            ),
            (
                "POST",
                "/events",
                {
                    "threadId": cid,
                    "runId": str(uuid4()),
                    "state": {},
                    "messages": [],
                    "tools": [],
                    "context": [],
                    "forwardedProps": {},
                },
            ),
        ]:
            self.request(
                method, f"/conversations/{cid}{suffix}", status=404, headers=headers, json=body
            )
        self.request(
            "GET", f"/conversations/{cid}", status=401, headers={"Authorization": "Bearer invalid"}
        )
        self.gate(
            "isolation",
            {"other_principal_read_submit_resume_stream_cancel": 404, "invalid_credential": 401},
        )

    def cancel_journey(self):
        cid = self.new_conversation()
        self.submit(cid)
        wait_for(lambda: asyncio.run(store.operation_rows(cid)), "cancel fixture effect")
        ack = self.request("POST", f"/conversations/{cid}/cancel", status=202)
        final = self.phase(cid, "cancelled", timeout=60)
        self.gate(
            "explicit_cancellation",
            {
                "ack": ack,
                "final_phase": final["phase"],
                "effect_already_committed": len(asyncio.run(store.operation_rows(cid))) == 1,
                "disconnect_did_not_cancel_first_conversation": self.report["final_snapshot"][
                    "phase"
                ]
                == "idle",
            },
        )

    def cancel_human_wait(self, cid):
        self.submit(cid)
        pending = self.phase(cid, "waiting")
        self.client_start("cancel-client", cid)
        wait_for(lambda: self.client_has("cancel-client", "STATE_SNAPSHOT"), "cancel observer")
        self.request("POST", f"/conversations/{cid}/cancel", status=202)
        final = self.phase(cid, "cancelled")
        wait_for(lambda: self.client_has("cancel-client", "RUN_FINISHED"), "terminal AG-UI event")
        observer = self.processes["cancel-client"]
        assert observer.wait(timeout=10) == 0
        self.request(
            "POST",
            f"/conversations/{cid}/human",
            status=409,
            json={
                "request_id": pending["human"]["id"],
                "version": 1,
                "choice": "test",
            },
        )
        self.report["cancel_human_wait"] = {
            "phase": final["phase"],
            "observer_exit": observer.returncode,
            "human_reply_after_cancel_http": 409,
        }

    def cursor_expiry(self, cid):
        async def expire():
            for i in range(store.RETAIN_EVENTS + 2):
                await store.publish(cid, f"expiry/{i}", {"type": "STATE_SNAPSHOT", "snapshot": {}})

        asyncio.run(expire())
        self.request("POST", f"/conversations/{cid}/cancel", status=202)
        self.phase(cid, "cancelled")
        body = {
            "threadId": cid,
            "runId": str(uuid4()),
            "state": {},
            "messages": [],
            "tools": [],
            "context": [],
            "forwardedProps": {},
        }
        self.request("POST", f"/conversations/{cid}/events?after=0", status=410, json=body)
        self.report["stale_cursor_http"] = 410
        try:
            asyncio.run(store.events_after(cid, 0))
        except ValueError as error:
            assert str(error) == "cursor_expired"
        else:
            raise AssertionError("Old event cursor should have been pruned")
        self.report["event_retention_pruned_old_cursor"] = True

    def returned_models(self, final):
        return sorted({m["model_name"] for m in final["native_messages"] if m.get("model_name")})

    def capture_history(self):
        async def capture():
            client = await Client.connect(settings().temporal_address, plugins=[PydanticAIPlugin()])
            for record in self.report["conversations"]:
                handle = client.get_workflow_handle(record["workflow_id"])
                description = await handle.describe()
                record["workflow_run_id"] = description.run_id
                record["status"] = description.status.name
                await asyncio.wait_for(handle.result(), timeout=10)
                history = await handle.fetch_history()
                raw_events = json.loads(history.to_json())["events"]
                scheduled = {
                    str(e["eventId"]): e["activityTaskScheduledEventAttributes"]["activityType"][
                        "name"
                    ]
                    for e in raw_events
                    if "activityTaskScheduledEventAttributes" in e
                }
                record["activity_retries"] = [
                    {
                        "activity": scheduled[a["scheduledEventId"]],
                        "attempt": a["attempt"],
                        "cause": a.get("lastFailure", {})
                        .get("timeoutFailureInfo", {})
                        .get("timeoutType"),
                    }
                    for e in raw_events
                    if (a := e.get("activityTaskStartedEventAttributes"))
                    and a.get("attempt", 1) > 1
                ]
                record["history_events"] = len(history.events)
                (self.root / f"{record['id']}-history.json").write_text(history.to_json())

        asyncio.run(capture())
        if self.args.mode == "test":
            retries = self.report["conversations"][0]["activity_retries"]
            assert any(
                "__call_tool" in r["activity"] and r["cause"] == "TIMEOUT_TYPE_HEARTBEAT"
                for r in retries
            )
            self.report["gates"]["worker_interruption"]["evidence"]["temporal_retries"] = retries

    def telemetry(self):
        spans = [
            json.loads(line)
            for path in self.root.glob("telemetry-*.jsonl")
            for line in path.read_text().splitlines()
        ]
        relevant = [s for s in spans if s["attributes"].get("birbcrew.conversation_id")]
        names = {s["name"] for s in relevant}
        assert {"tool.effect", "conversation.persist"} <= names, names
        if self.args.mode == "test":
            assert "tool.reconciled" in names
        telemetry_files = sorted(self.root.rglob("telemetry-*.jsonl"))
        text = "\n".join(path.read_text() for path in telemetry_files)
        assert not any(token in text for token in self.tokens.values())
        assert "Bearer " not in text
        from urllib.parse import urlparse

        assert urlparse(settings().database_url).password not in text
        if self.args.mode == "live":
            from birbcrew.provider import read_go_key

            assert read_go_key() not in text
        native_spans = [s for s in spans if s["attributes"].get("gen_ai.conversation.id")]
        conversation_ids = {record["id"] for record in self.report["conversations"]}
        assert native_spans and all(
            s["attributes"]["gen_ai.conversation.id"] in conversation_ids for s in native_spans
        )
        self.report["framework_telemetry"] = [
            {
                "name": s["name"],
                "trace_id": s["trace_id"],
                "conversation_id": s["attributes"]["gen_ai.conversation.id"],
                "run_id": s["attributes"].get("gen_ai.agent.call.id"),
            }
            for s in native_spans
        ]
        self.report["telemetry"] = relevant
        self.gate(
            "telemetry",
            {
                "exported_spans": len(spans),
                "secret_scan_files": [str(path.relative_to(self.root)) for path in telemetry_files],
                "correlated_spans": len(relevant),
                "names": sorted(names),
                "datadog": "NOT VERIFIED; outside scope",
            },
        )

    def save_report(self):
        (self.root / "report.json").write_text(
            json.dumps(self.report, indent=2, default=str) + "\n"
        )

    def close(self):
        for name in reversed(list(self.processes)):
            self.stop(name)
        subprocess.run(["docker", "rm", "-f", self.container], capture_output=True)
        self.client.close()
        self.save_report()
        print(f"EVIDENCE {self.root}", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["test", "live"], default="test")
    args = parser.parse_args()
    proof = Proof(args)
    try:
        if args.mode == "live":
            proof.report["account"] = preflight_account()
        proof.boot()
        proof.journey()
    except BaseException as error:
        proof.report["failure"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        proof.close()


if __name__ == "__main__":
    main()
