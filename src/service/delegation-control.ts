import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { ChildNativeStopUnconfirmed, ChildStore } from "./children.ts";
import { childEngineSchema, commitSchema, spawnSchema } from "./domain.ts";
import { transaction } from "./transaction.ts";

const revision = z.string().max(19).regex(/^(0|[1-9][0-9]*)$/).refine(value => (value.length < 19 || value <= "9223372036854775807"));
const privateText = (bytes: number) => z.string().min(1).refine(value => value.isWellFormed() && !value.includes("\0") && Buffer.byteLength(value) <= bytes);
export const controlScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("global") }),
  z.strictObject({ kind: z.literal("target"), engine: childEngineSchema, profile: privateText(128) }),
]);
export const controlCommandSchema = z.strictObject({ commandId: z.uuid(), expectedRevision: revision,
  scope: controlScopeSchema, enabled: z.boolean(), actor: privateText(256), reason: privateText(1024) });
export const controlReceiptSchema = z.strictObject({ commandId: z.uuid(), installationId: z.uuid(), instanceId: z.uuid(),
  revision: revision.refine(value => value !== "0"), scope: controlScopeSchema, enabled: z.boolean() });
export const controlStateSchema = z.strictObject({ installationId: z.uuid(), instanceId: z.uuid(),
  recoveryPhase: z.enum(["active", "frozen", "restored"]), revision, globalEnabled: z.boolean(),
  disabledTargets: z.array(controlScopeSchema.options[1]) });
export type ControlCommand = z.infer<typeof controlCommandSchema>;
export type ControlReceipt = z.infer<typeof controlReceiptSchema>;
export type ControlState = z.infer<typeof controlStateSchema>;
export const childExecutionKeySchema = z.strictObject({ ownerId: spawnSchema.shape.ownerId, memberId: z.uuid(),
  conversationId: z.uuid(), requestId: z.uuid(), childId: z.uuid(), workflowRunId: z.string().min(1).nullable() });
export const parentResultKeySchema = childExecutionKeySchema.omit({ childId: true, ownerId: true }).extend({
  resumeActivityId: z.string().min(1).nullable(), reply: z.string().nullable(),
});
export const wakeObservationSchema = z.strictObject({ kind: z.enum(["accepted", "missing", "unavailable"]) });
export const childExecutionObservationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("not_started") }), z.strictObject({ kind: z.literal("missing") }),
  z.strictObject({ kind: z.literal("unavailable") }), z.strictObject({ kind: z.literal("unknown") }),
  z.strictObject({ kind: z.literal("open"), runId: z.string().min(1), status: z.string().min(1) }),
  z.strictObject({ kind: z.literal("closed"), runId: z.string().min(1), status: z.string().min(1) }),
]);
export const parentResultObservationSchema = z.strictObject({ kind: z.enum(["observed", "pending", "missing", "unavailable", "unknown"]) });
export type ChildExecutionKey = z.infer<typeof childExecutionKeySchema>;
export type ParentResultKey = z.infer<typeof parentResultKeySchema>;
export type ChildExecutionObservation = z.infer<typeof childExecutionObservationSchema>;
export type ParentResultObservation = z.infer<typeof parentResultObservationSchema>;
export type WakeObservation = z.infer<typeof wakeObservationSchema>;
export interface ChildWorkflowControl {
  signalDecision(key: ChildExecutionKey): Promise<WakeObservation>;
  observe(key: ChildExecutionKey): Promise<ChildExecutionObservation>;
  observeParentResult(key: SettledParentResult): Promise<ParentResultObservation>;
}
const phaseSchema = z.enum(["ready", "running", "waiting", "resuming", "complete", "failed", "cancelled"]);
const childSnapshotSchema = childExecutionKeySchema.extend({ retire: z.boolean(), phase: phaseSchema, terminal: z.boolean(),
  target: controlScopeSchema.options[1].nullable(), approvalId: z.uuid().nullable(), cardClosed: z.boolean() });
