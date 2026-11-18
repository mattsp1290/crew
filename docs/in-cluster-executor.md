# In-cluster executor

The approved-goal activity worker (`python -m birbcrew.execution.worker`) can run in a container without Claude. Codex still authors through the ChatGPT subscription and its app-server. OpenCode Go reviews through `birbcrew.provider`. The [pilot contract](persistent-pilot.md) still applies. This page covers only what changes in a container.

## Select the reviewer

`ExecutionSettings.reviewer` selects one review engine. There is no fallback between engines.

```json
{
  "reviewer": {
    "kind": "opencode-go",
    "api_key_file": "/run/crew/opencode-go.key"
  },
  "codex": "/usr/local/bin/codex",
  "codex_socket": "/tmp/codex-daemon-10001/<socket name>",
  "git": "/usr/bin/git",
  "gh": "/usr/bin/gh"
}
```

These fields go into the existing installation file. Its other fields are unchanged. Replace `<socket name>` with the name the Codex container reports; see [Run Codex beside the worker](#run-codex-beside-the-worker).

- If `reviewer` is absent, the Claude reviewer is selected. Configurations written before this field existed keep their behavior.
- `{"kind": "claude"}` requires `claude`, and any other reviewer rejects it. A configuration that breaks either rule fails to load.
- All configured paths must be absolute.
- The reviewer needs only its key. Earlier releases also required `subscription_evidence`, a dated owner statement that expired after 12 hours. That field was removed. A configuration that still names it fails to load with `execution_config_invalid` and the field's name, so remove the field and the file.
  - No code asserts the statement's claims any more: that Extra Usage is off and that the subscription permits this use. Nothing ever checked them against the provider. Keep overage billing off in the provider's console.
  - Each review still sends one request with no retry and at most 8192 output tokens.
- `api_key_file` must be a regular file, not a symbolic link. The worker's UID must own it, with no group or other permission bits. It must contain one token, optionally followed by a newline.
  - Without `api_key_file`, the key comes from the `OPENCODE_GO_API_KEY` assignment in `$HOME/.profile`, as before.
  - Crew never writes the key to evidence or receipts. A test that enables debug logging for a review checks that the key does not appear in the log output.

At startup, the worker checks the installation before it connects to Temporal. Its error messages never contain file contents. Configuration errors list field paths and validation messages. Those can name an unrecognized field or `kind` value, but never another input value.

- **Installation file.** If it is invalid, the worker exits with `execution_config_invalid` followed by the field names and error messages.
- **Key.** The worker reads the configured key. If that fails, it exits with `opencode_go_key_unusable: <reason>`. The reason is either the reader's fixed message or an exception type such as `FileNotFoundError`. A review that later finds the key unreadable is inconclusive with `provider_credential_unavailable` and sends no request.
- **Codex socket.** When `codex_socket` is set, the worker waits up to 120 seconds for something to accept a connection on it. A missing path, a regular file, or a stale socket that nothing is listening on all count as not ready yet. If the wait runs out, the worker exits with `codex_socket_unavailable`. Other errors, such as permission denied, stop the worker immediately.

Each review sends the unchanged prompt to `https://opencode.ai/inference/go/openai/v1` as one Chat Completions request:
- The request offers a single tool, `final_result`, built from the `Verdict` schema with `"strict": true`, and sets `tool_choice` to `required`.
- `max_completion_tokens` is 8192.
- If the reply is missing, malformed, or contains more than one verdict, the review is inconclusive with `review_output_invalid`.
- If the request fails or exceeds 600 seconds, the code is `provider_request_failed`. The diagnostic records `http_status` when the provider answered.

Neither failure is retried; the owner can request a numbered retry as before.

The approved goal text and the exact candidate diff go to OpenCode Go. Under the Claude reviewer, they went to Anthropic.

## Compatibility with stored records

Receipts gain one `reviewer` value, `opencode-go`. Stored Claude receipts and their evidence are unchanged and still validate. New evidence files record `reviewer`. Each `diagnostics` entry keeps the shape `{model, outcome, reported_models?}`. OpenCode Go entries may also carry `http_status`. For OpenCode Go, `model` is `glm-5.3-flash` and `reported_models` holds the model name the provider returned. Legacy recovery only accepts Claude-era evidence that predates `schema_version`, so OpenCode Go receipts can never take that path.

Forge reads receipts through Crew's contract module, and its web client keeps its own copy of the schema. Both currently accept only `claude-cli`. Upgrade Crew, then update and redeploy Forge. Select `opencode-go` only after both are updated.

## Build the image

`packaging/executor.Dockerfile` uses the same build arguments as the root Dockerfile: `PYTHON_IMAGE` (Python 3.13 Debian slim) and `UV_IMAGE`. Pin both by digest; the build fails if either lacks an `@sha256:` digest. For builds that target more than one architecture, use the multi-platform index digest.

What the image contains:
- The locked Python dependencies, installed under `/venv`.
- Debian `git`, `gh`, `openssh-client` and `tini`. Their versions are not pinned; they are whatever the base image's Debian release serves when you build.
- Codex, from the npm platform package that `package-lock.json` pins for `@openai/codex` 0.167.1. The build checks the package against the lock file's sha512 value. It leaves out the package's voice resources, and Node is not installed.

The image runs as UID/GID 10001 (`crew`, home `/home/crew`), with `tini` as its entrypoint and the activity worker as its default command. The build context contains only `pyproject.toml`, `uv.lock` and `src/birbcrew`.

```sh
docker build --platform linux/arm64 \
  --build-arg PYTHON_IMAGE="$PYTHON_IMAGE" --build-arg UV_IMAGE="$UV_IMAGE" \
  -f packaging/executor.Dockerfile -t "$EXECUTOR_IMAGE" .
```

Use `--platform linux/amd64` for x86-64 nodes.

## Run Codex beside the worker

Run two containers from this image in one pod, both as UID 10001.

| Container | Command |
| --- | --- |
| Codex app-server | `codex app-server --listen unix://` |
| Activity worker | default (`python -m birbcrew.execution.worker`) |

Run the Codex app-server in the foreground as its container's main process. Do not run `codex app-server daemon start` in a pod: it detaches, copies a managed Codex release into `CODEX_HOME`, and runs a self-updater.

`CODEX_HOME` (`/home/crew/.codex`) must exist before the server starts.
- The server listens on `/tmp/codex-daemon-10001/<socket name>`. It also links `$CODEX_HOME/app-server-control/app-server-control.sock` to that path.
- To read the socket name, run `readlink` on that link in the server container, and recheck it after a Codex upgrade.
- Mount the shared volume at `/tmp`. The server rejects a volume mounted directly at `/tmp/codex-daemon-10001`.

Each activity starts `codex app-server proxy` in the worker container.
- **Recommended:** set `codex_socket` to the server's socket path. Crew passes it as `--sock`. The worker then needs only the shared `/tmp`, not `CODEX_HOME` and the ChatGPT login it holds.
- **Without `codex_socket`:** the proxy follows the `CODEX_HOME` link. The worker then needs the same `CODEX_HOME` mount.

Codex supports headless sign-in with `codex login --device-auth`. Without a keyring, it stores the credential in `$CODEX_HOME/auth.json`. Before submitting work, an operator can call `account/read`. While signed out, it reports `"account": null` and `"requiresOpenaiAuth": true`.

On SIGTERM, the worker stops polling and lets running activities finish for up to 660 seconds. After that it cancels them. Give the pod a longer termination grace period, such as 690 seconds.

- **Review.** The window covers a whole review.
- **Author turn.** An author turn can run longer (`turn_timeout_seconds`, up to 3600). If it is cancelled at shutdown, it does not interrupt the Codex turn. Temporal retries the activity on the next worker, which resumes the turn. Each such restart uses one of Forge's three activity attempts.
- **Other interruptions.** An eviction, an OOM kill or a SIGKILL after the window leaves an unconfirmed claim that needs operator reconciliation. In a pod these are more frequent than on the Mac host.

## Mounts

| Path | Containers | Purpose |
| --- | --- | --- |
| `/tmp` | both, shared, writable | Codex control socket directory. |
| `/home/crew/.codex` | Codex, writable, persistent | `CODEX_HOME`, including the Codex login. Also mount it in the worker if `codex_socket` is unset. |
| `worktree_root` | both, same path, writable, persistent | The author edits its worktree through Codex. The worker creates, freezes and commits candidates there. |
| `repository.checkout` | worker writable; Codex read-only; same path | Owns the Git directory of every worktree. |
| `artifact_root` | worker, writable, persistent | Private review and acceptance evidence. |
| `BIRBCREW_CONFIG`, `BIRBCREW_EXECUTION_CONFIG` files | worker, read-only | Store, Temporal and execution settings. Include the Temporal mTLS files if configured. |
| `api_key_file` | worker | A private copy owned by UID 10001, mode 0400 or 0600. |
| `/home/crew/.ssh/` | worker, read-only | Deploy key and a `known_hosts` entry for `github.com`. OpenSSH reads this directory from the passwd entry, not `$HOME`. |
| `gh` credentials | worker | `GH_TOKEN`, or `GH_CONFIG_DIR` pointing at a mounted `hosts.yml`. Every child process inherits the worker's environment and UID. Git, the acceptance command and the Codex proxy can therefore reach either form. `GH_CONFIG_DIR` only keeps the token out of environment dumps. |

Keep the OpenCode Go key, SSH key and GitHub credentials out of the Codex container. Put them on worker-only volumes, never on the shared `/tmp`. Both containers run as UID 10001, so file modes do not separate them. The worker runs Git with those credentials against the checkout's configuration. Mount the checkout read-only in the Codex container so the author cannot change that configuration.

The author's writes to `worktree_root` are limited only by the Codex sandbox, which is not verified in this container. Treat the separation as defense in depth for a trusted-owner pilot, not as isolation.

Kubernetes Secret volumes usually expose keys as root-owned symbolic links, which `api_key_file` rejects. Copy the key into a private file before the worker starts. Prepare the SSH key so that OpenSSH running as UID 10001 accepts it. This repository has no Kubernetes manifests, and none of these steps has been tested.

## What was verified

- **Tests.** `uv run --group dev pytest` covers:
  - Settings: reviewer selection, the `claude` path rules, absolute paths, key-file permissions and contents, the existing `$HOME/.profile` reader, the startup checks (including that they do not echo file contents or configuration values), the socket wait (missing, regular file, stale and listening), and `--sock` reaching the proxy argv for authoring and interruption.
  - Worker wiring with a stand-in Temporal worker: SIGTERM ends the wait, and the 660-second grace period is passed. The drain itself is Temporal's `graceful_shutdown_timeout`; this repository does not test it.
  - Reviews, using a local scripted model and a local HTTP stub: approved; changes requested; malformed, missing or conflicting verdicts; provider HTTP and connection failures; timeouts; a missing or invalid key; a leftover attestation file that is absent, expired or invalid having no effect; a single request with no retry; closing the provider client; and heartbeats while a request is pending.
- **Image runs.** The image was built for linux/arm64 and for linux/amd64 (emulated). Both were run with `--user 10001:10001 --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp`. Both reported `codex-cli 0.167.1`, git 2.47.3, gh 2.46.0 and OpenSSH 10.0p2, and imported `birbcrew.execution.worker`.
- **Two-container Codex on linux/arm64.**
  - A foreground `codex app-server --listen unix://` container served Crew's `Daemon` client from a second container. The containers shared `/tmp`.
  - With `CODEX_HOME` shared as well, the client worked through both the default link and `--sock`.
  - Without `CODEX_HOME`, it worked through `--sock` and failed through the default link.
  - `account/read` returned the signed-out state, and the server exited 0 on SIGTERM.
  - Three server starts with fresh volumes and the same `CODEX_HOME` path used the same socket name.
  - The startup socket wait accepted a live server, and the `Daemon` client worked right after it. It rejected the socket file left behind when the server was SIGKILLed.
- **SSH lookup.** With `HOME` pointed elsewhere, OpenSSH in the image still looked for identities under `/home/crew/.ssh`.
- **Codex prototype.** A separate Codex 0.167.1 container prototype established three facts: what `daemon start` does, that the server rejects a volume mounted at `/tmp/codex-daemon-10001`, and where device sign-in stores its credential.

## What is not verified

- A live OpenCode Go review. In particular, it is unproven that `glm-5.3-flash` accepts the strict tool, `tool_choice: required` and `max_completion_tokens` through OpenCode Go.
- A live Codex subscription turn in a container, including `codex login --device-auth` and authoring with the checkout mounted read-only.
- `git push`, `gh pr create` and `gh` authentication from the container.
- Whether Codex's bundled bubblewrap sandbox can run tool commands with all capabilities dropped. The server logs that bubblewrap is not on `PATH` and falls back to its bundled copy.
- Kubernetes scheduling, termination, volume ownership and Secret handling.
