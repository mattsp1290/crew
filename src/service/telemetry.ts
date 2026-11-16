import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, writeSync } from "node:fs";
import { ROOT_CONTEXT, SpanStatusCode, trace, type Context } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, type SpanExporter, type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { z } from "zod";
import { engineSchema, type Engine } from "./domain.ts";

const names = ["workflow.segment", "model.invoke", "tool.settle", "native.restore"] as const;
type Operation = (typeof names)[number];
type Scope = { engine: Engine; conversationId: string; requestId: string; workflowRunId: string; childId?: string };

const active = new AsyncLocalStorage<{ traceId: string; context: Context }>();
const uuid = z.uuid();
const output = process.env.BIRBCREW_TRACE_FILE;
const endpoint = otlpEndpoint(process.env);

// A typo must stop startup, not silently send spans elsewhere or drop them. Errors name the variable and never
// repeat its value, because a rejected URL may contain credentials. Plain http is allowed to 127.0.0.1, or to any
// host when the operator also sets BIRBCREW_OTLP_TRACES_ALLOW_HTTP=true (an in-cluster agent). Collector headers
// from the OTLP environment variables ride on every request, so that opt-in refuses them: nothing secret crosses
// the network in the clear. IPv6 literals are refused outright, unlike in the proxy relay: the exporter passes the
// bracketed host to node:http, which cannot resolve it, so every export would fail unnoticed.
// The exporter sends only the path, so a query or fragment (often an ingest key) would be dropped silently.
function otlpEndpoint(env: NodeJS.ProcessEnv) {
  const value = env.BIRBCREW_OTLP_TRACES_ENDPOINT;
  if (!value) return undefined;
  const allowHttp = env.BIRBCREW_OTLP_TRACES_ALLOW_HTTP ?? "";
  if (!/^(true|false|)$/i.test(allowHttp)) throw new Error("BIRBCREW_OTLP_TRACES_ALLOW_HTTP must be true or false");
  const url = URL.parse(value);
  const plaintext = url?.protocol === "http:" && url.hostname !== "127.0.0.1";
  if (!url || url.username || url.password || url.search || url.hash || url.pathname === "/" ||
      url.hostname.startsWith("[") || !(url.protocol === "https:" || url.protocol === "http:") ||
      (plaintext && allowHttp.toLowerCase() !== "true")) {
    throw new Error("BIRBCREW_OTLP_TRACES_ENDPOINT must be an https OTLP traces URL with a path (plain http only to "
      + "127.0.0.1, or to any host with BIRBCREW_OTLP_TRACES_ALLOW_HTTP=true), such as https://collector.example/v1/traces, "
      + "with no IPv6 literal, credentials, query or fragment");
  }
  if (plaintext && (env.OTEL_EXPORTER_OTLP_HEADERS?.trim() || env.OTEL_EXPORTER_OTLP_TRACES_HEADERS?.trim())) {
    throw new Error("BIRBCREW_OTLP_TRACES_ALLOW_HTTP sends spans without encryption, so OTEL_EXPORTER_OTLP_HEADERS and "
      + "OTEL_EXPORTER_OTLP_TRACES_HEADERS must be unset");
  }
  return url.href;
}

// OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES as the OpenTelemetry specification defines them: comma-separated
// key=value entries with W3C Baggage keys and percent-encoded values. The SDK's own detector skips or silently
// discards malformed input and has no size bound. Here malformed input stops startup like a bad endpoint, so a
// typo cannot quietly drop the deployment environment or version, and the error names only the variable and entry.
const ows = (text: string) => text.replace(/^[ \t]+|[ \t]+$/g, "");
const baggageKey = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,255}$/;
const baggageValue = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;
// Control, invisible formatting, and line or paragraph separator characters.
const unprintable = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// Lengths count Unicode code points, not UTF-16 units.
const usable = (value: string) => value.trim() !== "" && [...value].length <= 255 && !unprintable.test(value);
function otlpResource(env: NodeJS.ProcessEnv) {
  const text = env.OTEL_RESOURCE_ATTRIBUTES ?? "";
  // Whitespace around the whole value, such as a newline from a YAML block, is ignored. Positions in errors count
  // every comma-separated part, empty ones included.
  const parts = text.length > 4_096 ? [] : text.trim().split(",").map(ows);
  if (text.length > 4_096 || parts.filter(Boolean).length > 32) {
    throw new Error("OTEL_RESOURCE_ATTRIBUTES must have at most 32 entries and 4096 characters");
  }
  const attributes = new Map<string, string>();
  parts.forEach((entry, index) => {
    if (!entry) return;
    const split = entry.indexOf("="), key = ows(entry.slice(0, split)), encoded = ows(entry.slice(split + 1));
    let value: string | undefined;
    try { value = decodeURIComponent(encoded); } catch {}
    // The SDK builds the resource in a plain object and skips keys it inherits, such as toString or __proto__.
    if (split < 0 || !baggageKey.test(key) || key in Object.prototype || attributes.has(key) ||
        !baggageValue.test(encoded) || value === undefined || !usable(value)) {
      throw new Error(`OTEL_RESOURCE_ATTRIBUTES entry ${index + 1} is invalid: each entry must be key=value with a `
        + "unique W3C Baggage key and a percent-encoded value that, once decoded, is not blank, has at most 255 "
        + "characters and has no control characters");
    }
    attributes.set(key, value);
  });
  const service = (env.OTEL_SERVICE_NAME ?? "").trim();
  if (service && !usable(service)) {
    throw new Error("OTEL_SERVICE_NAME must be at most 255 characters with no control characters");
  }
  attributes.set("service.name", service || attributes.get("service.name") || "birbcrew");
  return Object.fromEntries(attributes);
}