const parentSnapshotSchema = parentResultKeySchema.extend({ phase: z.string(), unstoppedLaunches: z.array(z.uuid()) });
const parentEvidenceSnapshotSchema = parentSnapshotSchema.extend({ observed: z.boolean(), parentCommitted: z.boolean() });
const parentPositionSchema = parentResultKeySchema.pick({ conversationId: true, requestId: true });
type ParentPosition = z.infer<typeof parentPositionSchema>;
const parentDiscoverySchema = parentResultKeySchema.extend({ phase: z.string(), observed: z.boolean(),
  installationId: z.uuid(), instanceId: z.uuid(), recoveryPhase: controlStateSchema.shape.recoveryPhase });
export const settledParentResultSchema = parentResultKeySchema.extend({
  workflowRunId: parentResultKeySchema.shape.workflowRunId.unwrap(),
  resumeActivityId: parentResultKeySchema.shape.resumeActivityId.unwrap(), reply: commitSchema.shape.reply,
});
export type SettledParentResult = z.infer<typeof settledParentResultSchema>;
const siblingSchema = childExecutionKeySchema.omit({ workflowRunId: true }).extend({ phase: phaseSchema,
  target: controlScopeSchema.options[1].nullable(), approvalId: z.uuid().nullable() });
export const drainBlockerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("control_changed") }), z.strictObject({ kind: z.literal("admission_open") }),
  z.strictObject({ kind: z.literal("child_pending"), childId: z.uuid(), phase: phaseSchema }),
  z.strictObject({ kind: z.literal("target_unreadable"), childId: z.uuid() }),
  z.strictObject({ kind: z.literal("card_open"), childId: z.uuid(), approvalId: z.uuid() }),
  z.strictObject({ kind: z.literal("child_workflow"), childId: z.uuid(), observation: childExecutionObservationSchema }),
  z.strictObject({ kind: z.literal("parent_pending"), requestId: z.uuid(), phase: z.string() }),
  z.strictObject({ kind: z.literal("native_unconfirmed"), requestId: z.uuid(), tokens: z.array(z.uuid()).min(1) }),
  z.strictObject({ kind: z.literal("parent_workflow"), requestId: z.uuid(), observation: parentResultObservationSchema }),
  z.strictObject({ kind: z.literal("sibling_pending"), sibling: siblingSchema }),
]);
export const drainObservationSchema = z.strictObject({ kind: z.literal("observed_snapshot"), receipt: controlReceiptSchema,
  startedAt: z.iso.datetime(), completedAt: z.iso.datetime(), initial: controlStateSchema, current: controlStateSchema,
  valid: z.boolean(), admissionClosed: z.boolean(), complete: z.boolean(), blockers: z.array(drainBlockerSchema),
  children: z.array(childSnapshotSchema.extend({ workflow: childExecutionObservationSchema })),
  parents: z.array(parentSnapshotSchema.omit({ reply: true }).extend({ workflow: parentResultObservationSchema })),
  siblings: z.array(siblingSchema),
});
export const flushResultSchema = z.strictObject({ examined: z.number().int().nonnegative(),
  children: z.array(z.discriminatedUnion("settlement", [
    z.strictObject({ childId: z.uuid(), settlement: z.literal("pending"), wake: z.strictObject({ kind: z.literal("deferred") }) }),
    z.strictObject({ childId: z.uuid(), settlement: z.literal("settled"), wake: wakeObservationSchema }),
  ])) });
export type DrainObservation = z.infer<typeof drainObservationSchema>;
export type FlushResult = z.infer<typeof flushResultSchema>;
type DrainBlocker = z.infer<typeof drainBlockerSchema>;
type ParentEvidence = z.infer<typeof parentEvidenceSnapshotSchema>;

