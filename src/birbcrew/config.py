import json
import os
from functools import cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict

from birbcrew.domain import NoteContext


class TemporalTLS(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ca_path: Path
    certificate_path: Path
    private_key_path: Path
    server_name: str


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    database_url: str
    temporal_address: str
    task_queue: str
    token_hashes: dict[str, str]
    context: NoteContext
    evidence_dir: Path
    # Required. A configuration that does not choose a model path never gets the test model.
    mode: Literal["test", "live", "approved-goal", "project-test", "project-live"]
    namespace: str = "default"
    temporal_tls: TemporalTLS | None = None
    interrupt_after_effect: bool = False
    project_service_token_sha256: str | None = None
    project_task_queue: str | None = None


@cache
def settings() -> Settings:
    return Settings.model_validate_json(Path(os.environ["BIRBCREW_CONFIG"]).read_text())


def write_private(path: Path, data: dict) -> None:
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        json.dump(data, f, indent=2)


async def temporal_client(*, plugins=None):
    from temporalio.client import Client
    from temporalio.service import TLSConfig

    config = settings()
    tls = config.temporal_tls
    return await Client.connect(
        config.temporal_address,
        namespace=config.namespace,
        plugins=plugins or [],
        tls=TLSConfig(
            server_root_ca_cert=tls.ca_path.read_bytes(),
            client_cert=tls.certificate_path.read_bytes(),
            client_private_key=tls.private_key_path.read_bytes(),
            domain=tls.server_name,
        )
        if tls
        else False,
    )
