import { readCodexSubscription } from "./codex-subscription.ts";
import { codexSubscriptionHome, credential, goEndpoint, goModel, readLiveProfiles, userAgent } from "./accounts.ts";
import { createProvider, InMemoryCredentialStore, InMemoryModelsStore, type StreamOptions } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { OPENCODE_GO_MODELS } from "@earendil-works/pi-ai/providers/opencode-go.models";
import { withOpenCodeSessionHeader } from "@earendil-works/pi-ai/providers/opencode-headers";
import { ModelRuntime, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { MemberProfile } from "./profiles.ts";

const modelsResponse = z.object({ data: z.array(z.object({ id: z.string() })) });

async function configureGo(key: string, transport: typeof fetch) {
  const model = OPENCODE_GO_MODELS[goModel];
  if (model.provider !== "opencode-go" || model.api !== "openai-completions" ||
      model.id !== goModel || model.baseUrl !== goEndpoint) throw new Error("Pi's Go model route changed");

  const guardedFetch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    if (req.url !== goEndpoint + "/chat/completions" || req.method !== "POST") {
      throw new Error("Unexpected OpenCode Go request destination");
    }
    if (req.headers.get("authorization") !== "Bearer " + key ||
        req.headers.get("user-agent") !== userAgent || req.headers.has("x-opencode-client") ||
        !req.headers.get("x-opencode-session")) throw new Error("Missing BirbCrew request identity");
    const body = await req.text();
    if (JSON.parse(body).model !== goModel) throw new Error("Unexpected OpenCode Go model");
    const headers = new Headers();
    for (const name of ["authorization", "content-type", "accept", "user-agent", "x-opencode-session"]) {
      const value = req.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    return transport(req.url, { method: "POST", headers, body, signal: req.signal, redirect: "error" });
  };
  const api = withOpenCodeSessionHeader(openAICompletionsApi());
  const options = (opts?: StreamOptions) => ({
    ...opts, apiKey: key, fetch: guardedFetch, maxRetries: 0, maxTokens: 1200,
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(createProvider({
    id: model.provider, models: [model], auth: { apiKey: {
      name: "Approved Go credential", resolve: async () => ({ auth: { apiKey: key } }),
    } },
    api: {
      stream: (m, ctx, opts) => api.stream(m, ctx, options(opts)),
      streamSimple: (m, ctx, opts) => api.streamSimple(m, ctx, options(opts)),
    },
  }));

  async function prepare() {
    const response = await transport(goEndpoint + "/models", {
      headers: { Authorization: "Bearer " + key, "User-Agent": userAgent },
      redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    if (response.status !== 200 || !modelsResponse.parse(await response.json()).data.some(({ id }) => id === goModel)) {
      throw new Error("Go preflight did not confirm the approved model");
    }
    let confirmed = false;
    let mismatch = false;
    const extension: ExtensionFactory = (pi) => {
      pi.on("before_provider_headers", (event) => {
        event.headers["User-Agent"] = userAgent;
        event.headers["x-opencode-client"] = null;
      });
      pi.on("provider_stream_event", (event) => {
        const frame = z.object({ model: z.string() }).safeParse(event.data);
        if (!frame.success) return;
        if (frame.data.model === goModel) confirmed = true;
        else mismatch = true;
      });
    };
    return { extension, verify() {
      if (mismatch || !confirmed) throw new Error("Go stream did not confirm the approved response model");
    } };
  }
  return { model, modelRuntime, prepare };
}

// The configured account is fixed for the life of the process, so a turn has nothing to read again.
// The Codex drivers still require the hook: it marks a profile that carries its own account credential.
const configuredAccount = async () => {};

/**
 * Builds the live member profiles from BIRBCREW_LIVE_PROFILES alone. Each configured engine needs its real
 * credential now (an API key) or on every turn (the Codex sign-in), and a missing one is an error, never a fallback.
 */
export async function loadLiveProfiles(env: NodeJS.ProcessEnv, transport: typeof fetch = fetch, subscriptionCredential = readCodexSubscription) {
  const accounts = readLiveProfiles(env);
  const configured = new Map<string, MemberProfile>();
  if (accounts.pi) {
    configured.set("pi-go-glm-5.3-flash.v1", {
      accountId: accounts.pi.account,
      pi: await configureGo(credential(env.OPENCODE_GO_API_KEY, "OPENCODE_GO_API_KEY"), transport),
    });
  }
  if (accounts.claude) {
    const { model, account } = accounts.claude;
    const claude = { model, baseUrl: "https://api.anthropic.com",
      apiKey: credential(env.BIRBCREW_CLAUDE_API_KEY, "BIRBCREW_CLAUDE_API_KEY") };
    configured.set(`anthropic-${model}.v1`, { accountId: account, claude });
  }
  if (accounts.codex?.provider === "chatgpt-subscription") {
    const { model, account_id } = accounts.codex;
    const home = codexSubscriptionHome(env);
    configured.set(`chatgpt-${model}.v1`, {
      accountId: account_id,
      codex: { model, authorize: configuredAccount, subscription: () => subscriptionCredential(home, account_id) },
    });
  } else if (accounts.codex) {
    const { model, account } = accounts.codex;
    configured.set(`openai-${model}.v1`, { accountId: account,
      codex: { model, authorize: configuredAccount, apiKey: credential(env.BIRBCREW_CODEX_API_KEY, "BIRBCREW_CODEX_API_KEY") } });
  }
  for (const [name, profile] of [...configured]) {
    if (profile.pi) configured.set(name.replace(/\.v1$/, ".crew.v1"), { ...profile, delegateTask: true, protectedTool: "record_work_item" });

    configured.set(name.replace(/\.v1$/, ".next-step.v1"), { ...profile, humanTool: "choose_next_step" });
    configured.set(name.replace(/\.v1$/, ".approval.v1"), { ...profile, protectedTool: "record_work_item" });
  }
  return configured;
}
