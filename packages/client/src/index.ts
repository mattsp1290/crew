import { z } from "zod";
import { connection, type ConnectionOptions } from "./config.js";
import {
  approvalDetailIdentitySchema,
  conversationIdentitySchema,
  createHandoffSchema,
  createMemberSchema,
  decideSchema,
  errorSchema,
  listMembersSchema,
  listGrantsSchema,
  revokeGrantSchema,
  openConversationSchema,
  requestIdentitySchema,
  routes,
  memberSubmitEnvelopeSchema,
  type ApprovalDetailIdentity,
  type OwnerApprovalDetail,
  type CreateMember,
  type CreateHandoff,
  type CreateHandoffResponse,
  type ConversationHandoff,
  type Decide,
  type DecisionRecord,
  type ListGrants,
  type RevokeGrant,
  type OpenConversation,
  type RequestIdentity,
  type SubmitRequest,
} from "./contract.js";
export type {
  RecordWorkItemArguments,
  ApprovalDetailIdentity,
  OwnerApprovalDetail,
  Engine,
  CreateMember,
  CreateHandoff,
  HandoffRecord,
  CreateHandoffResponse,
  ConversationHandoff,
  HandoffsCapability,
  HandoffsCapabilityV1,
  OpenConversation,
  SubmitRequest,
  RequestIdentity,
  RequestInitiator,
  ObservedRequestInitiator,
  ObservedRequestReceipt,
  RequestReceipt,
  ServerRequestReceipt,
  ContentErasureCapability,
  ContentErasureCapabilityV1,
  ConversationContentTombstone,
  ConversationClosure,
  InstructionsSummary,
  Member,
  MemberPage,
  Decide,
  DecisionRecord,
  DecisionReceiptsCapability,
  DecisionReceiptsCapabilityV1,
  ConversationSnapshot,
  Capabilities,
  Health,
  StandingGrantsCapability,
  StandingGrantsCapabilityV1,
  PublicGrant,
  GrantList,
  ListGrants,
  RevokeGrant,
  RevokeGrantResponse,
} from "./contract.js";
export interface CrewClientOptions extends ConnectionOptions {
  readonly fetch?: typeof globalThis.fetch;
}
export interface CallOptions {
  readonly signal?: AbortSignal;
}
export type HandoffCommandIdentity = Readonly<
  { kind: "handoff" } & z.output<typeof createHandoffSchema>
>;
export type CommandIdentity =
  | HandoffCommandIdentity
  | { readonly kind: "member"; readonly requestId: string }
  | { readonly kind: "conversation"; readonly conversationId: string }
  | { readonly kind: "content_erasure"; readonly conversationId: string }
  | { readonly kind: "conversation_close"; readonly conversationId: string }
  | {
      readonly kind: "request";
      readonly conversationId: string;
      readonly requestId: string;
    }
  | {
      readonly kind: "grant_revocation";
      readonly memberId: string;
      readonly grantId: string;
    }
  | {
      readonly kind: "decision";
      readonly conversationId: string;
      readonly requestId: string;
      readonly approvalId: string;
      readonly decisionId?: string;
    };
