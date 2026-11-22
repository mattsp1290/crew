import { z } from "zod";

/** Shared validation source for the portable client and the Crew server. */
export const engineSchema = z.enum(["pi", "claude", "codex", "cursor", "opencode"]);
/** Child destinations and delegation targets stay on the original three engines. */
export const childEngineSchema = z.enum(["pi", "claude", "codex"]);
export function boundedText(bytes: number) {
  return z
    .string()
    .min(1)
    .refine(
      (text) =>
        !text.includes("\0") &&
        text.isWellFormed() &&
        new TextEncoder().encode(text).length <= bytes,
      { message: `Expected valid UTF-8 text of at most ${bytes} bytes` },
    )
    .meta({
      "x-maxUtf8Bytes": bytes,
      "x-forbidden": "NUL; unpaired surrogates",
    });
}
const disallowedControl = /(?![\t\n])\p{Cc}/u;
/** Owner-authored model context in memories, member instructions and instruction packs. */
export function ownerText(bytes: number) {
  return z
    .string()
    .min(1)
    .refine(
      (text) =>
        text.isWellFormed() &&
        !disallowedControl.test(text) &&
        new TextEncoder().encode(text).length <= bytes,
      {
        message: `Expected well-formed UTF-8 text of at most ${bytes} bytes without control characters other than tab and newline`,
      },
    )
    .meta({
      "x-maxUtf8Bytes": bytes,
      "x-controlCharacters": "Only tab and newline allowed",
    });
}
export const uuid = z.uuid().overwrite((value) => value.toLowerCase());
/** Must match the body CHECK in src/service/sql/029-member-instructions.sql. */
export const instructionsBytes = 16_384;
/** Owner, CLI and routine prompt bound. Reserved handoff requests use the server turnTextBytes bound. */
export const promptBytes = 16_384;
/** Must match the position CHECK in src/service/sql/033-instruction-packs.sql. */
export const instructionPacksPerMember = 8;
const instructionPackIds = z
  .array(uuid)
  .min(1)
  .max(instructionPacksPerMember)
  .refine((ids) => new Set(ids).size === ids.length)
  .meta({
    uniqueItems: true,
    description: "Instruction pack UUIDs in model reading order, each once.",
  });
/** Must match src/service/sql/028-approval-expiry.sql. Omission leaves cards without this deadline. */
export const approvalDeadline = {
  minimumSeconds: 60,
  maximumSeconds: 604_800,
} as const;
export const approvalDeadlineSeconds = z
  .int()
  .min(approvalDeadline.minimumSeconds)
  .max(approvalDeadline.maximumSeconds);