const exporter: SpanExporter = {
  export(spans, done) {
    try {
      for (const span of spans) {
        const { traceId, spanId } = span.spanContext();
        appendFileSync(output!, JSON.stringify({
          name: span.name, traceId, spanId, parent: span.parentSpanContext?.spanId,
          start: span.startTime, duration: span.duration, status: span.status.code, attributes: span.attributes,
        }) + "\n", { mode: 0o600 });
      }
      done({ code: 0 });
    } catch { done({ code: 1 }); }
  },
  async shutdown() {},
};
const exportTimeoutMs = 2_000;
// The OTEL_* resource variables are read only when OTLP export is on, so they cannot stop any other process.
const resource = endpoint ? otlpResource(process.env) : { "service.name": "birbcrew" };
const processors: SpanProcessor[] = [];
if (output) processors.push(new SimpleSpanProcessor(exporter));
if (endpoint) {
  // Loaded only when configured: every native turn forks a runner that imports this module.
  const [{ OTLPTraceExporter }, { exportWarning }] = await Promise.all([
    import("@opentelemetry/exporter-trace-otlp-http"), import("./telemetry-warning.ts")]);
  const otlp = new OTLPTraceExporter({ url: endpoint, timeoutMillis: exportTimeoutMs });
  // Synchronous, so a closed stderr fails here instead of emitting an unhandled EPIPE error event, and a throw
  // cannot reach the exporter's promise chain as an unhandled rejection.
  const warn = exportWarning((line) => { try { writeSync(2, line); } catch {} });
  // Ending a span only enqueues it. A full queue drops spans, and failed exports are discarded after a
  // rate-limited warning.
  processors.push(new BatchSpanProcessor({
    export: (spans, done) => {
      // The exporter owns the total deadline, including connection setup and response-body consumption.
      let reported = false;
      const report = (error: unknown) => { if (!reported) { reported = true; warn(error); } };
      const timer = setTimeout(() => report(new Error("Request Timeout")), exportTimeoutMs).unref();
      otlp.export(spans, (result) => {
        clearTimeout(timer);
        if (result.code !== 0) report(result.error);
        done(result);
      });
    },
    shutdown: () => otlp.shutdown(),
    forceFlush: () => otlp.forceFlush(),
  }, {
    maxQueueSize: 1_024, maxExportBatchSize: 256, scheduledDelayMillis: 1_000, exportTimeoutMillis: exportTimeoutMs,
  }));
}
const provider = processors.length ? new BasicTracerProvider({
  resource: resourceFromAttributes(resource),
  spanProcessors: processors,
  // Bounds the provider's flush wait. An export can outlive that wait, but the exporter's total deadline
  // still cancels it at exportTimeoutMs.
  forceFlushTimeoutMillis: 1_000,
  idGenerator: {
    generateTraceId: () => active.getStore()?.traceId ?? randomBytes(16).toString("hex"),
    generateSpanId: () => randomBytes(8).toString("hex"),
  },
}) : undefined;
const tracer = provider?.getTracer("birbcrew");

// The host confirms a native turn only after its runner process closes, so the runner's flush is on
// every turn's critical path and gets a much smaller budget than a worker's exit flush.
export const turnFlushBudgetMs = 250;

export async function flushTelemetry(budgetMs = 1_000) {
  if (!provider) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    provider.forceFlush().catch(() => {}),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, budgetMs); }),
  ]);
  clearTimeout(timer);
}

/** `outcome` adds attributes from a successful result; callers pass only counts and closed enums. */
export function traced<T>(name: Operation, scope: Scope, work: () => Promise<T>,
  outcome?: (result: T) => Record<string, string | number>): Promise<T> {
  if (!tracer) return work();
  // An activity can receive additional fields at runtime. Only validated correlation IDs enter the exporter.
  const { engine, conversationId, requestId, workflowRunId, childId } = scope;
  if (![conversationId, requestId, workflowRunId, ...(childId ? [childId] : [])].every((id) => uuid.safeParse(id).success)
      || !engineSchema.safeParse(engine).success) return work();
  const attributes = { engine, conversationId, requestId, workflowRunId, ...(childId && { childId }) };
  const traceId = createHash("sha256").update(conversationId + "/" + requestId).digest("hex").slice(0, 32);
  const current = active.getStore();
  const context = current?.traceId === traceId ? current.context : ROOT_CONTEXT;
  return active.run({ traceId, context }, async () => {
    const span = tracer.startSpan(name, { attributes }, context);
    try {
      const result = await active.run({ traceId, context: trace.setSpan(context, span) }, work);
      if (outcome) span.setAttributes(outcome(result));
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
