import json
from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from birbcrew.beans import FixtureHub
from birbcrew.domain import Prompt

KEY = "fixture-token-not-a-credential"


def test_request_identity_excludes_transport_order():
    rid = "2dc18963-f3f1-48d2-b89b-5424765f78a1"
    first = Prompt(request_id=rid, text="inspect the coding fixture")
    second = Prompt.model_validate_json(json.dumps({"text": first.text, "request_id": rid}))
    assert first.digest == second.digest
    assert first.digest != Prompt(request_id=rid, text="different").digest
    with pytest.raises(ValidationError):
        Prompt(request_id=rid, text="x" * 4001)


def former_attestation(path, *, age=timedelta(hours=13), extra_usage_disabled=True):
    """The dated owner statement the removed gate read, always past its 12-hour limit.

    Tests write it only to show that nothing reads it. None writes a statement the gate accepted.
    """
    path.write_text(
        json.dumps(
            {
                "provider": "opencode-go",
                "account_path": "owner subscription",
                "extra_usage_disabled": extra_usage_disabled,
                "eligible_coding_use": True,
                "checked_at": (datetime.now(UTC) - age).isoformat(),
                "evidence": "owner console check",
            }
        )
    )


def under(directory, opened):
    root = str(directory.resolve())
    return {path for path in opened if path.startswith(root + "/")}


@pytest.mark.parametrize("state", ["absent", "past_limit", "month_old", "extra_usage", "garbage"])
def test_live_model_reads_the_credential_and_no_attestation_in_any_state(
    tmp_path, monkeypatch, opened_files, state
):
    from birbcrew import provider

    monkeypatch.setenv("HOME", str(tmp_path))
    statement = tmp_path / "account.json"
    if state == "past_limit":
        former_attestation(statement, age=timedelta(hours=12, minutes=1))
    elif state == "month_old":
        former_attestation(statement, age=timedelta(days=30))
    elif state == "extra_usage":
        former_attestation(statement, extra_usage_disabled=False)
    elif state == "garbage":
        statement.write_text("renew me")
    profile = tmp_path / ".profile"
    with pytest.raises(FileNotFoundError):
        provider.model()
    profile.write_text("export OTHER_KEY=value\n")
    with pytest.raises(ValueError, match="No literal OPENCODE_GO_API_KEY assignment"):
        provider.model()
    profile.write_text(f"export OPENCODE_GO_API_KEY={KEY}\n")
    del opened_files[:]
    client = provider.model()._provider.client
    assert client.api_key == KEY
    assert str(client.base_url).rstrip("/") == provider.ENDPOINT
    assert client.max_retries == 0
    # The credential file was read, and nothing else beside it: not the statement, in any state.
    assert under(tmp_path, opened_files) == {str(profile.resolve())}
    # No reader of that statement remains to be called by mistake.
    assert not hasattr(provider, "check_evidence")
    assert not hasattr(provider, "SubscriptionEvidence")
    assert not hasattr(provider, "evidence_summary")


def settings_document(**changes):
    return {
        "database_url": "unused",
        "temporal_address": "unused",
        "task_queue": "fixture",
        "token_hashes": {},
        "context": {"project": "proof", "actor": "owner", "commit": "fixture", "notes": []},
        "evidence_dir": "/tmp/unused",
    } | changes


def test_settings_require_an_explicit_mode_and_refuse_the_removed_attestation_path():
    from birbcrew.config import Settings

    modes = ("test", "live", "approved-goal", "project-test", "project-live")
    for mode in modes:
        assert Settings.model_validate(settings_document(mode=mode)).mode == mode
    # A configuration that does not choose never means the test model.
    with pytest.raises(ValidationError, match="mode\n  Field required"):
        Settings.model_validate(settings_document())
    for unknown in ("", "mock", "local", "LIVE", "production", None, True):
        with pytest.raises(ValidationError, match="mode"):
            Settings.model_validate(settings_document(mode=unknown))
    # An installation that still names an attestation is told so. It does not start
    # without the gate it expects.
    for mode in ("live", "project-live"):
        with pytest.raises(ValidationError, match="live_attestation\n  Extra inputs are not"):
            Settings.model_validate(
                settings_document(mode=mode, live_attestation="/private/attestation.json")
            )


@pytest.fixture
def conversation_runtime(tmp_path, monkeypatch):
    """birbcrew.runtime builds its agent at import, so import it under a test-mode configuration."""
    from birbcrew.config import settings

    config = tmp_path / "crew.json"
    config.write_text(json.dumps(settings_document(mode="test", evidence_dir=str(tmp_path))))
    monkeypatch.setenv("BIRBCREW_CONFIG", str(config))
    settings.cache_clear()
    from birbcrew import runtime

    yield runtime
    settings.cache_clear()


def configured(monkeypatch, module, mode):
    from birbcrew.config import Settings

    value = Settings.model_validate(settings_document(mode=mode))
    monkeypatch.setattr(module, "settings", lambda: value)


