import json
import os
from functools import cache
from pathlib import Path, PurePosixPath
from typing import Annotated, Literal

from pydantic import Field, ValidationError, model_validator

from birbcrew.execution.contract import Digest, ExecutionInput, Identity, Record, digest


class Repository(Record):
    repository_id: Identity
    checkout: Path
    remote: str = Field(pattern=r"^git@github.com:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git$")
    base_branch: str = Field(pattern=r"^[A-Za-z0-9_./-]+$")
    allowed_paths: tuple[str, ...]
    acceptance_id: Identity
    acceptance_command: tuple[str, ...] = Field(min_length=1)

    @model_validator(mode="after")
    def docs_only(self):
        for value in self.allowed_paths:
            path = PurePosixPath(value)
            if (
                path.is_absolute()
                or ".." in path.parts
                or not value.startswith("docs/")
                or not value.endswith(".md")
            ):
                raise ValueError("pilot_requires_exact_documentation_paths")
        if not self.checkout.is_absolute() or not Path(self.acceptance_command[0]).is_absolute():
            raise ValueError("installation_requires_absolute_paths")
        return self

    @property
    def revision(self) -> str:
        return digest(
            {
                "repository_id": self.repository_id,
                "remote": self.remote,
                "base_branch": self.base_branch,
                "allowed_paths": self.allowed_paths,
                "acceptance_id": self.acceptance_id,
                "acceptance_command": self.acceptance_command,
            }
        )


class ClaudeReviewer(Record):
    kind: Literal["claude"]


class OpenCodeGoReviewer(Record):
    kind: Literal["opencode-go"]
    api_key_file: Path | None = None


Reviewer = Annotated[ClaudeReviewer | OpenCodeGoReviewer, Field(discriminator="kind")]


class ExecutionSettings(Record):
    repository: Repository
    worktree_root: Path
    artifact_root: Path
    codex: Path
    codex_socket: Path | None = None
    reviewer: Reviewer = ClaudeReviewer(kind="claude")
    claude: Path | None = None
    git: Path
    gh: Path
    task_queue: str
    binding_revision: Digest
    turn_timeout_seconds: int = Field(default=1800, ge=60, le=3600)

    @model_validator(mode="after")
    def absolute_paths(self):
        optional = (self.codex_socket, self.claude)
        if isinstance(self.reviewer, OpenCodeGoReviewer):
            optional += (self.reviewer.api_key_file,)
        for path in (
            self.worktree_root,
            self.artifact_root,
            self.codex,
            self.git,
            self.gh,
            *(path for path in optional if path is not None),
        ):
            if not path.is_absolute():
                raise ValueError("installation_requires_absolute_paths")
        if self.reviewer.kind == "claude" and self.claude is None:
            raise ValueError("claude_reviewer_requires_claude_path")
        if self.reviewer.kind != "claude" and self.claude is not None:
            raise ValueError("claude_path_requires_claude_reviewer")
        if self.binding_revision != self.repository.revision:
            raise ValueError("binding_revision_mismatch")
        return self

    def authorize(self, request: ExecutionInput):
        offer = request.approved_goal.offer
        repo = self.repository
        if (
            offer.repository_id,
            offer.policy_revision,
            offer.allowed_paths,
            offer.acceptance_id,
        ) != (repo.repository_id, repo.revision, repo.allowed_paths, repo.acceptance_id):
            raise ValueError("offer_not_installed")

    def worktree(self, request: ExecutionInput) -> Path:
        return self.worktree_root / str(request.approved_goal.delivery_id)

    def author_worktree(self, request: ExecutionInput) -> Path:
        return self.worktree_root / f"{request.approved_goal.delivery_id}-author"

    def evidence(self, operation_id: str, kind: str, content: str) -> tuple[str, str]:
        from hashlib import sha256

        self.artifact_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = self.artifact_root / f"{operation_id}-{kind}.txt"
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
            stream.write(content)
        return sha256(content.encode()).hexdigest(), f"execution/{operation_id}/{kind}"


@cache
def installation() -> ExecutionSettings:
    try:
        return ExecutionSettings.model_validate(
            json.loads(Path(os.environ["BIRBCREW_EXECUTION_CONFIG"]).read_text())
        )
    except ValidationError as error:
        problems = "; ".join(
            f"{'.'.join(map(str, item['loc'])) or 'settings'}: {item['msg']}"
            for item in error.errors(include_input=False, include_url=False)
        )
        raise ValueError(f"execution_config_invalid: {problems}") from None
