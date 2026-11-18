import asyncio
import json
import os
import re
import traceback
from pathlib import Path

import pytest
import test_execution
from pydantic import ValidationError

from birbcrew import provider
from birbcrew.execution import author
from birbcrew.execution import daemon as codex_daemon
from birbcrew.execution.policy import ClaudeReviewer, ExecutionSettings, OpenCodeGoReviewer

setup = test_execution.setup
daemon = test_execution.daemon
ROOT = Path(__file__).parents[2]


def installed(config, **changes):
    raw = config.model_dump(mode="json", exclude={"reviewer", "claude"})
    return ExecutionSettings.model_validate_json(json.dumps(raw | changes))


def test_existing_configuration_keeps_claude_reviewer(setup):
    config, _, _ = setup
    loaded = installed(config, claude="/opt/claude")
    assert loaded.reviewer == ClaudeReviewer(kind="claude")
    assert loaded.claude == Path("/opt/claude")
    assert loaded.codex_socket is None


def test_claude_reviewer_requires_claude_path(setup):
    config, _, _ = setup
    with pytest.raises(ValidationError, match="claude_reviewer_requires_claude_path"):
        installed(config)
    with pytest.raises(ValidationError, match="claude_reviewer_requires_claude_path"):
        installed(config, reviewer={"kind": "claude"})


def test_opencode_reviewer_needs_no_claude_and_rejects_one(setup):
    config, _, _ = setup
    reviewer = {"kind": "opencode-go"}
    loaded = installed(config, reviewer=reviewer)
    assert loaded.reviewer == OpenCodeGoReviewer(kind="opencode-go")
    assert loaded.claude is None and loaded.reviewer.api_key_file is None
    with pytest.raises(ValidationError, match="claude_path_requires_claude_reviewer"):
        installed(config, reviewer=reviewer, claude="/opt/claude")


@pytest.mark.parametrize(
    "reviewer",
    [
        {"kind": "opencode"},
        {"kind": "claude", "api_key_file": "/private/go.key"},
        {"kind": "opencode-go", "fallback": "claude"},
        # The removed attestation path is refused, not ignored, so no installation can
        # believe it still gates reviews.
        {"kind": "opencode-go", "subscription_evidence": "/private/go-evidence.json"},
        "opencode-go",
    ],
)
def test_reviewer_selection_rejects_illegal_shapes(setup, reviewer):
    config, _, _ = setup
    with pytest.raises(ValidationError):
        installed(config, reviewer=reviewer, claude="/opt/claude")
    with pytest.raises(ValidationError):
        installed(config, reviewer=reviewer)


@pytest.mark.parametrize(
    "changes",
    [
        {"reviewer": {"kind": "opencode-go", "api_key_file": "go.key"}},
        {"claude": "claude"},
        {"claude": "/opt/claude", "codex_socket": "codex.sock"},
    ],
)
def test_configured_paths_must_be_absolute(setup, changes):
    config, _, _ = setup
    with pytest.raises(ValidationError, match="installation_requires_absolute_paths"):
        installed(config, **changes)


def write_key(path, text, mode=0o600):
    path.write_text(text)
    path.chmod(mode)
    return path


@pytest.mark.parametrize("text", ["token-1\n", "token-1", "sk-abc_DEF.123=\n"])
def test_key_file_accepts_one_private_token(tmp_path, text):
    path = write_key(tmp_path / "key", text)
    assert provider.read_key_file(path) == text.strip()


@pytest.mark.parametrize("mode", [0o640, 0o604, 0o620, 0o602, 0o610, 0o601, 0o644])
def test_key_file_rejects_group_or_other_bits(tmp_path, mode):
    path = write_key(tmp_path / "key", "token-1\n", mode)
    with pytest.raises(ValueError, match="private to this user"):
        provider.read_key_file(path)


@pytest.mark.parametrize("text", ["a" * 4096, "a" * 4096 + "\n"])
def test_key_file_accepts_the_longest_token(tmp_path, text):
    path = write_key(tmp_path / "key", text)
    assert provider.read_key_file(path) == "a" * 4096


