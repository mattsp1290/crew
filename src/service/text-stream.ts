import type { Pool, PoolClient } from "pg";

/** The third element of a Codex ledger id is the id the model can write. Other stored ids stay as they are. */
export function proseCallId(id: string): string | undefined {
  try {
    const parts = JSON.parse(id);
    return Array.isArray(parts) && typeof parts[2] === "string" && parts[2] !== "" ? parts[2] : undefined;
  } catch {
    return undefined;
  }
}

// Native correlation IDs can also appear in model-generated prose, including across delta boundaries.
export async function nativeCallIds(db: Pool | PoolClient, conversationId: string) {
  const { rows } = await db.query<{ native_call_id: string }>(
    `SELECT native_call_id FROM birbcrew_ts.deferred_calls WHERE conversation_id=$1
     UNION SELECT native_call_id FROM birbcrew_ts.pi_children WHERE conversation_id=$1`, [conversationId]);
  const ids = new Set(rows.map((row) => row.native_call_id));
  for (const id of [...ids]) {
    const prose = proseCallId(id);
    if (prose) ids.add(prose);
  }
  return [...ids].sort((a, b) => b.length - a.length);
}

export async function textProjection(db: Pool | PoolClient, conversationId: string) {
  const literals = await nativeCallIds(db, conversationId);
  let held = "";
  return (delta: string, final = false) => {
    const text = held + delta;
    held = "";
    if (!literals.length) return text;
    let output = "";
    for (let i = 0; i < text.length;) {
      const suffix = text.slice(i);
      if (!final && literals.some((id) => suffix.length < id.length && id.startsWith(suffix))) {
        held = suffix;
        break;
      }
      const match = literals.find((id) => text.startsWith(id, i));
      if (match) { output += "[tool call]"; i += match.length; }
      else output += text[i++];
    }
    return output;
  };
}

// SDK callbacks are synchronous. Allow one SQL write in flight and coalesce arrivals until it finishes.
export function textWriter(write: (index: number, delta: string) => Promise<void>) {
  let next = 0;
  let pending = "";
  let active: Promise<void> | undefined;
  let failure: unknown;
  function push(delta: string) {
    if (!delta || failure) return;
    pending += delta;
    if (active) return;
    active = drainPending();
  }
  async function drainPending() {
    try {
      while (pending) {
        const chunk = pending;
        pending = "";
        await write(next++, chunk);
      }
    } catch (error) {
      failure = error;
    } finally {
      active = undefined;
    }
  }
  return {
    push,
    async drain() {
      await active;
      if (failure) throw failure;
    },
  };
}
