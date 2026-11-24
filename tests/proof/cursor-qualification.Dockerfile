# Disposable qualification tools, never the model worker image.
FROM docker:29.2.1-cli@sha256:cab69e2d0a1a2ea9a1ce1060252f439e83483ae41ec09317aecb33b08a0656a5 AS docker-cli
FROM node:24.22.3-bookworm@sha256:9d266751ca3d7fdbe651c878ffd5ad0a42fed49a18c283509267c97f025b7496
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY . ./
RUN test "$(node --version)" = v24.22.3 \
    && test "$(npm --version)" = 11.19.1 \
    && npm ci --no-audit --no-fund \
    && npm run build \
    && npm ci --prefix clients --ignore-scripts --no-audit --no-fund \
    && scripts/install-temporal-cli .proof/bin \
    && groupadd --gid 10001 crew \
    && useradd --uid 10001 --gid 10001 --no-create-home crew \
    && chown -R 10001:10001 /app
ENV HOME=/tmp TEMPORAL_CLI=/app/.proof/bin/temporal
USER 10001:10001
