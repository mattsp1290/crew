# Crew Pi subagents

The Crew worker creates one `createDelegationBatch({ model, allowRecordWorkItem })` per parent model segment. Pass its `extension` to the Pi resource loader and add `delegate_task` to the parent tool allowlist. A child session omits this factory. The standalone Pi entry rejects calls that lack a Crew host.

On SDK settlement, pass the assistant's complete ordered tool-call batch and its native tool-result messages to `confirm`. Commit the returned proposals and pinned child profiles with the native assistant checkpoint. Each task can contain up to 4096 UTF-8 bytes. Analysts have no tools. Recorders require the parent's protected work-item capability. A segment accepts at most two distinct sibling calls.

The host starts child workflows after committing the proposals. Once every child has a durable outcome, call `delegationToolResults(proposals, outcomes, recordedTimestamp)` to reconstruct the ordered native tool results. The host appends these results once before resuming the parent. Temporary SDK acknowledgements stay in the segment that captured the proposals.

Run `npm test` with Node 24.22.3 to pack the extension, install it in a clean consumer, and exercise its registered tool with Pi coding sessions.
