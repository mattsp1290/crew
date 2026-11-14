import { createHash } from "node:crypto";
import { applyChild, endChildStep, insertToolResult, type ChildChange, type ObservedChild } from "./child-observation.ts";
import { EventType as E, type Event, type Message } from "@ag-ui/core";
import type { Pool, PoolClient } from "pg";
import { standingChoice, toolChoices } from "./deferral.ts";
import type { ActiveGrant } from "./grants.ts";
import type { Approval, ToolOutcome } from "./approvals.ts";
import { MemberStoreError, type Conversation } from "./domain.ts";

const retainedEvents = 256;
// The per-request call cap, so every granted call of the current request stays listed while the
// snapshot stays bounded. The audit trail keeps every one.
const retainedGrantedCalls = 16;
// One card per request can expire; the last 16 bound the snapshot as granted calls do.
const retainedExpiredCalls = 16;

type PublicApproval = Omit<Approval, "argumentDigest" | "ownerId" | "nativeCallId" | "grantId"> & {
  expiresAt?: string; choices: typeof toolChoices.record_work_item; standingChoices?: typeof standingChoice.options;
};
type PublicQuestion = Omit<PublicApproval, "choices"> & { choices: typeof toolChoices.choose_next_step };
export type Phase = "idle" | "running" | "waiting" | "complete" | "cancelled" | "failed";
interface ClosedCall {
  requestId: string;
  approvalId: string;
  effect: "none" | "committed" | "unknown";
  delivery: "confirmed" | "unknown";
  receiptId?: string;
}
// A call a standing grant approved, which had no card. Per call, so creating or revoking a
// member-wide grant republishes no conversation's snapshot.
type GrantedCall = ActiveGrant & { requestId: string; approvalId: string };
// A card nobody decided before its deadline; Crew cancelled its request (docs/approval-expiry.md).
type ExpiredCall = { requestId: string; approvalId: string; expiresAt: string; expiredAt: string };
type Projection = {
  interruptedCalls?: ClosedCall[];
  grantedCalls?: GrantedCall[];
  expiredCalls?: ExpiredCall[];
  liveOperations?: (Omit<ClosedCall,"effect"> & {effect:"pending" | ClosedCall["effect"]})[];
  conversationId: string;
  memberId: string;
  engine: Conversation["engine"];
  profile: string;
  phase: Phase;
  openStep: string | null;
  children?: ObservedChild[];
  pendingApprovals: PublicApproval[];
  pendingQuestions?: PublicQuestion[];
};

type Change = ChildChange
  | { kind: "nativeItem"; requestId: string; index: number; text: string }
  | { kind: "input"; requestId: string; text: string }
  | ({ kind: "reply"; requestId: string; cancelled?: boolean } & ({ text: string } | { itemCount: number }))
  | { kind: "toolValue"; invocationId: string; publicId: string; requestId: string }
  | { kind: "toolPreview"; invocationId: string; publicId: string }
  // expiresAt marks a Codex live call; deadline is the expiry of a card the workflow waits on.
  | { kind: "call"; approval: Approval; expiresAt?: string; deadline?: string; standing?: true; grant?: ActiveGrant }
  | ({ kind: "liveClosed" } & ClosedCall)
  | ({ kind: "expired" } & ExpiredCall)
  | { kind: "liveDelivered"; requestId: string; approvalId: string }
  | { kind: "answered" | "resume"; approvalId: string }
  | { kind: "cancelled"; requestId: string }
  | { kind: "result"; approvalId: string; outcome: ToolOutcome }
  | { kind: "text"; childId?: string; messageId: string; index: number; delta: string }
  | { kind: "failed" | "stopped"; requestId: string };

type OpenText = { id: string; prefix: string; count: number };

export interface PublicSnapshot {
  cursor: number;
  state: Projection;
  messages: Message[];
  openTools: Record<string, OpenTool>;
  openText: OpenText | null;
  childText: Record<string, OpenText>;
}

type OpenTool = { preamble?: Pick<OpenText,"id"|"prefix">; subagentRunId?:string; invocationId: string; publicId: string; prefix: string };

