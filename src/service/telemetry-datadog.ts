import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { z } from "zod";

// Adapted from Switchboard scripts/support/datadog-exporter.mjs at dadfe09 (MIT).
const outcomes = new Set(["success", "error", "cancelled", "outcome-unknown"]);
const uuid = z.uuid();

function datadogSpanView(span: ReadableSpan): ReadableSpan {
  const metadata: Record<string, string> = {};
  const outcome = span.attributes["switchboard.outcome"];
  if (typeof outcome === "string" && outcomes.has(outcome)) metadata.outcome = outcome;
  for (const [source, target] of [["switchboard.run_id", "run_id"], ["switchboard.request_id", "request_id"]]) {
    const value = uuid.safeParse(span.attributes[source]);
    if (value.success) metadata[target] = value.data;
  }
  return {
    name: span.name, kind: span.kind, spanContext: () => ({ ...span.spanContext() }),
    parentSpanContext: span.parentSpanContext && { ...span.parentSpanContext },
    startTime: [...span.startTime], endTime: [...span.endTime], duration: [...span.duration],
    status: { ...span.status }, attributes: { ...span.attributes,
      ...(Object.keys(metadata).length && { "_dd.ml_obs.metadata": JSON.stringify({ switchboard: metadata }) }) },
    links: span.links, events: span.events, resource: span.resource, instrumentationScope: { ...span.instrumentationScope },
    ended: span.ended, droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount, droppedLinksCount: span.droppedLinksCount,
  };
}

export function datadogExporter(exporter: SpanExporter): SpanExporter {
  return {
    export(spans, callback) {
      let called = false;
      const complete: typeof callback = (result) => { if (!called) { called = true; callback(result); } };
      try { exporter.export(spans.map(datadogSpanView), complete); }
      catch { complete({ code: 1, error: new Error("Datadog exporter failed") }); }
    },
    forceFlush: () => Promise.resolve().then(() => exporter.forceFlush?.()),
    shutdown: () => Promise.resolve().then(() => exporter.shutdown()),
  };
}
