import { setTimeout as delay } from "node:timers/promises";
import { createEventStream, type EventStream, type SubscriptionEnd } from "@mattsp1290/switchboard";
import type { Pool } from "pg";
import { errorSummary, warn } from "./diagnostics.ts";
import { readEvents } from "./observation.ts";

// The gateway's observer fan-out. One reader per (owner, conversation) polls the owner-scoped public event
// ledger as every observer used to, and publishes each committed row to the observers of that hub. PostgreSQL
// stays the authority: an observer takes its snapshot and cursor from the database, reads the database itself
// for anything before the hub's position, and goes back to reading the database itself whenever its hub
// subscription ends. Workflow code must not import this module (it loads Switchboard, which loads node:fs).

/** A committed public event as readEvents returns it. Every observer of a hub shares the same frozen row. */
export type ObservedRow = Awaited<ReturnType<typeof readEvents>>[number];

export interface FanoutBounds {
  /** Observers one conversation's hub admits; later ones read the database themselves. */
  readonly maxObservers: number;
  /** Rows queued for one observer, counting the one it is sending. One more ends its subscription. */
  readonly capacity: number;
}

// A read returns at most 32 rows and publishes them together, so an observer that keeps up never holds more
// than one read's worth. 128 lets a briefly slow client fall four reads behind before it overflows and
// continues from the database, which keeps the last 256 frames.
export const defaultFanoutBounds: FanoutBounds = { maxObservers: 64, capacity: 128 };

// Same idle wait as the per-observer loop this replaces.
const idleMs = 75;

/** Whether the gateway fans out when BIRBCREW_OBSERVER_FANOUT is unset. */
export const fanoutByDefault = true;

export class ObserverSettingsError extends Error {}

/** BIRBCREW_OBSERVER_FANOUT: unset uses the default, `false` restores one database poll per observer. */
export function observerFanout(env: NodeJS.ProcessEnv): boolean {
  const value = env.BIRBCREW_OBSERVER_FANOUT?.trim().toLowerCase() ?? "";
  if (value === "") return fanoutByDefault;
  if (value === "true" || value === "false") return value === "true";
  // A typo must not leave the operator on a path they did not choose.
  throw new ObserverSettingsError("BIRBCREW_OBSERVER_FANOUT must be true or false");
}

/** What a hub delivers to one observer, in cursor order. */
export interface Feed {
  /** The hub's cursor when this observer attached. Every later row reaches this feed, in order. */
  readonly from: number;
  /**
   * The next row, or undefined once the subscription has ended: on overflow, on a failed hub read, or when
   * the observer disconnected. The observer then reads the database from its own cursor.
   */
  next(): Promise<ObservedRow | undefined>;
  /** Idempotent. The last observer to leave stops the hub's reader and releases the hub. */
  dispose(): void;
}

interface Hub {
  readonly key: string;
  readonly stream: EventStream<ObservedRow>;
  readonly reader: AbortController;
  /** The highest cursor read and published, or the first observer's snapshot cursor before any read. */
  cursor: number;
  observers: number;
}

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

export class ObserverHubs {
  readonly #pool: Pool;
  readonly #bounds: FanoutBounds;
  readonly #hubs = new Map<string, Hub>();
  #observers = 0;
  #fallbacks = 0;
  #closed = false;

  constructor(pool: Pool, bounds: Partial<FanoutBounds> = {}) {
    this.#pool = pool;
    this.#bounds = { ...defaultFanoutBounds, ...bounds };
    createEventStream(this.#bounds).close(); // Invalid bounds throw here, not on the first observer.
  }

  /** Open hubs, attached observers, and observers sent back to the database (overflow, full hub, failed read). */
  stats() {
    return { hubs: this.#hubs.size, observers: this.#observers, fallbacks: this.#fallbacks };
  }

  /**
   * Attaches an observer the caller has already authorised: `owner` comes from its token, and its snapshot of
   * `conversationId` was read under that owner at `cursor`. The owner is part of the hub's key and scopes every
   * read the hub makes, so a hub only ever holds rows that owner may read. Undefined when the hub is full or
   * the gateway is closing: the observer then reads the database itself.
   */
  attach(owner: string, conversationId: string, cursor: number, signal: AbortSignal): Feed | undefined {
    if (this.#closed) return undefined;
    const key = JSON.stringify([owner, conversationId]);
    const hub = this.#hubs.get(key) ?? this.#open(key, owner, conversationId, cursor);
    const from = hub.cursor;
    // The row the stream is delivering and the one the observer is sending. Each listener call stays pending
    // until the observer asks for the next row, so the stream's capacity measures how far this observer lags.
    let offered: { row: ObservedRow; sent: () => void } | undefined;
    let sending: (() => void) | undefined;
    let wake: (() => void) | undefined;
    let ended = false;
    const subscribed = hub.stream.subscribe((row) => new Promise<void>((sent) => {
      offered = { row, sent };
      wake?.();
    }), { signal });
    if (subscribed.kind === "error") {
      this.#fallbacks++;
      warn("observer_hub_full", { maxObservers: this.#bounds.maxObservers });
      if (!hub.observers) this.#close(hub);
      return undefined;
    }
    hub.observers++;
    this.#observers++;
    const subscription = subscribed.value;
    void subscription.ended.then((reason: SubscriptionEnd) => {
      ended = true;
      // Settles the pending listener call, so the stream releases this observer's lease.
      offered?.sent();
      sending?.();
      offered = sending = undefined;
      wake?.();
      hub.observers--;
      this.#observers--;
      if (reason === "overflow" || reason === "listener-error" || (reason === "closed" && !this.#closed && !signal.aborted)) {
        this.#fallbacks++;
        if (reason !== "closed") warn("observer_fallback", { reason, capacity: this.#bounds.capacity });
      }
      if (!hub.observers) this.#close(hub);
    });
    return {
      from,
      async next() {
        sending?.();
        sending = undefined;
        for (;;) {
          if (ended) return undefined;
          if (offered) {
            const { row, sent } = offered;
            offered = undefined;
            sending = sent;
            return row;
          }
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = undefined;
        }
      },
      dispose: () => subscription.dispose(),
    };
  }

  /** Stops every reader. Observers still attached end with their subscription and read the database themselves. */
  close() {
    this.#closed = true;
    for (const hub of [...this.#hubs.values()]) this.#close(hub);
  }

  #open(key: string, owner: string, conversationId: string, cursor: number): Hub {
    const hub: Hub = { key, stream: createEventStream(this.#bounds), reader: new AbortController(), cursor, observers: 0 };
    this.#hubs.set(key, hub);
    void this.#read(hub, owner, conversationId);
    return hub;
  }

  async #read(hub: Hub, owner: string, conversationId: string) {
    const { signal } = hub.reader;
    try {
      while (!signal.aborted) {
        const rows = await readEvents(this.#pool, owner, conversationId, hub.cursor);
        if (signal.aborted) return;
        for (const row of rows) {
          hub.cursor = row.cursor;
          hub.stream.publish(freeze(row));
        }
        if (!rows.length) await delay(idleMs, undefined, { signal });
      }
    } catch (error) {
      if (signal.aborted) return;
      // Closing sends every observer of this hub back to the database, where its own read reports the failure.
      warn("observer_hub_failed", { ...errorSummary(error), observers: hub.observers });
      this.#close(hub);
    }
  }

  #close(hub: Hub) {
    if (this.#hubs.get(hub.key) === hub) this.#hubs.delete(hub.key);
    hub.reader.abort();
    hub.stream.close();
  }
}
