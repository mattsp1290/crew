/** The scripted reply to a conversation handoff's first request: its header line, then the JSON
 * transcript (src/service/handoffs.ts). Parsing it shows the model got the whole transcript. */
export function handoffAcknowledgement(prompt: string | undefined) {
  if (!prompt?.startsWith("BirbCrew conversation handoff v1. ")) return undefined;
  const transcript = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1)) as { sourceEngine: string; turns: unknown[] };
  return `acknowledged ${transcript.turns.length} turns from ${transcript.sourceEngine}`;
}
