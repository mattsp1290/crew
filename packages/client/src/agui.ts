import { HttpAgent, type RunAgentParameters } from "@ag-ui/client";
import { connection, type ConnectionOptions } from "./config.js";
import { conversationIdentitySchema, observerPath } from "./contract.js";
class CrewObserver extends HttpAgent {
  protected override prepareRunAgentInput(parameters?: RunAgentParameters) {
    const { resume: _resume, ...input } = super.prepareRunAgentInput(parameters);
    return { ...input, messages: [], state: {}, tools: [], context: [], forwardedProps: {} };
  }
}
export function createCrewObserver(options: ConnectionOptions & { readonly conversationId: string }): HttpAgent {
  const { baseUrl, headers } = connection(options);
  const { conversationId } = conversationIdentitySchema.parse({ conversationId: options.conversationId });
  return new CrewObserver({ url: baseUrl + observerPath.replace("{conversationId}", conversationId), threadId: conversationId, headers });
}
