import { constants } from "node:fs";
import { mkdir, lstat, open, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { claudeAccount, codexApiAccount, codexSubscriptionAccount, codexSubscriptionEndpoint, codexSubscriptionHome, credential, goAccount, goEndpoint, goModel, type LiveProfiles } from "../../src/service/accounts.ts";
import { readCodexSubscription } from "../../src/service/codex-subscription.ts";
import { engineSchema, type Engine } from "../../src/service/domain.ts";

// One owner decision to spend up to max_requests on one proof run. It names the account as the worker configuration
// does, and it is single-use: the first provider submission claims approval_id for good. It carries no date and never
// expires; the owner withdraws it by changing or removing the file, which the relay rereads before every request.
const approved = {
  approval_id: z.uuid(),
  approved_live_proof: z.literal(true),
  max_requests: z.number().int().min(1).max(24),
};
const go = goAccount.extend({ ...approved, endpoint: z.literal(goEndpoint), model: z.literal(goModel) }).strict();
const claude = claudeAccount.extend({ ...approved, endpoint: z.literal("https://api.anthropic.com") }).strict();
const codex = z.discriminatedUnion("provider", [
  codexApiAccount.extend({ ...approved, endpoint: z.literal("https://api.openai.com/v1") }).strict(),
  codexSubscriptionAccount.extend({ ...approved, endpoint: z.literal(codexSubscriptionEndpoint) }).strict(),
]);
const accounts = { pi: go, claude, codex };
export const accountKey = { pi: "OPENCODE_GO_API_KEY", claude: "BIRBCREW_CLAUDE_API_KEY", codex: "BIRBCREW_CODEX_API_KEY" } as const;

async function readProofApproval<T>(path: string, schema: z.ZodType<T>) {
  if (!isAbsolute(path)) throw new Error("Use an absolute path to the private proof approval");
  const file = await realpath(path);
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  if (!relative(repo, file).startsWith("../")) throw new Error("Keep proof approvals outside the checkout");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let parsed;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) || metadata.size > 16_384 ||
        metadata.uid !== process.getuid?.()) throw new Error("Use a private owner-readable proof approval");
    parsed = schema.safeParse(JSON.parse(await handle.readFile("utf8")));
  } finally { await handle.close(); }
  if (!parsed.success) throw new Error("Invalid proof approval");
  return parsed.data;
}

export async function authorizeLive(args: string[], env: NodeJS.ProcessEnv,
  claims = join(userInfo().homedir, ".local", "state", "birbcrew", "live-proof-claims"), subscriptionCredential = readCodexSubscription) {
  const { values } = parseArgs({ args, options: { engine: { type: "string", multiple: true }, approval: { type: "string", multiple: true } } });
  const engine = engineSchema.parse(z.array(z.string()).length(1).parse(values.engine)[0]);
  const path = z.array(z.string()).length(1).parse(values.approval)[0];
  const schema: z.ZodType<z.infer<(typeof accounts)[Engine]>> = accounts[engine];
  const approval = await readProofApproval(path, schema);
  // The proof worker gets the account the same way a deployed worker does.
  const identity = approval.provider === "chatgpt-subscription" ? { account_id: approval.account_id } : { account: approval.account };
  const liveProfiles: LiveProfiles = { [engine]: { provider: approval.provider, ...identity, ...(engine !== "pi" && { model: approval.model }) } };
  const subscription = approval.provider === "chatgpt-subscription" ? approval : undefined;
  const prefix = { "chatgpt-subscription": "chatgpt-", "openai-api": "openai-", "anthropic-api": "anthropic-", "opencode-go": "pi-go-" };
  function signingHeaders() {
    if (subscription) {
      const expected = subscription.account_id;
      return async () => {
        const { accessToken, accountId } = await subscriptionCredential(codexSubscriptionHome(env), expected);
        if (!accessToken || accountId !== expected) throw new Error("Codex subscription account changed");
        return new Headers({ Authorization: "Bearer " + accessToken, "ChatGPT-Account-Id": accountId });
      };
    }
    const key = credential(env[accountKey[engine]], accountKey[engine]);
    return async () => new Headers(engine === "claude" ? { "x-api-key": key } : { Authorization: "Bearer " + key });
  }
  const providerHeaders = signingHeaders();
  if (subscription) await providerHeaders();
  return {
    engine, liveProfiles: JSON.stringify(liveProfiles), providerHeaders, origin: approval.endpoint, model: approval.model, budget: approval.max_requests,
    profile: prefix[approval.provider] + approval.model + ".approval.v1", auth: approval.provider,
    async claim() {
      await mkdir(claims, { recursive: true, mode: 0o700 });
      const dir = await lstat(claims);
      if (await realpath(claims) !== claims || !dir.isDirectory() || dir.uid !== process.getuid!() || (dir.mode & 0o077)) {
        throw new Error("A private owner-controlled live claim directory is required");
      }
      // An exclusive, permanent claim spends this approval, including after a verifier crash.
      const reservation = await open(join(claims, approval.approval_id), "wx", 0o600);
      await reservation.close();
    },
    async recheck() {
      const current = await readProofApproval(path, schema);
      if (current.provider !== approval.provider ||
          (current.provider === "chatgpt-subscription" && current.account_id !== subscription?.account_id) ||
          (current.provider !== "chatgpt-subscription" && approval.provider !== "chatgpt-subscription" && current.account !== approval.account) ||
          current.approval_id !== approval.approval_id || current.model !== approval.model ||
          current.max_requests !== approval.max_requests) throw new Error("Live authorization changed");
    },
  };
}

export type LiveAccount = Awaited<ReturnType<typeof authorizeLive>>;
