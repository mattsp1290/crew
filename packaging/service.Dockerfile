# check=skip=InvalidDefaultArgInFrom
# TypeScript member gateway and worker. See docs/persistent-deployment.md.
# NODE_IMAGE must be a digest-pinned Node 24.22.3 Debian bookworm image; there is no default.
ARG NODE_IMAGE

FROM ${NODE_IMAGE} AS build
ARG NODE_IMAGE
RUN case "$NODE_IMAGE" in *@sha256:*) ;; *) echo "Pin NODE_IMAGE by digest" >&2; exit 1 ;; esac \
    && { test "$(node --version)" = v24.22.3 || { echo "NODE_IMAGE must be Node v24.22.3, not $(node --version)" >&2; exit 1; }; } \
    && { grep -q '^12\.' /etc/debian_version || { echo "NODE_IMAGE must be Debian 12 (bookworm)" >&2; exit 1; }; }
# The launcher must link against the runtime image's glibc, so it is compiled from the same base.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libc6-dev linux-libc-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor/ag-ui/*.tgz vendor/ag-ui/
COPY packages/pi-subagents/birbcrew-pi-subagents-0.1.0.tgz packages/pi-subagents/
COPY packages/client/package.json packages/client/tsconfig.json packages/client/LICENSE packages/client/
COPY packages/client/src packages/client/src
RUN npm ci --include=dev --no-audit --no-fund \
    && npm run build:client \
    && npm prune --omit=dev --no-audit --no-fund
COPY scripts/build-native scripts/
COPY native/member-launch.c native/
RUN scripts/build-native
COPY src/service src/service

FROM ${NODE_IMAGE}
# Node carries its own trust roots. The bundled Codex binary reads the system store, and without it
# every Codex member turn fails with "Connection failed: error sending request".
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && tini --version | grep -q '^tini version 0\.19\.0' \
    && groupadd --gid 10001 crew \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin crew \
    && install -d -o 10001 -g 10001 -m 0700 /var/lib/birbcrew/native
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages/client/package.json /app/packages/client/LICENSE /app/packages/client/
COPY --from=build /app/packages/client/dist /app/packages/client/dist
# Source resolves the launcher at <repo>/.proof/bin/member-launch relative to src/service.
COPY --from=build /app/.proof/bin/member-launch /app/.proof/bin/member-launch
COPY --from=build /app/src/service /app/src/service
ENV HOME=/tmp BIRBCREW_STATE_DIR=/var/lib/birbcrew/native
WORKDIR /app
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--"]
