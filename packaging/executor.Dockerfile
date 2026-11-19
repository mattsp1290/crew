ARG PYTHON_IMAGE
ARG UV_IMAGE
FROM ${UV_IMAGE} AS uv

FROM ${PYTHON_IMAGE} AS codex
ARG PYTHON_IMAGE
ARG UV_IMAGE
ARG TARGETARCH
# The final stage copies from this stage, so every build checks that both bases are pinned.
RUN case "$PYTHON_IMAGE" in *@sha256:*) ;; *) echo "Pin PYTHON_IMAGE by digest" >&2; exit 1 ;; esac \
    && case "$UV_IMAGE" in *@sha256:*) ;; *) echo "Pin UV_IMAGE by digest" >&2; exit 1 ;; esac
# The platform packages and their integrity values must match package-lock.json.
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) set -- linux-x64 x86_64-unknown-linux-musl o05NyAOCDygSPRo1yinzxvkRSdmsZyBD9E7mbpmjRanSfM8lypqWtQgEo4XfNkwhuCR2aFu8mlGOsQGFXVbVww== ;; \
      arm64) set -- linux-arm64 aarch64-unknown-linux-musl NZ/DaQUpcQmxmqee7Z9uC1rzw3GhSbooawcaTe1LN5Yk+WlinUKGdTXJgClRT/9ogQEEM9TWxYzvxPfj5G/xFg== ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    platform=$1; triple=$2; \
    python -c 'import sys, urllib.request; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])' \
      "https://registry.npmjs.org/@openai/codex/-/codex-0.169.0-$platform.tgz" /tmp/codex.tgz; \
    printf '%s  /tmp/codex.tgz\n' "$(printf '%s' "$3" | base64 -d | od -An -v -tx1 | tr -d ' \n')" \
      | sha512sum -c -; \
    mkdir /opt/codex; \
    tar -xzf /tmp/codex.tgz -C /opt/codex --strip-components=3 --no-same-owner \
      --exclude="package/vendor/$triple/codex-resources/voice" "package/vendor/$triple"; \
    rm /tmp/codex.tgz; \
    /opt/codex/bin/codex --version

FROM ${PYTHON_IMAGE}
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates gh git openssh-client tini \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 10001 crew \
    && useradd --uid 10001 --gid 10001 --home-dir /home/crew --no-create-home \
      --shell /usr/sbin/nologin crew \
    && install -d -o 10001 -g 10001 -m 0700 /home/crew
COPY --from=codex /opt/codex /opt/codex
RUN ln -s /opt/codex/bin/codex /usr/local/bin/codex
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /app/birbcrew
COPY pyproject.toml uv.lock ./
ENV UV_PROJECT_ENVIRONMENT=/venv UV_PYTHON_DOWNLOADS=never UV_CACHE_DIR=/tmp/uv-cache
RUN uv sync --frozen --no-dev --no-install-project --python /usr/local/bin/python \
    && rm -rf /tmp/uv-cache
COPY src ./src
RUN uv sync --frozen --no-dev --python /usr/local/bin/python \
    && rm -rf /tmp/uv-cache \
    && chmod -R a+rX /app/birbcrew
ENV PATH=/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYDANTIC_AI_NO_BANNER=1 \
    HOME=/home/crew \
    CODEX_HOME=/home/crew/.codex
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["python", "-m", "birbcrew.execution.worker"]