def missing_key():
    raise ValueError("No literal OPENCODE_GO_API_KEY assignment in ~/.profile")


def test_conversation_worker_selects_its_model_from_the_mode_alone(
    conversation_runtime, monkeypatch
):
    from pydantic_ai.models.openai import OpenAIChatModel

    from birbcrew import provider, test_model

    runtime = conversation_runtime
    configured(monkeypatch, runtime, "live")
    monkeypatch.setattr(provider, "read_go_key", missing_key)
    monkeypatch.setattr(test_model, "model", lambda: pytest.fail("live mode used the test model"))
    with pytest.raises(ValueError, match="OPENCODE_GO_API_KEY"):
        runtime.make_agent()
    monkeypatch.setattr(provider, "read_go_key", lambda: KEY)
    live = runtime.make_agent().model
    assert isinstance(live, OpenAIChatModel) and live.model_name == provider.MODEL
    assert live._provider.client.api_key == KEY
    for mode in ("approved-goal", "project-test", "project-live"):
        configured(monkeypatch, runtime, mode)
        with pytest.raises(ValueError, match="Unsupported provider mode"):
            runtime.make_agent()
    monkeypatch.undo()
    configured(monkeypatch, runtime, "test")
    monkeypatch.setattr(provider, "read_go_key", lambda: pytest.fail("test mode read a credential"))
    assert not isinstance(runtime.make_agent().model, OpenAIChatModel)


def test_beans_capture_is_scoped_clean_and_stable(tmp_path):
    hub = FixtureHub(tmp_path)
    hub.seed()
    first = hub.capture()
    second = hub.capture()
    assert first == second
    assert {n.key for n in first.notes} == {"milestone", "verification"}
    assert "UNRELATED_FIXTURE" not in first.model_dump_json()
    note = hub.hub / first.notes[0].path
    note.write_text(note.read_text() + "\nchanged")
    with pytest.raises(ValueError, match="clean"):
        hub.capture()


def test_beans_rejects_remote_before_any_mutation(tmp_path):
    hub = FixtureHub(tmp_path)
    hub.seed()
    commit = hub.git("rev-parse", "HEAD")
    hub.git("remote", "add", "origin", "https://example.invalid/private-hub")
    with pytest.raises(ValueError, match="no remotes"):
        hub.bn("birbcrew", "remember", "--key", "unsafe", "must not be written")
    assert hub.git("rev-parse", "HEAD") == commit


def test_beans_rejects_hub_symlink(tmp_path):
    other = tmp_path / "elsewhere"
    other.mkdir()
    root = tmp_path / "fixture"
    root.mkdir()
    (root / "hub").symlink_to(other, target_is_directory=True)
    with pytest.raises(ValueError, match="escaped"):
        FixtureHub(root).assert_safe()


def test_beans_ignores_inherited_git_repository(tmp_path, monkeypatch):
    foreign = tmp_path / "foreign"
    foreign.mkdir()
    monkeypatch.setenv("GIT_DIR", str(foreign))
    monkeypatch.setenv("GIT_WORK_TREE", str(foreign))
    hub = FixtureHub(tmp_path / "fixture")
    hub.seed()
    assert hub.capture().project == "birbcrew"
    assert list(foreign.iterdir()) == []


def test_live_preflight_checks_the_real_credential_and_stops_at_failed_auth(monkeypatch):
    import httpx

    from birbcrew import provider

    calls = []
    answers = []

    def respond(url, **kwargs):
        calls.append((url, kwargs["headers"]["Authorization"]))
        return answers.pop(0)

    monkeypatch.setattr(provider.httpx, "get", respond)
    monkeypatch.setattr(provider, "read_go_key", missing_key)
    with pytest.raises(ValueError, match="OPENCODE_GO_API_KEY"):
        provider.preflight_account()
    assert calls == []
    monkeypatch.setattr(provider, "read_go_key", lambda: "disposable-key")
    answers.append(httpx.Response(401, json={"error": {"code": "api_key_expired"}}))
    with pytest.raises(ValueError, match="HTTP 401"):
        provider.preflight_account()
    answers.append(httpx.Response(200, json={"data": [{"id": "another-model"}]}))
    with pytest.raises(ValueError, match="not listed for this credential"):
        provider.preflight_account()
    answers.append(httpx.Response(200, json={"data": [{"id": provider.MODEL}]}))
    summary = provider.preflight_account()
    assert summary["models_http_status"] == 200 and summary["selected_model_listed"] is True
    assert summary["model"] == provider.MODEL and summary["endpoint"] == provider.ENDPOINT
    # The summary claims nothing about billing: no code reads a console setting.
    removed = {"extra_usage_disabled", "eligible_coding_use", "checked_at", "evidence"}
    assert not removed & set(summary)
    assert "disposable-key" not in json.dumps(summary)
    assert calls == [(provider.ENDPOINT + "/models", "Bearer disposable-key")] * 3
