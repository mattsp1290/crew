import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import {
  routes,
  observerPath,
  errorSchema,
  jsonValueSchema,
  instructionsSummarySchema,
  memberSchema,
  conversationStateSchema,
} from "../packages/client/src/contract.ts";

const registry = z.registry();
const reference = (id) => `#/components/schemas/${id}`;
const content = (value) => {
  const entry = registry.get(value);
  if (!entry) throw new Error("OpenAPI schema has no stable component name");
  return { "application/json": { schema: { $ref: reference(entry.id) } } };
};
for (const [id, value] of Object.entries({
  JsonValue: jsonValueSchema,
  Error: errorSchema,
  InstructionsSummary: instructionsSummarySchema,
  Member: memberSchema,
  ConversationState: conversationStateSchema,
  Capabilities: routes.capabilities.response,
  Health: routes.health.response,
  MemberPage: routes.listMembers.response,
  ConversationSnapshot: routes.conversation.response,
  RequestReceipt: routes.requestStatus.response,
  DecisionReceipt: routes.decide.response,
  CreateMember: routes.createMember.body,
  OpenConversation: routes.openConversation.body,
  SubmitRequest: routes.submit.body,
  CancelRequest: routes.cancel.body,
  Decide: routes.decide.body,
}))
  registry.add(value, { id });
const observationInput = RunAgentInputSchema.extend({
  messages: z.tuple([]),
  tools: z.tuple([]),
  context: z.tuple([]),
  resume: z.tuple([]).optional(),
  state: z.strictObject({}).nullable().optional(),
  forwardedProps: z.strictObject({}).nullable().optional(),
});
registry.add(observationInput, { id: "ObservationInput" });
const errorResponses = {
  Error: {
    description: "Bounded public error code.",
    content: content(errorSchema),
  },
  Unavailable: {
    description: "The service is unavailable.",
    content: content(errorSchema),
  },
  CommandUnavailable: {
    description:
      "The command outcome is unknown. Reconcile the original identity; retry_same_request requires the same request.",
    content: content(errorSchema),
  },
};
const errors = (command) =>
  Object.fromEntries(
    [400, 401, 404, 405, 409, 413, 500, 503].map((status) => [
      status,
      {
        $ref: `#/components/responses/${status < 500 ? "Error" : command ? "CommandUnavailable" : "Unavailable"}`,
      },
    ]),
  );
const paths = {};
const parameters = (path) =>
  [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string", format: "uuid" },
  }));
for (const [operationId, route] of Object.entries(routes)) {
  const operation = {
    operationId,
    parameters: parameters(route.path),
    responses: {
      ...errors(route.command),
      ...Object.fromEntries(
        route.statuses.map((status) => [
          status,
          {
            description:
              status < 400 ? "Success" : "Dependency readiness report",
            content: content(route.response),
          },
        ]),
      ),
    },
  };
  if (route.body)
    operation.requestBody = { required: true, content: content(route.body) };
  if (route.query) {
    const query = z.toJSONSchema(route.query, { io: "input" });
    operation.parameters.push(
      ...Object.entries(query.properties).map(([name, value]) => ({
        name,
        in: "query",
        schema: value,
      })),
    );
  }
  if (operationId === "submit")
    operation.description =
      "One admission attempt. Preserve requestId and exact UTF-8 text for reconciliation. Acceptance does not prove completion or effects.";
  if (operationId === "cancel")
    operation.description =
      "Durable cancellation intent. Delivery, native termination and effects are independent facts. This does not claim rollback.";
  (paths[route.path] ??= {})[route.method.toLowerCase()] = operation;
}
paths[observerPath] = {
  post: {
    operationId: "observe",
    description:
      "Official AG-UI snapshot and bounded event tail. threadId must match conversationId. messages, tools and context must be empty, state and forwardedProps empty or null, and resume absent or empty. Reconnect with a fresh snapshot after cursor expiry. This route never submits work.",
    parameters: [
      ...parameters(observerPath),
      {
        name: "after",
        in: "query",
        schema: { type: "string" },
        description:
          "If supplied, must equal the current snapshot cursor as a decimal string.",
      },
    ],
    requestBody: { required: true, content: content(observationInput) },
    responses: {
      ...errors(false),
      410: {
        description: "CURSOR_EXPIRED. Establish a fresh snapshot.",
        content: content(errorSchema),
      },
      200: {
        description:
          "AG-UI Server-Sent Events encoded by @ag-ui/encoder 1.0.4. Each data frame is an official AG-UI event; optional id is the persisted cursor.",
        content: { "text/event-stream": { schema: { type: "string" } } },
      },
    },
  },
};
// The wire contract describes values received by the parser, before the SDK strips additive fields.
const { schemas } = z.toJSONSchema(registry, { io: "input", uri: reference });
const schemaDefinitions = Object.fromEntries(
  Object.entries(schemas).map(([id, { $id, $schema, ...schema }]) => [
    id,
    schema,
  ]),
);
const document = {
  openapi: "3.1.0",
  info: {
    title: "Crew core integration API",
    version: "1.0.0",
    description:
      "Bounded core integration surface. This document is not the complete Crew API. See x-excluded-routes for the current v1 routes outside its scope. UTF-8 byte bounds and control-character restrictions are enforced by the shared runtime schemas and described with x- extensions.",
  },
  security: [{ bearerAuth: [] }],
  components: {
    schemas: schemaDefinitions,
    responses: errorResponses,
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
  },
  paths,
  "x-excluded-routes": [
    "GET /v1/conversations",
    "/v1/audit",
    "/v1/routines and descendants",
    "/v1/memories and descendants",
    "/v1/instruction-packs and descendants",
    "/v1/webhooks and descendants",
    "/v1/usage and descendants",
    "/v1/members/{memberId}/grants and descendants",
    "/v1/members/{memberId}/instructions",
    "/v1/conversations/{conversationId}/handoff",
    "/v1/conversations/{conversationId}/handoffs",
    "/v1/conversations/{conversationId}/inputs (legacy admission)",
    "/v1/conversations/{conversationId}/cancel (legacy cancellation)",
  ],
};
const target = new URL("../packages/client/openapi.json", import.meta.url),
  generated = JSON.stringify(document, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")) !== generated)
    throw new Error("OpenAPI is stale. Run npm run openapi.");
} else await writeFile(target, generated);
console.log(
  process.argv.includes("--check")
    ? "OpenAPI is current"
    : "Generated core OpenAPI 3.1",
);