export function toolBootstrap(tool: OpenTool, includePreamble = true): Event[] {
  const attr = tool.subagentRunId ? {subagentRunId:tool.subagentRunId} : {};
  const frames: Event[] = [];
  if (includePreamble && tool.preamble) {
    const {id:messageId,prefix} = tool.preamble;
    frames.push({type:E.TEXT_MESSAGE_START,messageId,role:"assistant",...attr},
      {type:E.TEXT_MESSAGE_CONTENT,messageId,delta:prefix,...attr},{type:E.TEXT_MESSAGE_END,messageId,...attr});
  }
  return [...frames,
    { ...attr, type: E.TOOL_CALL_START, toolCallId: tool.publicId, toolCallName: "record_work_item", parentMessageId: tool.publicId + "/assistant" },
    { ...attr, type: E.TOOL_CALL_ARGS, toolCallId: tool.publicId, delta: tool.prefix },
  ];
}

type StoredSnapshot = PublicSnapshot & { complete: boolean; turnLimit: number };

const selection = `SELECT c.turn_limit AS "turnLimit", COALESCE(s.open_tools,'{}'::jsonb) AS "openTools", COALESCE(s.child_open_text,'{}'::jsonb) AS "childText", s.open_text AS "openText", COALESCE(s.history_complete, true) AS complete, COALESCE(s.cursor, 0) AS cursor, COALESCE(s.messages, '[]'::jsonb) AS messages,
  COALESCE(s.state, jsonb_build_object('conversationId', c.conversation_id, 'memberId', m.member_id,
  'engine', m.engine, 'profile', m.profile, 'phase', 'idle', 'openStep', NULL, 'pendingApprovals', '[]'::jsonb)) AS state
  FROM birbcrew_ts.conversations c JOIN birbcrew_ts.members m USING (owner_id, member_id)
  LEFT JOIN birbcrew_ts.public_snapshots s USING (conversation_id)`;

export async function readSnapshot(db: Pool, owner: string, id: string): Promise<PublicSnapshot> {
  const { rows: [snapshot] } = await db.query<StoredSnapshot>(selection + " WHERE c.owner_id=$1 AND c.conversation_id=$2", [owner, id]);
  if (!snapshot) throw new MemberStoreError("not_found");
  if (!snapshot.complete) throw new MemberStoreError("history_unavailable");
  return { state: snapshot.state, cursor: snapshot.cursor, messages: snapshot.messages, openText: snapshot.openText, openTools: snapshot.openTools, childText:snapshot.childText };
}

function logicalKey(change: Change) {
  switch (change.kind) {
    case "nativeItem": return change.requestId + "/item/" + change.index;
    case "text": return "text/" + change.messageId + "/" + change.index;
    case "toolValue": return change.kind + "/" + change.publicId;
    case "toolPreview": return "toolPreview/" + change.publicId;
    case "childResumed":
    case "childStarted":
    case "childEnded": return change.kind + "/" + change.childId;
    case "call": return "call/" + change.approval.approvalId;
    case "answered":
    case "resume":
    case "liveClosed":
    case "expired":
    case "liveDelivered":
    case "result": return change.kind + "/" + change.approvalId;
    default: return change.kind + "/" + change.requestId;
  }
}

