import os
import re
import stat
from pathlib import Path

import httpx
from openai import AsyncOpenAI
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

ENDPOINT = "https://opencode.ai/inference/go/openai/v1"
MODEL = "glm-5.3-flash"


def read_go_key() -> str:
    text = (Path.home() / ".profile").read_text()
    match = re.search(
        r"^\s*(?:export\s+)?OPENCODE_GO_API_KEY=([\'\"]?)([^\s\'\"$`]+)\1\s*$",
        text,
        flags=re.MULTILINE,
    )
    if not match:
        raise ValueError("No literal OPENCODE_GO_API_KEY assignment in ~/.profile")
    return match[2]


def read_key_file(path: Path) -> str:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or info.st_mode & (stat.S_IRWXG | stat.S_IRWXO)
        ):
            raise ValueError("OpenCode Go key file must be private to this user")
        # The longest valid file is 4097 bytes (token and newline); reading one more
        # byte makes any longer file fail the match below instead of being truncated.
        data = b""
        while len(data) <= 4097 and (chunk := os.read(descriptor, 4098 - len(data))):
            data += chunk
    finally:
        os.close(descriptor)
    match = re.fullmatch(rb"([\x21-\x7e]{1,4096})\n?", data)
    if not match:
        raise ValueError("OpenCode Go key file must contain one token")
    return match[1].decode()


def go_client(api_key: str) -> AsyncOpenAI:
    return AsyncOpenAI(base_url=ENDPOINT, api_key=api_key, max_retries=0)


def chat_model(client: AsyncOpenAI) -> OpenAIChatModel:
    return OpenAIChatModel(MODEL, provider=OpenAIProvider(openai_client=client))


def model() -> OpenAIChatModel:
    return chat_model(go_client(read_go_key()))


def model_settings(cid: str) -> dict:
    return {
        "extra_headers": {"User-Agent": "birbcrew-coding-proof/0.1.0", "x-opencode-session": cid},
        "max_tokens": 1200,
    }


def review_model_settings(session: str) -> dict:
    return {
        "extra_headers": {"User-Agent": "birbcrew-review/0.1.0", "x-opencode-session": session},
        "max_tokens": 8192,
        "timeout": 600,
    }


def project_model_settings(cid: str) -> dict:
    return {
        "extra_headers": {"User-Agent": "birbcrew-project-chat/0.1.0", "x-opencode-session": cid},
        "max_tokens": 4096,
    }


def preflight_account() -> dict:
    """Check the configured Go credential against the provider's model list. No model call."""
    key = read_go_key()
    response = httpx.get(
        ENDPOINT + "/models",
        headers={
            "Authorization": "Bearer " + key,
            "User-Agent": "birbcrew-coding-proof/0.1.0",
            "x-opencode-session": "birbcrew-preflight",
        },
        timeout=20,
        follow_redirects=False,
    )
    if response.status_code != 200:
        raise ValueError(
            f"Live calls blocked. Go credential preflight returned HTTP {response.status_code}."
        )
    if MODEL not in {item.get("id") for item in response.json().get("data", [])}:
        raise ValueError("Live calls blocked. Selected model is not listed for this credential.")
    return {
        "provider": "opencode-go",
        "endpoint": ENDPOINT,
        "model": MODEL,
        "credential_present": True,
        "credential_source": "~/.profile",
        "usage_visibility": "Not checked. No billing API or console setting is read.",
        "models_http_status": 200,
        "selected_model_listed": True,
    }