export const createMemberSchema = z.strictObject({
  requestId: uuid,
  engine: engineSchema,
  profile: boundedText(128),
  instructions: ownerText(instructionsBytes).optional(),
  instructionPacks: instructionPackIds.optional(),
});
export const conversationIdentitySchema = z.strictObject({
  conversationId: uuid,
});
export const openConversationSchema = conversationIdentitySchema.extend({
  memberId: uuid,
});
export const requestIdentitySchema = conversationIdentitySchema.extend({
  requestId: uuid,
});
export const createHandoffBodySchema = z.strictObject({
  requestId: uuid,
  memberId: uuid,
});
export const createHandoffSchema = createHandoffBodySchema.extend({
  conversationId: uuid,
});
const handoffEndpointSchema = z.object({
  conversationId: uuid,
  memberId: uuid,
  engine: engineSchema,
});
export const handoffRecordSchema = z.object({
  handoffId: uuid,
  requestId: uuid,
  source: handoffEndpointSchema,
  target: handoffEndpointSchema,
  firstRequestId: uuid,
  firstRequestAdmitted: z.boolean(),
  carriedTurns: z.int().min(1).max(128),
  omittedTurns: z.int().min(0).max(127),
  uncertainTurns: z.int().min(0).max(128),
  transcriptBytes: z.int().min(1).max(65_536),
  transcriptDigest: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.iso.datetime(),
}).refine((record) => record.source.conversationId !== record.target.conversationId, {
  message: "Handoff source and target conversations must differ",
}).refine((record) => record.carriedTurns + record.omittedTurns + record.uncertainTurns <= 128, {
  message: "Handoff turn counts must total at most 128",
}).meta({
  description: "Source and target conversations must differ. The sum of carriedTurns, omittedTurns and uncertainTurns must be at most 128.",
});
export const createHandoffResponseSchema = handoffRecordSchema.safeExtend({
  apiVersion: z.literal("1"),
});
export const conversationHandoffSchema = z.object({
  apiVersion: z.literal("1"),
  conversationId: uuid,
  incoming: handoffRecordSchema.nullable(),
  outgoing: handoffRecordSchema.nullable(),
}).refine((chain) => chain.incoming !== null || chain.outgoing !== null, {
  message: "A handoff read must contain an incoming or outgoing record",
}).refine((chain) => (chain.incoming === null || chain.incoming.target.conversationId === chain.conversationId)
  && (chain.outgoing === null || chain.outgoing.source.conversationId === chain.conversationId), {
  message: "Handoff directions must match the envelope conversation",
}).meta({
  description: "At least one of incoming and outgoing is non-null. Incoming targets and outgoing sources must match conversationId.",
});
export const submitRequestSchema = requestIdentitySchema.extend({
  text: boundedText(promptBytes),
  approvalDeadlineSeconds: approvalDeadlineSeconds.optional(),
});
/** New accepted kinds require a case in server initiatorColumns and migrations widening
 * request_admissions_initiator_kind_check and audit_events_initiator_check. Owner has no id.
 * Routine and handoff ids are authorized by their reserved server rows, never by caller input. */