function apply(snapshot: StoredSnapshot, change: Change): Event[] {
  const { messages, state } = snapshot;
  const frames: Event[] = [];
  function startStep(name: string) {
    state.openStep = name;
    frames.push({ type: E.STEP_STARTED, stepName: name });
  }
  function finishStep() {
    if (state.openStep) frames.push({ type: E.STEP_FINISHED, stepName: state.openStep });
    state.openStep = null;
  }
  function finishText(childId?: string) {
    const text = childId ? snapshot.childText[childId] : snapshot.openText;
    if (text) frames.push({ type: E.TEXT_MESSAGE_END, messageId: text.id, ...(childId && { subagentRunId: childId }) });
    if (childId) delete snapshot.childText[childId];
    else snapshot.openText = null;
    return text;
  }
  function commitPreamble(childId?: string) {
    const text = finishText(childId);
    if (text) messages.push({id:text.id,role:"assistant",content:text.prefix,...(childId && {subagentRunId:childId})});
  }
  switch (change.kind) {
    case "nativeItem": {
      if (!state.openStep || !Number.isSafeInteger(change.index) || change.index < 0 || change.index >= 128 ||
          !change.text || Buffer.byteLength(change.text) > 65_536) throw new MemberStoreError("input_limit");
      const messageId = change.requestId + "/item/" + change.index;
      messages.push({id:messageId,role:"assistant",content:change.text});
      frames.push({type:E.TEXT_MESSAGE_START,messageId,role:"assistant"},
        {type:E.TEXT_MESSAGE_CONTENT,messageId,delta:change.text},{type:E.TEXT_MESSAGE_END,messageId});
      break;
    }
    case "text": {
      const { messageId, childId, index, delta } = change;
      const active = childId ? state.children?.some(c => c.childId === childId && c.phase === "running") : state.openStep;
      if (!active) throw new MemberStoreError("stale");
      const attribution = childId ? { subagentRunId: childId } : {};
      let text = childId ? snapshot.childText[childId] : snapshot.openText;
      if (!text) {
        text = { id: messageId, prefix: "", count: 0 };
        if (childId) snapshot.childText[childId] = text;
        else snapshot.openText = text;
        frames.push({ type: E.TEXT_MESSAGE_START, messageId, role: "assistant", ...attribution });
      }
      if (text.id !== messageId || text.count !== index) throw new MemberStoreError("stale");
      if (text.count >= 1024 || !delta || delta.includes("\0") || !delta.isWellFormed() ||
        Buffer.byteLength(text.prefix) + Buffer.byteLength(delta) > 65_536) throw new MemberStoreError("input_limit");
      text.count++;
      text.prefix += delta;
      frames.push({ type: E.TEXT_MESSAGE_CONTENT, messageId, delta, ...attribution });
      return frames;
    }
    case "delegation":
      commitPreamble();
      frames.push(...applyChild(state.children ??= [], messages, change));
      break;
    case "childResumed":
    case "childStarted":
      frames.push(...applyChild(state.children ??= [], messages, change));
      break;
    case "childEnded": {
      const preview = snapshot.openTools[change.childId];
      if (preview) {
        frames.push({type:E.TOOL_CALL_END,toolCallId:preview.publicId,subagentRunId:change.childId});
        delete snapshot.openTools[change.childId];
      }
      const text = finishText(change.childId);
      if (text && change.outcome === "completed" && text.prefix !== change.text) throw new MemberStoreError("conflict");
      frames.push(...applyChild(state.children ??= [], messages, change, text?.id));
      break;
    }
    case "input":
      messages.push({ id: change.requestId, role: "user", content: change.text });
      state.phase = "running";
      startStep(change.requestId);
      break;
    case "toolValue": {
      const tool = snapshot.openTools[change.invocationId];
      if (tool?.publicId !== change.publicId) throw new MemberStoreError("stale");
      const delta = JSON.stringify(change.requestId);
      tool.prefix += delta;
      return [{ type: E.TOOL_CALL_ARGS, toolCallId: tool.publicId, delta, ...(tool.subagentRunId && {subagentRunId:tool.subagentRunId}) }];
    }
    case "toolPreview": {
      if (!state.openStep || snapshot.openTools[change.invocationId]) throw new MemberStoreError("stale");
      const childId = state.children?.find(c => c.childId === change.invocationId && c.phase === "running")?.childId;
      const preamble = finishText(childId);
      const tool = { ...(preamble && {preamble:{id:preamble.id,prefix:preamble.prefix}}), ...(childId && {subagentRunId:childId}), invocationId: change.invocationId, publicId: change.publicId, prefix: '{"operation_id":' };
      snapshot.openTools[tool.invocationId] = tool;
      frames.push(...toolBootstrap(tool,false));
      return frames;
    }
    case "call": {
      const { memberId, conversationId, requestId, invocationId, approvalId, version, policyVersion,
        toolName, summary } = change.approval;
      commitPreamble(invocationId === requestId ? undefined : invocationId);
      const expiresAt = change.expiresAt ?? change.deadline;
      const card = { ...(expiresAt && {expiresAt}), memberId, conversationId, requestId, invocationId, approvalId, version, policyVersion, toolName, summary };
      if (change.grant) state.grantedCalls = [...state.grantedCalls ?? [], { requestId, approvalId, ...change.grant }].slice(-retainedGrantedCalls);
      else if (toolName === "choose_next_step") (state.pendingQuestions ??= []).push({ ...card, choices: toolChoices.choose_next_step });
      else state.pendingApprovals.push({ ...card, choices: toolChoices.record_work_item,
        ...(change.standing && { standingChoices: standingChoice.options }) });
      if (!change.grant) state.phase = "waiting";
      const attribution = invocationId === requestId ? {} : { subagentRunId: invocationId };
      const args = toolName === "choose_next_step" ? "{}" : JSON.stringify({ operation_id: requestId });
      const messageId = approvalId + "/assistant";
      const preamble = snapshot.openTools[invocationId]?.preamble;
      if (preamble) messages.push({id:preamble.id,role:"assistant",content:preamble.prefix,...attribution});
      messages.push({
        id: messageId, role: "assistant", ...attribution, toolCalls: [
        { id: approvalId, type: "function", function: { name: toolName, arguments: args } },
      ] });
      const preview = snapshot.openTools[invocationId];
      if (preview) {
        if (preview.publicId !== approvalId || !args.startsWith(preview.prefix)) throw new MemberStoreError("conflict");
        frames.push({ type: E.TOOL_CALL_ARGS, toolCallId: approvalId, ...attribution, delta: args.slice(preview.prefix.length) });
        delete snapshot.openTools[invocationId];
      } else {
        frames.push({ type: E.TOOL_CALL_START, toolCallId: approvalId, toolCallName: toolName, parentMessageId: messageId, ...attribution },
          { type: E.TOOL_CALL_ARGS, toolCallId: approvalId, ...attribution, delta: args });
      }
      frames.push({ type: E.TOOL_CALL_END, toolCallId: approvalId, ...attribution });
      if (change.expiresAt) {
        (state.liveOperations ??= []).push({requestId,approvalId,effect:"pending",delivery:"unknown"});
        break;
      }
      if (invocationId === requestId) finishStep();
      else {
        const child = state.children?.find(c => c.childId === invocationId);
        if (child) frames.push(...endChildStep(child));
      }
      break;
    }
    case "liveDelivered": {
      const op = state.liveOperations?.find(o => o.approvalId === change.approvalId);
      if (op) op.delivery = "confirmed";
      break;
    }
    case "liveClosed": {
      const {kind, ...record} = change;
      (state.interruptedCalls ??= []).push(record);
      const operation = state.liveOperations?.find(o => o.approvalId === record.approvalId);
      if (operation) Object.assign(operation,record);
      state.pendingApprovals = state.pendingApprovals.filter(p => p.approvalId !== record.approvalId);
      if (state.pendingQuestions) state.pendingQuestions = state.pendingQuestions.filter(p => p.approvalId !== record.approvalId);
      const content = record.effect === "none"
        ? "The native call was interrupted before any work item was recorded. Submit a new request in a new conversation with this member for fresh approval."
        : record.effect === "committed"
          ? "The work item was recorded. View the existing receipt " + record.receiptId + "."
          : "The effect of this call is uncertain. Wait for reconciliation before requesting another write.";
      const messageId = record.approvalId + "/interrupted";
      messages.push({id:messageId,role:"assistant",content});
      frames.push({type:E.TEXT_MESSAGE_START,role:"assistant",messageId},
        {type:E.TEXT_MESSAGE_CONTENT,messageId,delta:content},{type:E.TEXT_MESSAGE_END,messageId});
      state.phase = "running";
      break;
    }
    case "answered":
      if (state.pendingQuestions) state.pendingQuestions = state.pendingQuestions.filter((p) => p.approvalId !== change.approvalId);
      state.pendingApprovals = state.pendingApprovals.filter((p) => p.approvalId !== change.approvalId);
      state.phase = state.pendingApprovals.length || state.pendingQuestions?.length ? "waiting" : "running";
      break;
    case "cancelled":
      if (state.pendingQuestions) state.pendingQuestions = state.pendingQuestions.filter((p) => p.requestId !== change.requestId);
      state.pendingApprovals = state.pendingApprovals.filter((p) => p.requestId !== change.requestId);
      state.phase = state.pendingApprovals.length || state.pendingQuestions?.length ? "waiting" : "running";
      break;
    case "expired": {
      const { kind, ...call } = change;
      if (state.pendingQuestions) state.pendingQuestions = state.pendingQuestions.filter((p) => p.requestId !== call.requestId);
      state.pendingApprovals = state.pendingApprovals.filter((p) => p.requestId !== call.requestId);
      state.expiredCalls = [...state.expiredCalls ?? [], call].slice(-retainedExpiredCalls);
      state.phase = state.pendingApprovals.length || state.pendingQuestions?.length ? "waiting" : "running";
      break;
    }
    case "resume":
      startStep(change.approvalId + "/continue");
      break;
    case "result": {
      const operation = state.liveOperations?.find(o => o.approvalId === change.approvalId);
      if (operation) {
        operation.effect = change.outcome.kind === "recorded" ? "committed" : "none";
        if (change.outcome.kind === "recorded") operation.receiptId = change.outcome.receipt.receiptId;
      }
      const id = change.approvalId + "/result";
      const content = change.outcome.kind === "answered" ? change.outcome.choice : JSON.stringify(change.outcome.kind === "recorded" ?
        { kind: "recorded", receiptId: change.outcome.receipt.receiptId } : { kind: change.outcome.kind });
      const call = messages.find(m => m.role === "assistant" && m.toolCalls?.some(t => t.id === change.approvalId));
      const attribution = call?.subagentRunId ? { subagentRunId: call.subagentRunId } : {};
      insertToolResult(messages, { id, role: "tool", toolCallId: change.approvalId, content, ...attribution });
      frames.push({ type: E.TOOL_CALL_RESULT, messageId: id, toolCallId: change.approvalId, content, ...attribution });
      break;
    }
    case "reply": {
      if (Object.keys(snapshot.openTools).length) throw new MemberStoreError("conflict");
      const items = messages.filter(m => m.role === "assistant" && m.id.startsWith(change.requestId + "/item/"));
      if ("itemCount" in change || items.length) {
        if ("itemCount" in change ? items.length !== change.itemCount : items.map(m => m.content).join("") !== change.text) {
          throw new MemberStoreError("conflict");
        }
        finishStep();
        state.phase = change.cancelled ? "cancelled" : messages.filter(m => m.role === "user").length >= snapshot.turnLimit ? "complete" : "idle";
        break;
      }
      const initialId = change.requestId + "/assistant";
      const id = snapshot.openText?.id ?? (messages.some(m => m.id === initialId) ? change.requestId + "/resumed-assistant" : initialId);
      if (snapshot.openText) {
        if (snapshot.openText.prefix !== change.text) throw new MemberStoreError("conflict");
        finishText();
      } else {
        frames.push({ type: E.TEXT_MESSAGE_START, messageId: id, role: "assistant" },
          { type: E.TEXT_MESSAGE_CONTENT, messageId: id, delta: change.text }, { type: E.TEXT_MESSAGE_END, messageId: id });
      }
      messages.push({ id, role: "assistant", content: change.text });
      finishStep();
      state.phase = change.cancelled ? "cancelled" : messages.filter((m) => m.role === "user").length >= snapshot.turnLimit ? "complete" : "idle";
      break;
    }
    case "stopped":
    case "failed":
      for (const tool of Object.values(snapshot.openTools)) {
        frames.push({ type: E.TOOL_CALL_END, toolCallId: tool.publicId, ...(tool.subagentRunId && { subagentRunId: tool.subagentRunId }) });
      }
      snapshot.openTools = {};
      finishText();
      for (const child of state.children ?? []) {
        if (child.requestId !== change.requestId || (child.phase !== "ready" && child.phase !== "running")) continue;
        if (child.phase === "running") {
          finishText(child.childId);
          frames.push(...endChildStep(child), { type: E.SUBAGENT_ERROR, subagentRunId: child.childId,
            code: "cleanup_unconfirmed", message: "Child task interrupted" });
        }
        child.phase = "uncertain";
      }
      finishStep();
      state.phase = change.kind === "stopped" ? "cancelled" : "failed";
      state.pendingApprovals = [];
      if (state.pendingQuestions) state.pendingQuestions = [];
      break;
  }
  // A finalized snapshot omits live messages and would remove them from HttpAgent.
  const hasPartialMessage = snapshot.openText || Object.keys(snapshot.childText).length || Object.keys(snapshot.openTools).length;
  if (!hasPartialMessage && change.kind !== "resume" && change.kind !== "answered" && change.kind !== "cancelled"
      && change.kind !== "expired") {
    if ((change.kind === "childEnded" || change.kind === "failed") && state.children?.some(c => c.requestId === change.requestId) &&
      state.children.every(c => c.requestId !== change.requestId || (c.phase !== "ready" && c.phase !== "running"))) {
      // HttpAgent updates existing IDs in place. Drop this delegation’s provisional ordering
      // before replaying its canonical history, now that every sibling stream has closed.
      const delegation = messages.findIndex(m => m.id === change.requestId + "/delegation");
      if (delegation >= 0) frames.push({ type: E.MESSAGES_SNAPSHOT, messages: messages.slice(0, delegation + 1) });
    }
    frames.push({ type: E.MESSAGES_SNAPSHOT, messages });
  }
  frames.push({ type: E.STATE_SNAPSHOT, snapshot: state });
  return frames;
}