@pytest.mark.parametrize(
    "text",
    [
        "",
        "\n",
        "two tokens\n",
        "token\nsecond\n",
        "token\n\n",
        " t",
        "a" * 4096 + "\nx",
        "a" * 4096 + "\n\n",
        "a" * 4096 + "\nsecond token\n",
    ],
)
def test_key_file_requires_exactly_one_token(tmp_path, text):
    path = write_key(tmp_path / "key", text)
    with pytest.raises(ValueError, match="one token"):
        provider.read_key_file(path)


def test_key_file_rejects_oversize_symlink_directory_fifo_and_other_owner(tmp_path, monkeypatch):
    big = write_key(tmp_path / "big", "a" * 4097)
    with pytest.raises(ValueError, match="one token"):
        provider.read_key_file(big)
    target = write_key(tmp_path / "target", "token-1\n")
    (tmp_path / "link").symlink_to(target)
    with pytest.raises(OSError):
        provider.read_key_file(tmp_path / "link")
    (tmp_path / "directory").mkdir(mode=0o700)
    with pytest.raises(ValueError, match="private to this user"):
        provider.read_key_file(tmp_path / "directory")
    os.mkfifo(tmp_path / "fifo", 0o600)
    with pytest.raises(ValueError, match="private to this user"):
        provider.read_key_file(tmp_path / "fifo")
    other = os.geteuid() + 1
    monkeypatch.setattr(provider.os, "geteuid", lambda: other)
    with pytest.raises(ValueError, match="private to this user"):
        provider.read_key_file(target)


