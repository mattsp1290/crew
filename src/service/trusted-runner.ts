/** Call only from a trusted backend worker, never with observer-supplied authority. */
import { TrustedContextStore, type TrustedKey } from "./trusted-context.ts";
import { runTrustedNativeTurn, type TrustedNativeProfile } from "./trusted-native.ts";
import { recordTrustedUsage } from "./usage.ts";
import { checkedPrices, operatorPrices, type PriceTable } from "./usage-prices.ts";

/** One durable queue head. Poll again after null or a busy/rotation response.
 * No context, prompts, native state or results need to enter Temporal history:
 * a Temporal activity wrapper should accept only key and return only request ID.
 * Text is buffered privately until commit rechecks generation and authorization.
 * The request's usage is metered, priced from BIRBCREW_USAGE_PRICES_PATH unless
 * `prices` is given, before its reply commits. A malformed table throws here, before
 * the request is claimed: never after its tools have run.
 */
export async function runTrustedRequest(store: TrustedContextStore, key: TrustedKey, profile: TrustedNativeProfile, signal: AbortSignal,
  prices: PriceTable | null = operatorPrices()) {
  const table = checkedPrices(prices);
  const start = await store.begin(key);
  if (!start) return null;
  if (profile.engine !== start.engine || (profile.engine !== "pi" &&
      (profile.profile.ownerId !== key.ownerId || profile.profile.memberId !== start.memberId))) {
    throw new Error("Trusted native profile ownership does not match the conversation");
  }
  await store.admitted(start.claim, signal, async admitted => {
    const result = await runTrustedNativeTurn({
      engine:start.engine,threadId:start.threadId,runId:start.claim.requestId,text:start.text,
      context:start.context,binding:start.binding,checkpoint:start.checkpoint,signal:admitted,
      tools:store.manifest.map(({kind:_,...tool}) => tool),
      dispatch:call => store.dispatch(start.claim,call.nativeCallId,call.toolName,call.args,call.signal),
      onToolDelivered:call => store.acknowledge(start.claim,call.nativeCallId,call.toolName),
    },profile);
    admitted.throwIfAborted();
    // Before the reply commits, as the member lane's supervisor does: the model work happened even
    // if a rotation makes the commit stale. Counts and a model only; no content enters the ledger.
    await recordTrustedUsage(store.pool,start.claim,result.usage,table);
    await store.commit(start.claim,result.text,result.checkpoint);
  });
  return {requestId:start.claim.requestId};
}