// The caller holds the conversation lock in the transaction that committed this change.
export async function publishObservation(db: PoolClient, id: string, change: Change) {
  const { rows: [snapshot] } = await db.query<StoredSnapshot>(selection + " WHERE c.conversation_id=$1 FOR UPDATE OF c", [id]);
  if (!snapshot) throw new MemberStoreError("not_found");
  if (!snapshot.complete || snapshot.state.phase === "failed" || snapshot.state.phase === "cancelled") return;
  await db.query(`INSERT INTO birbcrew_ts.public_snapshots (conversation_id,state) VALUES ($1,$2)
    ON CONFLICT DO NOTHING`, [id, JSON.stringify(snapshot.state)]);
  const key = logicalKey(change);
  const digest = change.kind === "text" ? createHash("sha256").update(change.delta).digest() :
    change.kind === "nativeItem" ? createHash("sha256").update(change.text).digest() : null;
  const admitted = await db.query(`INSERT INTO birbcrew_ts.public_publications (conversation_id,logical_key,payload_digest)
    VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id, key, digest]);
  if (!admitted.rowCount) {
    if (digest) {
      const same = await db.query(`SELECT 1 FROM birbcrew_ts.public_publications
        WHERE conversation_id=$1 AND logical_key=$2 AND payload_digest=$3`, [id, key, digest]);
      if (!same.rowCount) throw new MemberStoreError("conflict");
    }
    return;
  }
  const frames = apply(snapshot, change);
  await db.query(`INSERT INTO birbcrew_ts.public_events (conversation_id,cursor,event)
    SELECT $1,$2::integer+ordinality,value FROM jsonb_array_elements($3) WITH ORDINALITY`,
    [id, snapshot.cursor, JSON.stringify(frames)]);
  const cursor = snapshot.cursor + frames.length;
  if (change.kind === "text" || change.kind === "toolPreview" || change.kind === "toolValue") {
    await db.query("UPDATE birbcrew_ts.public_snapshots SET cursor=$2,open_text=$3,open_tools=$4,child_open_text=$5 WHERE conversation_id=$1",
      [id, cursor, snapshot.openText && JSON.stringify(snapshot.openText), JSON.stringify(snapshot.openTools),JSON.stringify(snapshot.childText)]);
    return;
  }
  await db.query("UPDATE birbcrew_ts.public_snapshots SET cursor=$2,messages=$3,state=$4,open_text=$5,open_tools=$6,child_open_text=$7 WHERE conversation_id=$1",
    [id, cursor, JSON.stringify(snapshot.messages), JSON.stringify(snapshot.state), snapshot.openText && JSON.stringify(snapshot.openText), JSON.stringify(snapshot.openTools),JSON.stringify(snapshot.childText)]);
  await db.query("DELETE FROM birbcrew_ts.public_events WHERE conversation_id=$1 AND cursor<=$2", [id, cursor - retainedEvents]);
}

export async function readEvents(db: Pool, owner: string, id: string, cursor: number) {
  const { rows } = await db.query<{ cursor: number; event: Event }>(
    `SELECT e.cursor,e.event FROM birbcrew_ts.public_events e JOIN birbcrew_ts.conversations c USING (conversation_id)
     WHERE c.owner_id=$1 AND e.conversation_id=$2 AND e.cursor>$3 ORDER BY e.cursor LIMIT 32`, [owner, id, cursor]);
  return rows;
}