export const requestInitiator = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("owner") }),
  z.strictObject({ kind: z.literal("routine"), id: z.uuid() }),
  z.strictObject({ kind: z.literal("handoff"), id: z.uuid() }),
]);
export const nextStep = z.enum(["inspect", "test"]);
/** Offered only in standingChoices, never in the ordinary card choices array. */
export const standingChoice = z.enum(["allow_conversation", "allow_always"]);
export const decisionChoice = z.enum([
  "approve",
  "deny",
  ...nextStep.options,
  ...standingChoice.options,
]);
export const decideSchema = requestIdentitySchema.extend({
  memberId: uuid,
  invocationId: uuid,
  approvalId: uuid,
  version: z.int(),
  choice: decisionChoice,
  decisionId: uuid.optional(),
});
/** Complete proposal arguments. An absent note and an empty note remain distinct. */
export const recordWorkItemArgumentsSchema = z.strictObject({
  operation_id: uuid,
  note: z.string().refine(
    (text) => text.isWellFormed() && !text.includes("\0") && new TextEncoder().encode(text).length <= 4096,
    { message: "Expected valid UTF-8 text of at most 4096 bytes" },
  ).meta({ "x-maxUtf8Bytes": 4096, "x-forbidden": "NUL; unpaired surrogates" }).optional(),
});
export const approvalDetailIdentitySchema = decideSchema.omit({ choice: true, decisionId: true });
export const approvalDetailQuerySchema = approvalDetailIdentitySchema.pick({
  memberId: true, invocationId: true, version: true,
});
/** Immutable proposal material, without a claim about current actionability. */
export const ownerApprovalDetailSchema = approvalDetailIdentitySchema.extend({
  apiVersion: z.literal("1"),
  version: z.literal(1),
  policyVersion: z.literal(1),
  toolName: z.literal("record_work_item"),
  arguments: recordWorkItemArgumentsSchema,
}).refine((detail) => detail.arguments.operation_id === detail.requestId, {
  message: "Proposal operation must match requestId",
});
export const approvalDetailsCapabilitySchema = z.looseObject({
  version: z.int().positive(),
  tools: z.array(z.string().min(1)),
});
/** Version 1 metadata for the existing owner-only standing-grant routes. */
export const standingGrantsCapabilityV1Schema = z.looseObject({
  version: z.literal(1),
  choices: z.array(standingChoice),
  cardField: z.literal("standingChoices"),
  stateField: z.literal("grantedCalls"),
  tools: z.array(z.string().min(1)),
  policyVersion: z.literal(1),
  initiatorKinds: z.array(z.string().min(1)),
  route: z.literal("/v1/members/{memberId}/grants"),
  inactiveListLimit: z.literal(20),
  revocation: z.literal("later-proposals-only"),
});
/** Unknown versions remain opaque metadata, never a supported v1 contract. */
export const standingGrantsCapabilitySchema = z.union([
  standingGrantsCapabilityV1Schema,
  z.looseObject({
    version: z.int().positive().refine((version) => version !== 1)
      .meta({ not: { const: 1 } }),
  }),
]);
export const handoffsCapabilityV1Schema = z.looseObject({
  version: z.literal(1),
  route: z.literal("/v1/conversations/{conversationId}/handoffs"),
  readRoute: z.literal("/v1/conversations/{conversationId}/handoff"),
  delivery: z.literal("reserved-first-request"),
  initiatorKind: z.literal("handoff"),
  transcriptBytes: z.literal(65_536),
  promptBytes: z.literal(promptBytes),
  carried: z.literal("newest-whole-committed-turns"),
  source: z.literal("sealed-readable"),
});
export const handoffsCapabilitySchema = z.union([
  handoffsCapabilityV1Schema,
  z.looseObject({
    version: z.int().positive().refine((version) => version !== 1)
      .meta({ not: { const: 1 } }),
  }),
]);
export const decisionReceiptsCapabilityV1Schema = z.looseObject({
  version: z.literal(1),
  field: z.literal("decisionId"),
  route: z.literal("/v1/conversations/{conversationId}/requests/{requestId}/approvals/{approvalId}/decision"),
  tools: z.array(z.string().min(1)),
  replay: z.literal("same-decision-id-and-choice"),
  conflictCode: z.literal("decision_conflict"),
  unverifiableCode: z.literal("decision_unverifiable"),
});
export const decisionReceiptsCapabilitySchema = z.union([
  decisionReceiptsCapabilityV1Schema,
  z.looseObject({
    version: z.int().positive().refine((version) => version !== 1)
      .meta({ not: { const: 1 } }),
  }),
]);
const decisionRecordBase = {
  apiVersion: z.literal("1"),
  conversationId: uuid,
  memberId: uuid,
  requestId: uuid,
  invocationId: uuid,
  approvalId: uuid,
  version: z.literal(1),
  toolName: z.enum(["record_work_item", "choose_next_step"]),
};
const decisionEffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("work_item"), receiptId: uuid }),
]);
export const decisionRecordSchema = z.discriminatedUnion("state", [
  z.object({
    ...decisionRecordBase,
    state: z.literal("decided"),
    decisionId: uuid.nullable(),
    choice: decisionChoice,
    recordedAt: z.iso.datetime().nullable(),
    effect: decisionEffectSchema,
  }),
  z.object({
    ...decisionRecordBase,
    state: z.literal("auto_approved"),
    grantId: uuid,
    recordedAt: z.iso.datetime(),
  }),
  z.object({
    ...decisionRecordBase,
    state: z.literal("closed"),
    reason: z.enum(["expired", "cancelled"]),
    closedAt: z.iso.datetime().nullable(),
  }),
  z.object({ ...decisionRecordBase, state: z.literal("undecided") }),
]).meta({
  description: "decided carries the exact choice and the caller's decisionId, null when the decision was made without one; "
    + "its recordedAt is null only for a decision older than the audit trail. closed means no decision can ever commit. "
    + "undecided only says that no decision is recorded yet, not that the card still accepts one.",
});
export const listGrantsSchema = z.strictObject({ memberId: uuid });
export const revokeGrantSchema = listGrantsSchema.extend({ grantId: uuid });
const grantBase = {
  grantId: uuid,
  memberId: uuid,
  toolName: z.literal("record_work_item"),
  policyVersion: z.literal(1),
  approvalId: uuid,
  createdAt: z.iso.datetime(),
};
const grantScopeSchema = z.discriminatedUnion("scope", [
  z.object({ ...grantBase, scope: z.literal("conversation"),
    conversationId: uuid, choice: z.literal("allow_conversation") }),
  z.object({ ...grantBase, scope: z.literal("member"),
    conversationId: z.null(), choice: z.literal("allow_always") }),
]);
const unrevokedFields = {
  revokedAt: z.never().optional(),
  revocationReason: z.never().optional(),
};
export const activeGrantSchema = z.intersection(grantScopeSchema, z.object({
  status: z.literal("active"), ...unrevokedFields,
}));
export const revokedGrantSchema = z.intersection(grantScopeSchema, z.object({
  status: z.literal("revoked"),
  revokedAt: z.iso.datetime(),
  revocationReason: z.enum(["owner", "recovery_restore"]),
}));
const closedGrantSchema = z.object({
  ...grantBase, scope: z.literal("conversation"), conversationId: uuid,
  choice: z.literal("allow_conversation"), status: z.literal("conversation_closed"),
  ...unrevokedFields,
});
export const publicGrantSchema = z.union([
  activeGrantSchema, revokedGrantSchema, closedGrantSchema,
]);
/** All active grants, with at most twenty inactive historical rows. */
export const grantListResponseSchema = z.object({
  apiVersion: z.literal("1"),
  memberId: uuid,
  active: z.array(activeGrantSchema),
  inactive: z.array(z.union([revokedGrantSchema, closedGrantSchema])).max(20),
}).refine((list) => {
  const grants = [...list.active, ...list.inactive];
  return grants.every((grant) => grant.memberId === list.memberId)
    && new Set(grants.map((grant) => grant.grantId)).size === grants.length;
}, { message: "Grant identities must be unique and belong to the listed member" });
export const revokeGrantResponseSchema = z.object({
  apiVersion: z.literal("1"), grant: revokedGrantSchema,
});
export const decisionReceiptSchema = z.object({
  approvalId: z.uuid(),
  decision: decisionChoice,
  decisionId: uuid.optional(),
});
const result = z.object({ text: z.string() });
const receiptBase = z.object({
  apiVersion: z.literal("1"),
  conversationId: z.uuid(),
  requestId: z.uuid(),
  acceptance: z.object({
    boundary: z.literal("sql_admission_and_temporal_queue"),
  }),
  result: result.optional(),
  reason: z.string().optional(),
  cancellation: z
    .object({
      receiptId: z.uuid(),
      delivery: z.enum(["pending", "delivered"]),
      nativeTermination: z.enum(["confirmed", "unconfirmed"]),
      effects: z.literal("not_assessed"),
    })
    .optional(),
  approvalDeadlineSeconds: approvalDeadlineSeconds.optional(),
  expiredApproval: z
    .object({
      approvalId: z.uuid(),
      expiresAt: z.iso.datetime(),
      expiredAt: z.iso.datetime(),
    })
    .optional(),
});
const pendingStatuses = z.enum([
  "accepted",
  "waiting",
  "running",
  "cancellation_requested",
  "cancelled",
  "failed",
  "uncertain",
]);
function receiptWith<I extends z.ZodType>(initiator: I) {
  const base = receiptBase.extend({ initiator: initiator.optional() });
  const retained = base.extend({ erased: z.literal(false).optional() });
  return z.union([
    z.discriminatedUnion("status", [
      retained.extend({ status: z.literal("completed"), result }),
      retained.extend({ status: pendingStatuses }),
    ]),
    base.extend({ status: z.enum(["completed", "failed", "cancelled"]), erased: z.literal(true), result: z.never().optional() }),
  ]);
}
/** Response-only initiators accept additive fields and new kinds without changing server admission. */
export const observedRequestInitiatorSchema = z.union([
  ...requestInitiator.options.map((option) => option.loose()),
  z.looseObject({
    kind: z
      .string()
      .min(1)
      .refine(
        (kind) =>
          !requestInitiator.options.some(
            (option) => option.shape.kind.value === kind,
          ),
      )
      .meta({
        not: {
          enum: requestInitiator.options.map(
            (option) => option.shape.kind.value,
          ),
        },
      }),
    id: z.string().optional(),
  }),
]);
export const serverRequestReceiptSchema = receiptWith(requestInitiator);
export const requestReceiptResponseSchema = receiptWith(
  observedRequestInitiatorSchema,
);
const retainedRequestReceiptResponseSchema = requestReceiptResponseSchema.options[0];
export const instructionsSummarySchema = z.object({
  bytes: z.int().nonnegative(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});
export const memberSubagentsSchema = z.strictObject({
  mode: z.enum(["legacy", "named"]),
  targets: z.array(z.strictObject({
    role: z.enum(["analyst", "recorder"]), engine: childEngineSchema, profile: z.string().min(1).max(128),
    model: z.string().min(1).max(256), providerHost: z.string().min(1).max(512), accountDigest: z.string().regex(/^[a-f0-9]{64}$/),
    availability: z.enum(["executable", "unsupported_engine", "removed"]),
  })),
});
export const memberSchema = z.object({
  memberId: z.uuid(),
  engine: engineSchema,
  profile: z.string(),
  subagents: memberSubagentsSchema.default({ mode: "legacy", targets: [] }),
  instructions: instructionsSummarySchema.optional(),
  instructionPacks: instructionPackIds.optional(),
});
export const listMembersSchema = z.strictObject({
  limit: z.int().min(1).max(100).optional(),
  after: z.string().max(128).optional(),
});
export const memberPageSchema = z.object({
  apiVersion: z.literal("1"),
  members: z.array(memberSchema),
  next: z.string().nullable(),
});
export const conversationContentTombstoneSchema = z.object({
  apiVersion: z.literal("1"), conversationId: uuid, memberId: uuid,
  engine: z.string().min(1), erasureId: uuid, erased: z.literal(true), erasedAt: z.iso.datetime(),
});
export const conversationClosureSchema = z.object({
  apiVersion: z.literal("1"), conversationId: uuid, closure: z.enum(["requested", "closed"]),
});
export const contentErasureCapabilityV1Schema = z.looseObject({
  version: z.literal(1), route: z.literal("/v1/conversations/{conversationId}/content"),
  closeRoute: z.literal("/v1/conversations/{conversationId}/close"), engines: z.tuple([z.literal("cursor"), z.literal("opencode")]).rest(z.string().min(1)).meta({minItems:2}),
  preconditions: z.literal("closed-workflow; terminal-requests; stopped-writers; complete-location-inventory"),
  retry: z.literal("same-conversation-until-200"),
  residuals: z.tuple([z.literal("Temporal-history-until-retention"), z.literal("WAL-backups-provider-copies-and-logs")]).rest(z.string().min(1)).meta({minItems:2}),
});
export const contentErasureCapabilitySchema = z.union([
  contentErasureCapabilityV1Schema,
  z.looseObject({version:z.int().positive().refine(version=>version!==1).meta({not:{const:1}})}),
]);
export type ConversationContentTombstone = z.infer<typeof conversationContentTombstoneSchema>;
export type ConversationClosure = z.infer<typeof conversationClosureSchema>;
export const conversationStateSchema = z.object({
  erased: z.literal(true).optional(), contentState: z.literal("erasing").optional(),
  conversationId: z.uuid(),
  memberId: z.uuid(),
  engine: engineSchema,
  profile: z.string(),
  phase: z.enum([
    "idle",
    "running",
    "waiting",
    "complete",
    "cancelled",
    "failed",
  ]),
});
export const conversationSnapshotSchema = conversationStateSchema.extend({
  cursor: z.int().nonnegative(),
});
export const jsonValueSchema = z.json();
const snapshotFields = {
  cursor: z.int().nonnegative(),
  state: conversationStateSchema.extend({erased:z.never().optional()}),
  messages: z.array(jsonValueSchema),
  openTools: z.record(z.string(), jsonValueSchema),
  openText: jsonValueSchema,
  childText: z.record(z.string(), jsonValueSchema),
};
export const snapshotWireSchema = z.union([
  z.object({...snapshotFields,erased:z.never().optional()}),
  z.object({
    ...snapshotFields, erased:z.literal(true),
    state:conversationStateSchema.extend({erased:z.literal(true),contentState:z.never().optional(),phase:z.enum(["complete","failed","cancelled"])}),
    messages:z.array(z.never()).length(0),openText:z.null(),
    openTools:z.record(z.string(),z.never()),childText:z.record(z.string(),z.never()),
  }),
]);
export const capabilitiesSchema = z.looseObject({
  apiVersion: z.literal("1"),
  requestContract: z.literal("sql-admission-temporal-queue-v1"),
  observation: z.looseObject({
    protocol: z.literal("AG-UI"),
    mode: z.literal("snapshot-and-bounded-tail"),
  }),
  initiatorKinds: z.array(z.string().min(1)),
  approvalDetails: approvalDetailsCapabilitySchema.optional(),
  standingGrants: standingGrantsCapabilitySchema.optional(),
  handoffs: handoffsCapabilitySchema.optional(),
  decisionReceipts: decisionReceiptsCapabilitySchema.optional(),
  contentErasure: contentErasureCapabilitySchema.optional(),
});
const dependencyStatus = z.enum(["ready", "unavailable"]);
export const healthSchema = z.object({
  apiVersion: z.literal("1"),
  status: z.enum(["ready", "not_ready"]),
  dependencies: z.object({
    database: z.object({
      status: dependencyStatus,
      schemaVersion: z.int().nullable(),
    }),
    temporal: z.object({ status: dependencyStatus }),
  }),
});
export const errorSchema = z.object({
  error: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_]+$/),
});
export type Engine = z.infer<typeof engineSchema>;
export type CreateMember = z.input<typeof createMemberSchema>;
export type CreateHandoff = z.input<typeof createHandoffSchema>;
export type HandoffRecord = z.output<typeof handoffRecordSchema>;
export type CreateHandoffResponse = z.output<typeof createHandoffResponseSchema>;
export type ConversationHandoff = z.output<typeof conversationHandoffSchema>;
export type HandoffsCapability = z.output<typeof handoffsCapabilitySchema>;
export type HandoffsCapabilityV1 = z.output<typeof handoffsCapabilityV1Schema>;
export type OpenConversation = z.input<typeof openConversationSchema>;
export type SubmitRequest = z.input<typeof submitRequestSchema>;
export type RequestIdentity = z.infer<typeof requestIdentitySchema>;
export type RequestInitiator = z.infer<typeof requestInitiator>;
export type ObservedRequestInitiator = z.infer<
  typeof observedRequestInitiatorSchema