def test_profile_key_reader_still_supports_existing_installations(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    (tmp_path / ".profile").write_text("export PATH=/bin\nexport OPENCODE_GO_API_KEY='fixture-1'\n")
    assert provider.read_go_key() == "fixture-1"


@pytest.mark.parametrize(
    "socket,expected",
    [
        (None, ["/opt/codex", "app-server", "proxy"]),
        (
            Path("/var/run/codex/app-server-control.sock"),
            [
                "/opt/codex",
                "app-server",
                "proxy",
                "--sock",
                "/var/run/codex/app-server-control.sock",
            ],
        ),
    ],
)
def test_codex_socket_reaches_proxy_argv(monkeypatch, socket, expected):
    started = []

    async def exec_(*argv, **kwargs):
        started.append(list(argv))
        raise ConnectionError("fixture stops before the handshake")

    monkeypatch.setattr(codex_daemon.asyncio, "create_subprocess_exec", exec_)

    async def connect():
        async with codex_daemon.Daemon(Path("/opt/codex"), socket):
            pass

    with pytest.raises(ConnectionError):
        asyncio.run(connect())
    assert started == [expected]


def test_author_uses_configured_codex_socket(setup, daemon, monkeypatch):
    config, request, _ = setup
    socket = Path("/shared/codex/app-server-control.sock")
    config = installed(config, claude="/opt/claude", codex_socket=str(socket))
    monkeypatch.setattr(author, "installation", lambda: config)
    clients = []

    class Recording(daemon):
        def __init__(self, *args):
            clients.append(args)

    monkeypatch.setattr(author, "Daemon", Recording)
    result = asyncio.run(author.author_goal(request.model_dump(mode="json")))
    assert result["status"] == "candidate"
    assert clients and all(args == (config.codex, socket) for args in clients)


def test_executor_image_pins_the_locked_codex_packages():
    lock = json.loads((ROOT / "package-lock.json").read_text())["packages"]
    dockerfile = (ROOT / "packaging/executor.Dockerfile").read_text()
    version = lock["node_modules/@openai/codex"]["version"]
    for platform in ("linux-x64", "linux-arm64"):
        locked = lock[f"node_modules/@openai/codex-{platform}"]
        assert locked["version"] == f"{version}-{platform}"
        assert locked["resolved"].endswith(f"/codex-{version}-{platform}.tgz")
        assert re.search(
            rf"set -- {platform} \S+ {re.escape(locked['integrity'].removeprefix('sha512-'))} ;;",
            dockerfile,
        )
    assert f"/codex-{version}-$platform.tgz" in dockerfile
    for argument in ("PYTHON_IMAGE", "UV_IMAGE"):
        assert f'case "${argument}" in *@sha256:*) ;;' in dockerfile


def test_interrupt_uses_configured_codex_socket(setup, daemon, monkeypatch):
    config, _, _ = setup
    socket = Path("/shared/codex/app-server-control.sock")
    config = installed(config, claude="/opt/claude", codex_socket=str(socket))
    clients = []

    class Recording(daemon):
        def __init__(self, *args):
            clients.append(args)

    monkeypatch.setattr(author, "Daemon", Recording)
    daemon.turns = [{"id": "owned-turn", "status": "interrupted"}]
    state = {"thread_id": "owned-thread", "turn_id": "owned-turn"}
    assert asyncio.run(author.interrupt(config, state))["status"] == "uncertain"
    assert clients == [(config.codex, socket)]


def opencode_settings(config, tmp_path, key_mode=0o600):
    key = write_key(tmp_path / "go.key", "token-1\n", key_mode)
    return installed(config, reviewer={"kind": "opencode-go", "api_key_file": str(key)})


def test_worker_preflight_rejects_unusable_reviewer_configuration(setup, tmp_path, monkeypatch):
    from birbcrew.execution.review import preflight_reviewer

    config, _, _ = setup
    preflight_reviewer(installed(config, claude="/opt/claude"))
    preflight_reviewer(opencode_settings(config, tmp_path))
    with pytest.raises(
        ValueError,
        match="^opencode_go_key_unusable: OpenCode Go key file must be private to this user$",
    ):
        preflight_reviewer(opencode_settings(config, tmp_path, 0o644))
    broken = opencode_settings(config, tmp_path)
    broken.reviewer.api_key_file.write_bytes(b"\xff" * 8)
    with pytest.raises(ValueError, match="^opencode_go_key_unusable: OpenCode Go key file must"):
        preflight_reviewer(broken)
    broken.reviewer.api_key_file.unlink()
    with pytest.raises(ValueError, match="^opencode_go_key_unusable: FileNotFoundError$"):
        preflight_reviewer(broken)
    # Without a key file the reviewer reads ~/.profile. A missing key there stops the worker too.
    monkeypatch.setenv("HOME", str(tmp_path))
    profile = installed(config, reviewer={"kind": "opencode-go"})
    with pytest.raises(ValueError, match="^opencode_go_key_unusable: FileNotFoundError$"):
        preflight_reviewer(profile)
    (tmp_path / ".profile").write_text("export OTHER=1\n")
    with pytest.raises(ValueError, match="^opencode_go_key_unusable: No literal OPENCODE_GO"):
        preflight_reviewer(profile)
    (tmp_path / ".profile").write_text("export OPENCODE_GO_API_KEY=token-1\n")
    preflight_reviewer(profile)


@pytest.mark.parametrize("state", ["absent", "expired", "extra_usage_on", "not_json"])
def test_worker_preflight_reads_the_key_and_no_former_attestation_file(
    setup, tmp_path, opened_files, state
):
    from birbcrew.execution.review import preflight_reviewer

    config, _, _ = setup
    former = tmp_path / "go-evidence.json"
    statement = {
        "provider": "opencode-go",
        "account_path": "fixture account",
        "extra_usage_disabled": state != "extra_usage_on",
        "eligible_coding_use": True,
        "checked_at": "2020-01-01T00:00:00Z",
        "evidence": "left over from before the gate was removed",
    }
    if state == "not_json":
        former.write_text("renew me")
    elif state != "absent":
        former.write_text(json.dumps(statement))
    settings = opencode_settings(config, tmp_path)
    del opened_files[:]
    preflight_reviewer(settings)
    root = str(tmp_path.resolve()) + "/"
    read = {path for path in opened_files if path.startswith(root)}
    assert read == {str(settings.reviewer.api_key_file.resolve())}


def test_invalid_installation_file_names_fields_without_values(setup, tmp_path, monkeypatch):
    from birbcrew.execution import policy

    config, _, _ = setup
    raw = config.model_dump(mode="json", exclude={"reviewer", "claude"})
    secret = "fixture-token-" + "B" * 20
    raw["reviewer"] = {
        "kind": "opencode-go",
        "subscription_evidence": "/private/go-evidence.json",
        "api_key": secret,
    }
    path = tmp_path / "execution.json"
    path.write_text(json.dumps(raw))
    monkeypatch.setenv("BIRBCREW_EXECUTION_CONFIG", str(path))
    policy.installation.cache_clear()
    try:
        with pytest.raises(ValueError) as caught:
            policy.installation()
    finally:
        policy.installation.cache_clear()
    printed = "".join(traceback.format_exception(caught.value))
    assert "reviewer.opencode-go.api_key: Extra inputs" in printed
    assert "reviewer.opencode-go.subscription_evidence: Extra inputs" in printed
    assert secret[:14] not in printed and "go-evidence" not in printed


def test_worker_preflight_never_echoes_file_contents(setup, tmp_path):
    from birbcrew.execution.review import preflight_reviewer

    config, _, _ = setup
    swapped = opencode_settings(config, tmp_path)
    secret = "fixture-token-" + "A" * 40
    write_key(swapped.reviewer.api_key_file, secret + "\n" + secret + "\n")
    with pytest.raises(ValueError) as caught:
        preflight_reviewer(swapped)
    printed = "".join(traceback.format_exception(caught.value))
    assert "opencode_go_key_unusable" in printed and secret[:14] not in printed


def test_configured_codex_socket_must_accept_connections():
    import socket
    import tempfile

    from birbcrew.execution.daemon import wait_for_socket

    with tempfile.TemporaryDirectory(dir="/tmp") as directory:
        path = Path(directory) / "codex.sock"
        with pytest.raises(ValueError, match="codex_socket_unavailable"):
            asyncio.run(wait_for_socket(path, 0.2))
        path.write_text("")
        with pytest.raises(ValueError, match="codex_socket_unavailable"):
            asyncio.run(wait_for_socket(path, 0.2))
        path.unlink()
        with socket.socket(socket.AF_UNIX) as stale:
            stale.bind(str(path))
            with pytest.raises(ValueError, match="codex_socket_unavailable"):
                asyncio.run(wait_for_socket(path, 1.5))
        path.unlink()

        async def listens_later():
            listener = socket.socket(socket.AF_UNIX)

            def serve():
                listener.bind(str(path))
                listener.listen()

            asyncio.get_running_loop().call_later(0.3, serve)
            try:
                await wait_for_socket(path, 5)
            finally:
                listener.close()

        asyncio.run(listens_later())


def test_worker_drains_activities_on_sigterm(setup, monkeypatch, tmp_path):
    import signal

    from birbcrew.execution import worker

    config, _, _ = setup
    started = []
    unhandled = []

    class FakeWorker:
        def __init__(self, client, **options):
            started.append(options)

        async def __aenter__(self):
            asyncio.get_running_loop().call_soon(os.kill, os.getpid(), signal.SIGTERM)
            return self

        async def __aexit__(self, *exc):
            started.append("drained")

    async def client():
        return object()

    monkeypatch.setattr(worker, "installation", lambda: config)
    monkeypatch.setattr(worker, "temporal_client", client)
    monkeypatch.setattr(worker, "Worker", FakeWorker)
    previous = signal.signal(signal.SIGTERM, lambda *args: unhandled.append(args))
    try:
        asyncio.run(asyncio.wait_for(worker.main(), 5))
    finally:
        signal.signal(signal.SIGTERM, previous)
    assert not unhandled
    assert started[0]["graceful_shutdown_timeout"].total_seconds() == 660
    assert started[1] == "drained"
    unusable = opencode_settings(config, tmp_path, 0o640)
    monkeypatch.setattr(worker, "installation", lambda: unusable)
    with pytest.raises(ValueError, match="opencode_go_key_unusable"):
        asyncio.run(worker.main())
    missing = installed(config, claude="/opt/claude", codex_socket=str(tmp_path / "absent.sock"))
    monkeypatch.setattr(worker, "installation", lambda: missing)

    async def no_socket(path, timeout):
        assert (path, timeout) == (missing.codex_socket, 120)
        raise ValueError("codex_socket_unavailable")

    monkeypatch.setattr(worker, "wait_for_socket", no_socket)
    with pytest.raises(ValueError, match="codex_socket_unavailable"):
        asyncio.run(worker.main())
    assert len(started) == 2
