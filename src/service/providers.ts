import { loadLiveProfiles } from "./live-profiles.ts";

/**
 * The live worker's profile module: `cli.ts worker src/service/providers.ts`.
 * Loading it without BIRBCREW_LIVE_PROFILES, or without the API key of a configured engine, stops the worker at
 * startup. A Codex subscription's sign-in is read on every turn.
 */
export const profiles = await loadLiveProfiles(process.env);