export class CrewHttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`Crew HTTP ${status}: ${code}`);
    this.name = "CrewHttpError";
    this.status = status;
    this.code = code;
  }
}
export class CrewTransportError extends Error {
  constructor() {
    super("Crew transport failed");
    this.name = "CrewTransportError";
  }
}
export class CrewProtocolError extends Error {
  constructor() {
    super("Crew returned an invalid or oversized response");
    this.name = "CrewProtocolError";
  }
}
export class CrewUnknownOutcomeError extends Error {
  readonly command: CommandIdentity;
  constructor(command: CommandIdentity, cause: unknown) {
    super("Crew command outcome is unknown; reconcile the original identity", {
      cause,
    });
    this.name = "CrewUnknownOutcomeError";
    this.command = Object.freeze({ ...command });
  }
}
async function boundedJson(
  response: Response,
  limit: number,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new CrewProtocolError();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new CrewProtocolError();
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch {
    throw new CrewProtocolError();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function project(snapshot: z.output<typeof routes.conversation.response>) {
  return { cursor: snapshot.cursor, ...snapshot.state };
}
export class CrewClient {
  readonly #config: ReturnType<typeof connection>;
  readonly #fetch: typeof globalThis.fetch;
  constructor(options: CrewClientOptions) {
    this.#config = connection(options);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }
  async #call<T>(
    route: {
      method: string;
      path: string;
      response: z.ZodType<T>;
      responses?: Readonly<Record<number, z.ZodType<T>>>;
      statuses: readonly number[];
      unknownOutcomeErrors?: readonly { readonly status: number; readonly code: string }[];
    },
    input: {
      params?: Record<string, string>;
      body?: unknown;
      query?: string;
      command?: CommandIdentity;
      signal?: AbortSignal;
      expect?: (value: T) => boolean;
    } = {},
  ): Promise<T> {
    input.signal?.throwIfAborted();
    const path = route.path.replace(/\{(\w+)\}/g, (_, key: string) =>
      encodeURIComponent(input.params?.[key] ?? ""),
    );
    let response: Response;
    try {
      response = await this.#fetch(
        this.#config.baseUrl + path + (input.query ? `?${input.query}` : ""),
        {
          method: route.method,
          headers: {
            ...this.#config.headers,
            ...(input.body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
            Accept: "application/json",
          },
          ...(input.body === undefined
            ? {}
            : { body: JSON.stringify(input.body) }),
          signal: input.signal,
          redirect: "error",
        },
      );
    } catch {
      const failure = new CrewTransportError();
      if (input.command)
        throw new CrewUnknownOutcomeError(input.command, failure);
      input.signal?.throwIfAborted();
      throw failure;
    }
    try {
      const documented = route.statuses.includes(response.status);
      if (response.ok && !documented) {
        await response.body?.cancel().catch(() => {});
        throw new CrewProtocolError();
      }
      const value = await boundedJson(
        response,
        documented ? 8 * 1024 * 1024 : 16_384,
      ).catch(() => undefined);
      if (documented) {
        const parsed = (route.responses?.[response.status] ?? route.response).safeParse(value);
        if (parsed.success) {
          if (input.expect && !input.expect(parsed.data))
            throw new CrewProtocolError();
          return parsed.data;
        }
      }
      if (response.ok) throw new CrewProtocolError();
      const parsed = errorSchema.safeParse(value);
      const code = parsed.success
        ? parsed.data.error
        : "invalid_error_response";
      const failure = new CrewHttpError(response.status, code);
      if (
        input.command &&
        (code === "retry_same_request" ||
          response.status >= 500 ||
          route.unknownOutcomeErrors?.some((failure) =>
            failure.status === response.status && failure.code === code) ||
          !parsed.success)
      ) {
        throw new CrewUnknownOutcomeError(input.command, failure);
      }
      throw failure;
    } catch (error) {
      if (!input.command) input.signal?.throwIfAborted();
      if (
        input.command &&
        !(error instanceof CrewHttpError) &&
        !(error instanceof CrewUnknownOutcomeError)
      )
        throw new CrewUnknownOutcomeError(
          input.command,
          new CrewProtocolError(),
        );
      throw error;
    }
  }
  async capabilities(options: CallOptions = {}) {
    return this.#call(routes.capabilities, options);
  }
  async approvalDetail(input: ApprovalDetailIdentity, options: CallOptions = {}): Promise<OwnerApprovalDetail> {
    const key = approvalDetailIdentitySchema.parse(input);
    const query = new URLSearchParams({
      memberId: key.memberId, invocationId: key.invocationId, version: String(key.version),
    });
    return this.#call(routes.approvalDetail, {
      ...options,
      params: { conversationId: key.conversationId, requestId: key.requestId, approvalId: key.approvalId },
      query: query.toString(),
      expect: (detail) => detail.conversationId === key.conversationId && detail.memberId === key.memberId
        && detail.requestId === key.requestId && detail.invocationId === key.invocationId
        && detail.approvalId === key.approvalId && detail.version === key.version,
    });
  }
  async decisionRecord(input: ApprovalDetailIdentity, options: CallOptions = {}): Promise<DecisionRecord> {
    const key = approvalDetailIdentitySchema.parse(input);
    const query = new URLSearchParams({
      memberId: key.memberId, invocationId: key.invocationId, version: String(key.version),
    });
    return this.#call(routes.decisionRecord, {
      ...options,
      params: { conversationId: key.conversationId, requestId: key.requestId, approvalId: key.approvalId },
      query: query.toString(),
      expect: (record) => record.conversationId === key.conversationId && record.memberId === key.memberId
        && record.requestId === key.requestId && record.invocationId === key.invocationId
        && record.approvalId === key.approvalId && record.version === key.version,
    });
  }
  async health(options: CallOptions = {}) {
    return this.#call(routes.health, options);
  }
  async listMembers(
    input: z.input<typeof listMembersSchema> = {},
    options: CallOptions = {},
  ) {
    const value = listMembersSchema.parse(input),
      query = new URLSearchParams();
    if (value.limit !== undefined) query.set("limit", String(value.limit));
    if (value.after !== undefined) query.set("after", value.after);
    return this.#call(routes.listMembers, {
      ...options,
      query: query.toString(),
    });
  }
  async listGrants(input: ListGrants, options: CallOptions = {}) {
    const params = listGrantsSchema.parse(input);
    return this.#call(routes.listGrants, {
      ...options, params,
      expect: (list) => list.memberId === params.memberId,
    });
  }
  async revokeGrant(input: RevokeGrant, options: CallOptions = {}) {
    const params = revokeGrantSchema.parse(input);
    return this.#call(routes.revokeGrant, {
      ...options, params, body: {},
      command: { kind: "grant_revocation", ...params },
      expect: ({ grant }) => grant.memberId === params.memberId
        && grant.grantId === params.grantId,
    });
  }
  async createMember(input: CreateMember, options: CallOptions = {}) {
    const body = createMemberSchema.parse(input);
    return this.#call(routes.createMember, {
      ...options,
      body,
      command: { kind: "member", requestId: body.requestId },
    });
  }
  async openConversation(input: OpenConversation, options: CallOptions = {}) {
    const body = openConversationSchema.parse(input),
      command = {
        kind: "conversation",
        conversationId: body.conversationId,
      } as const;
    return project(
      await this.#call(routes.openConversation, {
        ...options,
        body,
        command,
        expect: (value) =>
          value.state.conversationId === body.conversationId &&
          value.state.memberId === body.memberId,
      }),
    );
  }
  async eraseConversationContent(input: { readonly conversationId: string }, options: CallOptions = {}) {
    const params = conversationIdentitySchema.parse(input);
    return this.#call(routes.eraseConversationContent, { ...options, params,
      command: { kind: "content_erasure", ...params }, expect: value => value.conversationId === params.conversationId });
  }
  async closeConversation(input: { readonly conversationId: string }, options: CallOptions = {}) {
    const params = conversationIdentitySchema.parse(input);
    return this.#call(routes.closeConversation, { ...options, params, body: {},
      command: { kind: "conversation_close", ...params }, expect: value => value.conversationId === params.conversationId });
  }
  async conversation(
    input: { readonly conversationId: string },
    options: CallOptions = {},
  ) {
    const params = conversationIdentitySchema.parse(input);
    return project(
      await this.#call(routes.conversation, {
        ...options,
        params,
        expect: (value) => value.state.conversationId === params.conversationId,
      }),
    );
  }
  async createHandoff(input: CreateHandoff, options: CallOptions = {}): Promise<CreateHandoffResponse> {
    const { conversationId, ...body } = createHandoffSchema.parse(input);
    return this.#call(routes.createHandoff, {
      ...options,
      params: { conversationId },
      body,
      command: { kind: "handoff", conversationId, ...body },
      expect: (record) => record.source.conversationId === conversationId
        && record.requestId === body.requestId && record.target.memberId === body.memberId,
    });
  }
  async handoff(
    input: z.input<typeof conversationIdentitySchema>,
    options: CallOptions = {},
  ): Promise<ConversationHandoff> {
    const params = conversationIdentitySchema.parse(input);
    return this.#call(routes.handoff, {
      ...options,
      params,
      expect: (chain) => chain.conversationId === params.conversationId,
    });
  }
  async #receipt<T extends { conversationId: string; requestId: string }>(
    route: {
      method: string;
      path: string;
      response: z.ZodType<T>;
      responses?: Readonly<Record<number, z.ZodType<T>>>;
      statuses: readonly number[];
      command: boolean;
    },
    key: RequestIdentity,
    options: CallOptions,
    body?: unknown,
  ) {
    const command = route.command
      ? ({ kind: "request", ...key } as const)
      : undefined;
    return this.#call(route, {
      ...options,
      params: key,
      body,
      command,
      expect: (value) =>
        value.conversationId === key.conversationId &&
        value.requestId === key.requestId,
    });
  }
  async submit(input: SubmitRequest, options: CallOptions = {}) {
    const { conversationId, ...body } = memberSubmitEnvelopeSchema.parse(input);
    return this.#receipt(
      routes.submit,
      { conversationId, requestId: body.requestId },
      options,
      body,
    );
  }
  async requestStatus(input: RequestIdentity, options: CallOptions = {}) {
    return this.#receipt(
      routes.requestStatus,
      requestIdentitySchema.parse({
        conversationId: input.conversationId,
        requestId: input.requestId,
      }),
      options,
    );
  }
  async cancel(input: RequestIdentity, options: CallOptions = {}) {
    return this.#receipt(
      routes.cancel,
      requestIdentitySchema.parse({
        conversationId: input.conversationId,
        requestId: input.requestId,
      }),
      options,
      {},
    );
  }
  async decide(input: Decide, options: CallOptions = {}) {
    const { conversationId, ...body } = decideSchema.parse(input);
    const command = {
      kind: "decision",
      conversationId,
      requestId: body.requestId,
      approvalId: body.approvalId,
      ...(body.decisionId !== undefined && { decisionId: body.decisionId }),
    } as const;
    return this.#call(routes.decide, {
      ...options,
      params: { conversationId },
      body,
      command,
      expect: (value) => value.approvalId === body.approvalId && value.decision === body.choice
        && value.decisionId === body.decisionId,
    });
  }
}