const nil = "00000000-0000-0000-0000-000000000000";
const nilPosition: ParentPosition = { conversationId: nil, requestId: nil };
export const reconciliationPage = 4;
export const controlPoolBounds = { connectionTimeoutMillis: 5000, statement_timeout: 10_000, query_timeout: 12_000 } as const;
const controlWrite = ["BEGIN", "SET LOCAL lock_timeout='5s'", "SET LOCAL statement_timeout='10s'"] as const;
const drainRead = ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "SET LOCAL statement_timeout='10s'"] as const;

export async function changeDelegationControl(db: PoolClient, command: ControlCommand): Promise<ControlReceipt> {
  const { rows: [row] } = await db.query<{ receipt: unknown }>(
    "SELECT birbcrew_ts.change_delegation_control($1,$2,$3,$4,$5,$6) AS receipt",
    [command.commandId, command.expectedRevision, JSON.stringify(command.scope), command.enabled, command.actor, command.reason]);
  return controlReceiptSchema.parse(row?.receipt);
}
export async function changeControl(pool: Pool, input: unknown): Promise<ControlReceipt> {
  const command = controlCommandSchema.parse(input);
  return transaction(pool, controlWrite, db => changeDelegationControl(db, command));
}
export async function controlState(db: Pool | PoolClient): Promise<ControlState> {
  const { rows: [row] } = await db.query(`SELECT r.installation_id AS "installationId",r.instance_id AS "instanceId",
    r.phase AS "recoveryPhase",d.revision::text AS revision,d.global_enabled AS "globalEnabled",d.disabled_targets AS "disabledTargets"
    FROM birbcrew_ts.delegation_control d CROSS JOIN birbcrew_ts.recovery_control r WHERE d.singleton AND r.singleton`);
  return controlStateSchema.parse(row);
}
function sameControl(left: ControlState, right: ControlState) {
  return left.installationId === right.installationId && left.instanceId === right.instanceId && left.revision === right.revision
    && left.recoveryPhase === right.recoveryPhase;
}
function closed(state: ControlState, receipt: ControlReceipt) {
  return !receipt.enabled && (!state.globalEnabled || receipt.scope.kind === "target" && state.disabledTargets.some(target =>
    receipt.scope.kind === "target" && target.engine === receipt.scope.engine && target.profile === receipt.scope.profile));
}
function unsettledParent(key: ParentResultKey): ParentResultObservation | undefined {
  if (key.workflowRunId === null) return { kind: "missing" };
  if (key.resumeActivityId === null || key.reply === null) return { kind: "pending" };
}

