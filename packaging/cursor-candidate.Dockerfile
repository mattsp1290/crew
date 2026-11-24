# check=skip=InvalidDefaultArgInFrom
# Candidate-only audit image. This does not change the service dependency pin.
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
ARG NODE_IMAGE
RUN case "$NODE_IMAGE" in *@sha256:*) ;; *) exit 1 ;; esac \
    && test "$(node --version)" = v24.22.3 \
    && grep -q '^12\.' /etc/debian_version \
    && command -v unshare
WORKDIR /audit
COPY package.json package-lock.json candidate.tgz ./
RUN npm ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund
COPY candidate.mjs contract.json ./
USER 10001:10001
CMD ["node", "candidate.mjs"]
