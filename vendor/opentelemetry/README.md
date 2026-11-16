# Bounded OTLP exporter

Crew selects a modified `@opentelemetry/otlp-exporter-base@0.208.0` archive for direct and transitive consumers. A collector that keeps sending an unfinished response can otherwise retain response buffers and keep a returning worker alive.

The repair caps retained response chunks at 4 MiB and gives each Node HTTP export one deadline across initialization, headers, compression, requests, responses, and retry delays. Completion clears response buffers, upload streams, timers, and abort listeners. Cancellation also destroys the request. Shutdown cancels active exports and destroys the owned Agent. Browser delegates retain their existing policy. Crew's queue, warning suppression, correlation attributes, and caller flush budgets remain unchanged.

The package name, version, User-Agent, runtime dependencies, and original metadata remain unchanged. The archive contains the original 324 published build paths and three metadata files. It excludes declaration maps and build-info files. The original [Apache license](LICENSE) is preserved. Modified sources and distributed outputs carry modification notices.

The archive SHA-256 is `816053c680b29cab95afada446be2593a05f34a16cd414759358ec8f8a54672e`. The [fixed recipe](otlp-exporter-base-0.208.0-crew.1/source.patch) applies six source changes to the authenticated upstream package. [Rebuild instructions](otlp-exporter-base-0.208.0-crew.1/REBUILD.md) describe the pinned tools and byte checks.

Remove this repair when a selected upstream release passes the maintained exporter regressions and worker shutdown qualification. Review its dependency changes. Remove the direct archive dependency, override, archive, and recipe together. Regenerate the application lock and check that direct and trace-exporter consumers resolve one package in clean installs with lifecycle scripts enabled and disabled.
