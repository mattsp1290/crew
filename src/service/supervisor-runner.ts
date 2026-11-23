import type { TextVolumeLocation } from "./text-state-location.ts";
import { codexItemWriter } from "./codex-items.ts";
import { nativeCallIds } from "./text-stream.ts";
import { MemberStore } from "./store.ts";
import { runLiveTool } from "./codex-live.ts";
import { conversationContext } from "./memories.ts";
import { flushTelemetry, observedAgent, traced, turnFlushBudgetMs } from "./telemetry.ts";
import { verifyChildConfiguration } from "./supervisor-child.ts";
import { withNativeAdmission } from "./native-admission.ts";
import type { Launch } from "./supervisor.ts";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { registerProfiles } from "./deployment.ts";
import { memberProfiles } from "./profiles.ts";
import type { DriverInput } from "./activities.ts";
import { isTextEngine, type Conversation, type Checkpoint, type Engine } from "./domain.ts";
import { scrubTextEngineEnvironment } from "./text-turn.ts";
import { temporalSettings } from "./temporal-config.ts";
import { usageAttributes } from "./usage-capture.ts";
import { errorSummary, forwardWarnings, warn } from "./diagnostics.ts";

const telemetryProvider: Partial<Record<Engine, string>> = {
  codex: "openai", claude: "anthropic", cursor: "cursor", opencode: "opencode",
};

interface AdmittedTurn {
  textVolume?: TextVolumeLocation;
  launch: Launch;
  conversation: Conversation;
  runId: string;
  threadId: string;
  childProfile?: DriverInput["childProfile"];
  childResults?: DriverInput["childResults"];
  text: string;
  checkpoint: Checkpoint | null;
  continuation?: DriverInput["continuation"];
}

const controller = new AbortController();
// This process has no stderr. The supervisor host writes what it is sent.
forwardWarnings((line) => { if (process.connected) process.send?.({ warning: line }); });
process.once("disconnect", () => process.exit(1));
process.on("message", (message) => {
  if (message === "stop") controller.abort();
});
process.once("message", async (command: AdmittedTurn) => {
  const [configPath, stateDir] = process.argv.slice(2);
  const pool = new Pool({ connectionString: process.env.BIRBCREW_DATABASE_URL });
  let reply;
  try {
    // The worker validated this same inherited environment before forking the supervisor.
    const temporal = temporalSettings(process.env);
    const { profiles, close } = await import(pathToFileURL(configPath).href);
    try {
      const member = command.conversation;
      if (isTextEngine(member.engine) && command.textVolume?.engine !== member.engine) throw new Error("Missing pinned text volume");
      await registerProfiles(pool, profiles, stateDir, command.textVolume);
      const driver = memberProfiles(profiles, stateDir, process.pid, command.textVolume).get(member.profile)?.[member.engine];
      if (!driver) throw new Error("Unsupported member profile");
      // Read at every launch, outside workflow code. Claude and Codex reuse what their native session recorded on its first turn.
      const projectContext = command.launch.childId ? undefined : await conversationContext(pool, member);
      const profile = profiles.get(member.profile);
      const tool = profile?.protectedTool ?? profile?.humanTool;
      const store = new MemberStore(pool);
      reply = await withNativeAdmission(pool,command.launch,AbortSignal.any([controller.signal,AbortSignal.timeout(170_000)]), async (signal, db) => {
        await verifyChildConfiguration(db, command.launch, profiles, member, command.childProfile);
        const items = member.engine === "codex" ? codexItemWriter(await nativeCallIds(pool,member.conversationId), !!tool,
          (index,text,receipt) => store.appendCodexItem(command.launch,index,text,receipt)) : undefined;
        const input: DriverInput = {
          ...(projectContext && { projectContext }),
          ...(command.childProfile && {childProfile: command.childProfile}),
          ...(command.childResults && {childResults: command.childResults}),
          threadId: command.threadId, runId: command.runId, text: command.text,
          onToolArgs: (toolArgs, matchedOperation) => process.send?.({ toolArgs, matchedOperation }),
          onText: items?.append ?? (delta => { process.send?.({ delta }); }),
          checkpoint: command.checkpoint, continuation: command.continuation, signal,
        };
        const scope = {...command.launch, engine:member.engine, workflowRunId:command.launch.execution.workflowRunId};
        const provider = telemetryProvider[member.engine] ?? profile?.pi?.model.provider ?? "";
        const invokeDriver = (value: DriverInput) => observedAgent({ ...scope, provider }, () => {
          // The owning scrub for every text driver. Cursor scrubs again before its SDK import as defense in depth.
          if (isTextEngine(member.engine)) scrubTextEngineEnvironment();
          return driver(value, member);
        });
        const invoke = () => traced("model.invoke",scope, async () => {
          const result = items && tool
            ? await runLiveTool(pool, temporal, command.launch, member, tool, input, invokeDriver, items.disclose)
            : await invokeDriver(input);
          await items?.finish();
          return result;
        }, result => usageAttributes(result.usage));
        return traced("workflow.segment",scope, () => command.checkpoint ? traced("native.restore",scope,invoke) : invoke());
      });
    } finally {
      await close?.();
    }
  } catch (error) {
    warn("native_turn_failed", { conversationId: command?.launch?.conversationId, requestId: command?.launch?.requestId, ...errorSummary(error) });
    reply = { error: "Native SDK turn failed" };
  } finally {
    // Batched spans would be lost at process.exit below. A failing pool.end() still crashes the runner
    // without a reply, as before, but only after the flush has had its chance.
    const [ended] = await Promise.allSettled([pool.end(), flushTelemetry(turnFlushBudgetMs)]);
    if (ended.status === "rejected") throw ended.reason;
  }
  if (process.connected) process.send?.(reply, () => process.exit(0));
});
