# Rebuild the archive

Use Node 24.22.3, npm 11.19.1, and Python 3. The reviewed Node executable hash is in `pins.json`. This recipe was qualified on macOS arm64. The application consumes the resulting JavaScript archive on Linux.

The builder makes no network requests and runs no package manager. It accepts an authenticated registry archive and a clean toolchain materialized from the included npm lock. Application installation does not run the builder.

1. Create a temporary input directory outside the repository.
2. Copy `toolchain/package.json` and `toolchain/package-lock.json` into its `tools` subdirectory.
3. Run `npm ci --ignore-scripts --no-audit --no-fund` in that subdirectory with the pinned npm version. Keep caches and logs outside `tools`.
4. Download `https://registry.npmjs.org/@opentelemetry/otlp-exporter-base/-/otlp-exporter-base-0.208.0.tgz` into the input directory as `original.tgz`. The builder checks its locked SHA-512, SHA-256, size, and inventory before reading sources.
5. Run the following command from this recipe directory. Supply absolute input paths and a nonexistent output directory.

```sh
python3 build.py \
  --registry /absolute/input/original.tgz \
  --toolchain /absolute/input/tools \
  --node /absolute/path/to/node \
  --output /absolute/path/to/new-output
```

The builder recovers 36 sources from 108 authenticated maps and checks every source preimage and patched postimage. It uses the recorded upstream configurations with TypeScript 5.0.4 and Node declarations 18.6.5. Each of two fresh builds compiles original and candidate sources in three modes. Every original published file must match the registry bytes. Every candidate output must match the reviewed pins.

The builder preserves generated code positions when it adds notices that TypeScript omits. It retains compiler source-map fields and adds a modification field to changed maps. It creates a sorted USTAR archive with fixed ownership, modes, timestamps, and gzip metadata. Both builds must produce identical archive and provenance data.

The output contains `opentelemetry-otlp-exporter-base-0.208.0-crew.1.tgz` and `provenance.json`. The expected archive SHA-256 is `816053c680b29cab95afada446be2593a05f34a16cd414759358ec8f8a54672e`. A mismatch stops the build. Preserve a failed output directory for inspection and use a new directory after fixing the cause. Do not regenerate expected hashes to accept an unexplained difference.

Build identity does not establish runtime behavior or npm selection. Run the maintained telemetry tests and worker shutdown qualification against the selected archive. Check clean installs with lifecycle scripts enabled and disabled. A selected upstream replacement must pass those checks before removing the repair.