export class DelegationReconciler {
  private readonly pool: Pool;
  private readonly workflows: ChildWorkflowControl;
  private readonly children: ChildStore;
  private parentCursor: ParentPosition = nilPosition;
  private childCursor: string = nil;
  private flushing: Promise<FlushResult> | undefined;
  constructor({ pool, workflows }: { pool: Pool; workflows: ChildWorkflowControl }) {
    this.pool = pool; this.workflows = workflows; this.children = new ChildStore(pool);
  }
  flush(): Promise<FlushResult> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushPass().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }
  private async flushPass(): Promise<FlushResult> {
    const [children, parents] = await Promise.allSettled([this.reconcileChildren(), this.reconcileParents()]);
    if (children.status === "rejected" || parents.status === "rejected") {
      const errors: unknown[] = [children, parents].flatMap(result => result.status === "rejected" ? [result.reason] : []);
      throw new AggregateError(errors, "Delegation control reconciliation failed");
    }
    return children.value;
  }
  private async reconcileChildren(): Promise<FlushResult> {
    const { rows } = await this.pool.query(`SELECT c.owner_id AS "ownerId",c.member_id AS "memberId",
      j.conversation_id AS "conversationId",j.request_id AS "requestId",j.child_id AS "childId",j.workflow_run_id AS "workflowRunId"
      FROM birbcrew_ts.pi_children j JOIN birbcrew_ts.conversations c USING(conversation_id)
      JOIN birbcrew_ts.delegation_settlement s USING(conversation_id,request_id)
      WHERE EXISTS(SELECT 1 FROM birbcrew_ts.delegation_control_children m WHERE m.child_id=j.child_id AND m.retire)
        AND (j.outcome IS NULL OR NOT s.parent_committed OR s.native_unconfirmed)
      ORDER BY (j.child_id>$1::uuid) DESC,j.child_id LIMIT $2::int`, [this.childCursor, reconciliationPage]);
    const result: FlushResult = { examined: rows.length, children: [] };
    const errors: unknown[] = [];
    for (const row of rows) {
      const key = childExecutionKeySchema.parse(row);
      this.childCursor = key.childId;
      try {
        try { await this.children.closeExitedChild(key, false); }
        catch (error) {
          if (!(error instanceof ChildNativeStopUnconfirmed)) throw error;
          result.children.push({ childId: key.childId, settlement: "pending", wake: { kind: "deferred" } });
          continue;
        }
        const wake = wakeObservationSchema.parse(await this.workflows.signalDecision(key));
        result.children.push({ childId: key.childId, settlement: "settled", wake });
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Delegation child reconciliation failed");
    return flushResultSchema.parse(result);
  }
  private async reconcileParents(): Promise<void> {
    const { rows } = await this.pool.query(`WITH forward AS MATERIALIZED (
      SELECT conversation_id,request_id FROM birbcrew_ts.delegations
      WHERE (conversation_id,request_id)>($1::uuid,$2::uuid)
      ORDER BY conversation_id,request_id LIMIT $3::int
    ), page AS MATERIALIZED (
      SELECT conversation_id,request_id,0 AS segment FROM forward
      UNION ALL (SELECT conversation_id,request_id,1 AS segment FROM birbcrew_ts.delegations
        WHERE (conversation_id,request_id)<=($1::uuid,$2::uuid)
        ORDER BY conversation_id,request_id LIMIT (SELECT $3::int-count(*) FROM forward))
    ) SELECT c.member_id AS "memberId",p.conversation_id AS "conversationId",p.request_id AS "requestId",
      t.workflow_run_id AS "workflowRunId",d.resume_activity_id AS "resumeActivityId",t.reply,t.phase,
      r.installation_id AS "installationId",r.instance_id AS "instanceId",r.phase AS "recoveryPhase",
      birbcrew_ts.delegation_parent_result_observed(p.conversation_id,p.request_id) AS observed
      FROM page p JOIN birbcrew_ts.delegations d USING(conversation_id,request_id)
      JOIN birbcrew_ts.turns t USING(conversation_id,request_id) JOIN birbcrew_ts.conversations c USING(conversation_id)
      CROSS JOIN birbcrew_ts.recovery_control r WHERE r.singleton
      ORDER BY p.segment,p.conversation_id,p.request_id`,
    [this.parentCursor.conversationId, this.parentCursor.requestId, reconciliationPage]);
    const last = rows.at(-1);
    this.parentCursor = last === undefined ? nilPosition : parentPositionSchema.parse({
      conversationId: last.conversationId, requestId: last.requestId,
    });
    const errors: unknown[] = [];
    for (const row of rows) {
      try {
        const parent = parentDiscoverySchema.parse(row);
        if (parent.observed || parent.recoveryPhase !== "active" || parent.phase !== "committed"
          || parent.workflowRunId === null || parent.resumeActivityId === null || parent.reply === null) continue;
        const result = settledParentResultSchema.parse({ memberId: parent.memberId, conversationId: parent.conversationId,
          requestId: parent.requestId, workflowRunId: parent.workflowRunId, resumeActivityId: parent.resumeActivityId, reply: parent.reply });
        const observation = parentResultObservationSchema.parse(await this.workflows.observeParentResult(result));
        if (observation.kind === "unavailable") throw new Error("Delegation parent observation unavailable");
        if (observation.kind !== "observed") continue;
        await this.pool.query("SELECT birbcrew_ts.record_delegation_parent_observation($1,$2,$3,$4,$5,$6,$7)",
          [parent.installationId, parent.instanceId, result.conversationId, result.requestId,
            result.workflowRunId, result.resumeActivityId, result.reply]);
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Delegation parent reconciliation failed");
  }
}

async function readDrainSnapshot(db: PoolClient, commandId: string) {
  const initial = await controlState(db);
  const { rows: [command] } = await db.query<{ receipt: unknown }>(
    "SELECT receipt FROM birbcrew_ts.delegation_control_changes WHERE command_id=$1", [commandId]);
  const receipt = controlReceiptSchema.parse(command?.receipt);
  const children = z.array(childSnapshotSchema).parse((await db.query(`SELECT c.owner_id AS "ownerId",c.member_id AS "memberId",
    j.conversation_id AS "conversationId",j.request_id AS "requestId",j.child_id AS "childId",j.workflow_run_id AS "workflowRunId",
    m.retire,j.phase,j.outcome IS NOT NULL AS terminal,birbcrew_ts.delegation_child_scope(j.conversation_id,j.role_profile) AS target,
    j.approval_id AS "approvalId",(j.approval_id IS NULL OR EXISTS(SELECT 1 FROM birbcrew_ts.public_publications o
      WHERE o.conversation_id=j.conversation_id AND o.logical_key='result/'||j.approval_id::text)) AS "cardClosed"
    FROM birbcrew_ts.delegation_control_children m JOIN birbcrew_ts.pi_children j USING(child_id)
    JOIN birbcrew_ts.conversations c USING(conversation_id) WHERE m.command_id=$1 ORDER BY j.child_id`, [commandId])).rows);
  const parents = z.array(parentEvidenceSnapshotSchema).parse((await db.query(`SELECT DISTINCT c.member_id AS "memberId",
    j.conversation_id AS "conversationId",j.request_id AS "requestId",s.workflow_run_id AS "workflowRunId",
    s.resume_activity_id AS "resumeActivityId",s.reply,s.phase,s.parent_committed AS "parentCommitted",
    birbcrew_ts.delegation_parent_result_observed(j.conversation_id,j.request_id) AS observed,
    ARRAY(SELECT n.token FROM birbcrew_ts.native_launches n WHERE (n.conversation_id,n.request_id)=(j.conversation_id,j.request_id)
      AND NOT n.stopped ORDER BY n.token) AS "unstoppedLaunches"
    FROM birbcrew_ts.delegation_control_children m JOIN birbcrew_ts.pi_children j USING(child_id)
    JOIN birbcrew_ts.conversations c USING(conversation_id) JOIN birbcrew_ts.delegation_settlement s USING(conversation_id,request_id)
    WHERE m.command_id=$1 ORDER BY "requestId"`, [commandId])).rows);
  const siblings = z.array(siblingSchema).parse((await db.query(`SELECT c.owner_id AS "ownerId",c.member_id AS "memberId",
    j.conversation_id AS "conversationId",j.request_id AS "requestId",j.child_id AS "childId",j.phase,
    birbcrew_ts.delegation_child_scope(j.conversation_id,j.role_profile) AS target,j.approval_id AS "approvalId"
    FROM birbcrew_ts.pi_children j JOIN birbcrew_ts.conversations c USING(conversation_id)
    WHERE j.outcome IS NULL AND EXISTS(SELECT 1 FROM birbcrew_ts.delegation_control_children m
      JOIN birbcrew_ts.pi_children selected USING(child_id) WHERE m.command_id=$1
      AND (selected.conversation_id,selected.request_id)=(j.conversation_id,j.request_id))
    AND NOT EXISTS(SELECT 1 FROM birbcrew_ts.delegation_control_children m WHERE m.command_id=$1 AND m.child_id=j.child_id)
    ORDER BY j.child_id`, [commandId])).rows);
  return { initial, receipt, children, parents, siblings };
}
async function observeChild(workflows: ChildWorkflowControl, child: z.infer<typeof childSnapshotSchema>): Promise<ChildExecutionObservation> {
  try {
    return childExecutionObservationSchema.parse(await workflows.observe(childExecutionKeySchema.parse({
      ownerId: child.ownerId, memberId: child.memberId, conversationId: child.conversationId,
      requestId: child.requestId, childId: child.childId, workflowRunId: child.workflowRunId,
    })));
  } catch { return { kind: "unavailable" }; }
}
async function observeParent(workflows: ChildWorkflowControl, parent: ParentEvidence): Promise<ParentResultObservation> {
  if (parent.observed) return { kind: "observed" };
  const unsettled = unsettledParent(parent);
  if (unsettled) return unsettled;
  try {
    return parentResultObservationSchema.parse(await workflows.observeParentResult(settledParentResultSchema.parse({
      memberId: parent.memberId, conversationId: parent.conversationId, requestId: parent.requestId,
      workflowRunId: parent.workflowRunId, resumeActivityId: parent.resumeActivityId, reply: parent.reply,
    })));
  } catch { return { kind: "unavailable" }; }
}
function childBlockers(child: DrainObservation["children"][number]): DrainBlocker[] {
  const blockers: DrainBlocker[] = [];
  if (!child.terminal) blockers.push({ kind: "child_pending", childId: child.childId, phase: child.phase });
  if (!child.target) blockers.push({ kind: "target_unreadable", childId: child.childId });
  if (child.retire && !child.cardClosed && child.approvalId) blockers.push({ kind: "card_open", childId: child.childId, approvalId: child.approvalId });
  if (child.workflow.kind !== "closed") blockers.push({ kind: "child_workflow", childId: child.childId, observation: child.workflow });
  return blockers;
}
function parentBlockers(parent: ParentEvidence, workflow: ParentResultObservation): DrainBlocker[] {
  const blockers: DrainBlocker[] = [];
  if (!parent.parentCommitted) blockers.push({ kind: "parent_pending", requestId: parent.requestId, phase: parent.phase });
  if (parent.unstoppedLaunches.length) blockers.push({ kind: "native_unconfirmed", requestId: parent.requestId, tokens: parent.unstoppedLaunches });
  if (workflow.kind !== "observed") blockers.push({ kind: "parent_workflow", requestId: parent.requestId, observation: workflow });
  return blockers;
}

export async function drainDelegation({ pool, workflows }: { pool: Pool; workflows: ChildWorkflowControl },
  rawCommandId: string): Promise<DrainObservation> {
  const commandId = z.uuid().parse(rawCommandId);
  const startedAt = new Date().toISOString();
  const snapshot = await transaction(pool, drainRead, db => readDrainSnapshot(db, commandId));
  const children: DrainObservation["children"] = [];
  for (const child of snapshot.children) children.push({ ...child, workflow: await observeChild(workflows, child) });
  const parents: { parent: ParentEvidence; workflow: ParentResultObservation }[] = [];
  for (const parent of snapshot.parents) parents.push({ parent, workflow: await observeParent(workflows, parent) });
  const current = await controlState(pool);
  const { initial, receipt } = snapshot;
  const valid = sameControl(initial, current) && receipt.installationId === current.installationId
    && receipt.instanceId === current.instanceId && receipt.revision === current.revision && current.recoveryPhase === "active";
  const admissionClosed = valid && closed(current, receipt);
  const blockers: DrainBlocker[] = [...children.flatMap(childBlockers),
    ...parents.flatMap(({ parent, workflow }) => parentBlockers(parent, workflow)),
    ...snapshot.siblings.map((sibling): DrainBlocker => ({ kind: "sibling_pending", sibling }))];
  if (!valid) blockers.push({ kind: "control_changed" });
  if (!admissionClosed) blockers.push({ kind: "admission_open" });
  return drainObservationSchema.parse({ kind: "observed_snapshot", receipt, initial, current, startedAt,
    completedAt: new Date().toISOString(), valid, admissionClosed, complete: blockers.length === 0, blockers, children,
    parents: parents.map(({ parent: { reply, observed, parentCommitted, ...diagnostic }, workflow }) => ({ ...diagnostic, workflow })),
    siblings: snapshot.siblings });
}