>;
export type ObservedRequestReceipt = z.infer<
  typeof requestReceiptResponseSchema
>;
export type RequestReceipt = z.infer<typeof requestReceiptResponseSchema>;
export type ServerRequestReceipt = z.infer<typeof serverRequestReceiptSchema>;
export type InstructionsSummary = z.infer<typeof instructionsSummarySchema>;
export type Member = z.infer<typeof memberSchema>;
export type MemberPage = z.infer<typeof memberPageSchema>;
export type RecordWorkItemArguments = z.infer<typeof recordWorkItemArgumentsSchema>;
export type ApprovalDetailIdentity = z.infer<typeof approvalDetailIdentitySchema>;
export type OwnerApprovalDetail = z.infer<typeof ownerApprovalDetailSchema>;
export type StandingGrantsCapability = z.infer<typeof standingGrantsCapabilitySchema>;
export type StandingGrantsCapabilityV1 = z.infer<typeof standingGrantsCapabilityV1Schema>;
export type PublicGrant = z.infer<typeof publicGrantSchema>;
export type GrantList = z.infer<typeof grantListResponseSchema>;
export type ListGrants = z.input<typeof listGrantsSchema>;
export type RevokeGrant = z.input<typeof revokeGrantSchema>;
export type RevokeGrantResponse = z.infer<typeof revokeGrantResponseSchema>;
export type Decide = z.input<typeof decideSchema>;
export type DecisionRecord = z.infer<typeof decisionRecordSchema>;
export type DecisionReceiptsCapability = z.infer<typeof decisionReceiptsCapabilitySchema>;
export type DecisionReceiptsCapabilityV1 = z.infer<typeof decisionReceiptsCapabilityV1Schema>;
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;
export type Capabilities = z.infer<typeof capabilitiesSchema>;
export type Health = z.infer<typeof healthSchema>;

