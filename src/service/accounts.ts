import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const goEndpoint = "https://opencode.ai/inference/go/openai/v1";
export const goModel = "glm-5.3-flash";
export const userAgent = "birbcrew-coding-proof/0.1.0";
export const codexSubscriptionEndpoint = "https://chatgpt.com/backend-api/codex";

// A label the operator chooses for the account. Its digest binds registered profiles and native state to that account.
// Trimmed and non-empty, exactly as the label was read before, so an existing registration keeps its digest.
const account = z.string().trim().min(1);
const codexModel = z.string().regex(/^gpt-[a-z0-9.-]+$/).max(90);
export const goAccount = z.strictObject({ provider: z.literal("opencode-go"), account });
export const claudeAccount = z.strictObject({
  provider: z.literal("anthropic-api"), account,
  model: z.string().regex(/^claude-[a-z0-9-]+$/).max(90),
});
export const codexApiAccount = z.strictObject({ provider: z.literal("openai-api"), account, model: codexModel });
// account_id is the ChatGPT account the Codex sign-in must belong to. Every turn checks the sign-in against it.
export const codexSubscriptionAccount = z.strictObject({
  provider: z.literal("chatgpt-subscription"), model: codexModel,
  account_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});
export const codexAccount = z.discriminatedUnion("provider", [codexApiAccount, codexSubscriptionAccount]);

/** The live member accounts of one worker. Unknown keys are refused, so a provider attestation is not a configuration. */
export const liveProfiles = z.strictObject({
  pi: goAccount.optional(), claude: claudeAccount.optional(), codex: codexAccount.optional(),
}).refine((value) => value.pi || value.claude || value.codex, "Configure at least one engine");
export type LiveProfiles = z.infer<typeof liveProfiles>;
export const liveProfilesVariable = "BIRBCREW_LIVE_PROFILES";

/** Reads the one explicit live setting. Nothing is inferred from other variables. Errors name fields and unknown keys, never a value. */
export function readLiveProfiles(env: NodeJS.ProcessEnv): LiveProfiles {
  const text = env[liveProfilesVariable];
  if (!text?.trim()) {
    throw new Error(`Set ${liveProfilesVariable} to this worker's live member accounts. ` +
      "Provider attestation files and the BIRBCREW_*_ATTESTATION variables are no longer read");
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`${liveProfilesVariable} must be a JSON object`); }
  const parsed = liveProfiles.safeParse(value);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((issue) => {
    const path = issue.path.join(".") || "settings";
    if (issue.code === "unrecognized_keys") return `${path}: unknown ${issue.keys.join(", ")}`;
    // Only this file's own fixed refinement text is printed. Zod's messages can describe the input.
    return `${path}: ${issue.code === "custom" ? issue.message : issue.code}`;
  });
  throw new Error(`Invalid ${liveProfilesVariable} (${problems.join("; ")})`);
}

export function codexSubscriptionHome(env: NodeJS.ProcessEnv) {
  return env.BIRBCREW_CODEX_AUTH_HOME ?? env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function credential(value: string | undefined, variable: string) {
  if (!value?.trim()) throw new Error(`Set ${variable} for the configured account`);
  return value;
}
