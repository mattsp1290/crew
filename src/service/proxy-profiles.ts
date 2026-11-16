import { createProvider, InMemoryCredentialStore, InMemoryModelsStore, type Model, type StreamOptions } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { MemberProfile } from "./profiles.ts";
import { providerHost } from "./provider-identity.ts";
import { startProxyRelay } from "./proxy-relay.ts";

type RelayOptions = Parameters<typeof startProxyRelay>[0];
export type ProxyProfileOptions = RelayOptions & {
  engine: "claude" | "codex" | "pi";
  accountId: string;
  protectedTool?: "record_work_item";
  humanTool?: "choose_next_step";
};

/** Trusted operator configuration only. Never construct this from an AG-UI request. */
export async function createProxyProfile(options: ProxyProfileOptions) {
  const protocols = { claude: "anthropic-messages", codex: "openai-responses", pi: "openai-chat-completions" } as const;
  if (options.protocol !== protocols[options.engine] || !options.accountId?.trim() ||
      !options.model?.trim() || (options.protectedTool && options.humanTool)) {
    throw new Error("Invalid proxy engine, protocol, model, account or tool configuration");
  }
  // Snapshot trusted routing before any invocation can use it.
  const relayOptions = Object.freeze({ ...options, headers: options.headers && Object.freeze({ ...options.headers }) });
  const upstreamHost = providerHost(relayOptions.endpoint);
  const relay = await startProxyRelay(relayOptions);
  const upstreamIdentity = Object.freeze({ model: relayOptions.model, providerHost: upstreamHost,
    relayHost: relayOptions.engine === "codex" ? null : providerHost(relay.baseUrl) });
  const active = new Set<() => Promise<void>>();
  let closed = false;
  const close = async () => {
    closed = true;
    await relay.close();
    await Promise.all([...active].map(stop => stop()));
  };
  try {
    const profile: MemberProfile = {
      accountId: relayOptions.accountId,
      upstreamIdentity: Object.freeze({ [relayOptions.engine]: upstreamIdentity }),
      ...(relayOptions.protectedTool && { protectedTool: relayOptions.protectedTool }),
      ...(relayOptions.humanTool && { humanTool: relayOptions.humanTool }),
    };
    if (relayOptions.engine === "claude") {
      profile.claude = { model: relayOptions.model, baseUrl: relay.baseUrl, apiKey: relay.apiKey };
    } else if (relayOptions.engine === "codex") {
      // The native SDK may settle its abort before its socket closes. Bind the
      // upstream lifetime to the host turn signal, with a separate listener/token
      // per invocation so cancelling one turn cannot cancel another.
      await relay.close();
      profile.codex = { model: relayOptions.model, proxyTransport: async signal => {
        signal.throwIfAborted();
        if (closed) throw new Error("Proxy profile is closed");
        const transport = await startProxyRelay(relayOptions);
        let completion: Promise<void> | undefined;
        const stop = () => {
          if (!completion) {
            signal.removeEventListener("abort", abort);
            completion = transport.close().finally(() => active.delete(stop));
          }
          return completion;
        };
        const abort = () => { void stop().catch(() => {}); };
        active.add(stop);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted || closed) {
          await stop();
          throw new Error("Proxy invocation cancelled");
        }
        return { baseUrl: transport.baseUrl, apiKey: transport.apiKey, close: stop };
      } };
    } else {
      const model: Model<"openai-completions"> = {
        id: relayOptions.model, name: relayOptions.model, provider: "birbcrew-proxy", api: "openai-completions",
        baseUrl: relay.baseUrl, reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsDeveloperRole: false, supportsStore: false },
      };
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
        modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
      });
      const api = openAICompletionsApi();
      const guardedFetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        if (request.url !== relay.baseUrl + "/chat/completions" || request.method !== "POST") {
          throw new Error("Unexpected proxy request destination");
        }
        return fetch(request, { redirect: "error" });
      };
      const streamOptions = (opts?: StreamOptions) => ({ ...opts, apiKey: relay.apiKey, fetch: guardedFetch, maxRetries: 0, maxTokens: 4096 });
      runtime.registerNativeProvider(createProvider({
        id: model.provider, models: [model],
        auth: { apiKey: { name: "Local proxy relay", resolve: async () => ({ auth: { apiKey: relay.apiKey } }) } },
        api: { stream: (m, ctx, opts) => api.stream(m, ctx, streamOptions(opts)),
          streamSimple: (m, ctx, opts) => api.streamSimple(m, ctx, streamOptions(opts)) },
      }));
      profile.pi = { model, modelRuntime: runtime };
    }
    return { profile, close };
  } catch {
    await close();
    throw new Error("Proxy profile initialization failed");
  }
}