export const routes = {
  capabilities: {
    method: "GET",
    path: "/v1/capabilities",
    response: capabilitiesSchema,
    statuses: [200],
    command: false,
  },
  health: {
    method: "GET",
    path: "/v1/health",
    response: healthSchema,
    statuses: [200, 503],
    command: false,
  },
  listMembers: {
    method: "GET",
    path: "/v1/members",
    response: memberPageSchema,
    query: listMembersSchema,
    statuses: [200],
    command: false,
  },
  listGrants: {
    method: "GET",
    path: "/v1/members/{memberId}/grants",
    response: grantListResponseSchema,
    statuses: [200],
    command: false,
  },
  revokeGrant: {
    method: "POST",
    path: "/v1/members/{memberId}/grants/{grantId}/revoke",
    body: z.strictObject({}),
    response: revokeGrantResponseSchema,
    statuses: [200],
    command: true,
  },
  createMember: {
    method: "POST",
    path: "/v1/members",
    body: createMemberSchema,
    response: memberSchema,
    statuses: [201],
    command: true,
  },
  openConversation: {
    method: "POST",
    path: "/v1/conversations",
    body: openConversationSchema,
    response: snapshotWireSchema,
    statuses: [201],
    command: true,
  },
  eraseConversationContent: {
    method: "DELETE", path: "/v1/conversations/{conversationId}/content",
    response: conversationContentTombstoneSchema, statuses: [200], command: true,
  },
  closeConversation: {
    method: "POST", path: "/v1/conversations/{conversationId}/close", body: z.strictObject({}),
    response: conversationClosureSchema, statuses: [200, 202], command: true,
  },
  conversation: {
    method: "GET",
    path: "/v1/conversations/{conversationId}",
    response: snapshotWireSchema,
    statuses: [200],
    command: false,
  },
  createHandoff: {
    method: "POST",
    path: handoffsCapabilityV1Schema.shape.route.value,
    body: createHandoffBodySchema,
    response: createHandoffResponseSchema,
    statuses: [201],
    command: true,
    unknownOutcomeErrors: [{ status: 409, code: "update_rejected" }],
  },
  handoff: {
    method: "GET",
    path: handoffsCapabilityV1Schema.shape.readRoute.value,
    response: conversationHandoffSchema,
    statuses: [200],
    command: false,
  },
  submit: {
    method: "POST",
    path: "/v1/conversations/{conversationId}/requests",
    body: submitRequestSchema.omit({ conversationId: true }),
    response: retainedRequestReceiptResponseSchema,
    statuses: [202],
    command: true,
  },
  requestStatus: {
    method: "GET",
    path: "/v1/conversations/{conversationId}/requests/{requestId}",
    response: requestReceiptResponseSchema,
    statuses: [200],
    command: false,
  },
  cancel: {
    method: "POST",
    path: "/v1/conversations/{conversationId}/requests/{requestId}/cancel",
    body: z.strictObject({}),
    response: retainedRequestReceiptResponseSchema,
    statuses: [202],
    command: true,
  },
  approvalDetail: {
    method: "GET",
    path: "/v1/conversations/{conversationId}/requests/{requestId}/approvals/{approvalId}",
    query: approvalDetailQuerySchema,
    response: ownerApprovalDetailSchema,
    statuses: [200],
    command: false,
  },
  decisionRecord: {
    method: "GET",
    path: decisionReceiptsCapabilityV1Schema.shape.route.value,
    query: approvalDetailQuerySchema,
    response: decisionRecordSchema,
    statuses: [200],
    command: false,
  },
  decide: {
    method: "POST",
    path: "/v1/conversations/{conversationId}/human",
    body: decideSchema.omit({ conversationId: true }),
    response: decisionReceiptSchema,
    statuses: [200],
    command: true,
  },
} as const;
export const observerPath = "/v1/conversations/{conversationId}/events";
