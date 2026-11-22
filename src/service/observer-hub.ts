import { MemberStoreError } from "./domain.ts";
import { setTimeout as delay } from "node:timers/promises";
import { createEventStream, type EventStream, type SubscriptionEnd } from "@mattsp1290/switchboard";
import type { Pool } from "pg";
import { errorSummary, warn } from "./diagnostics.ts";
import { readEvents, readEventsIdleMs, readEventsLimit, type ObservedRow } from "./observation.ts";

// The gateway's observer fan-out. One reader per (owner, conversation) polls the owner-scoped public event
// ledger as every observer used to, and publishes each committed row to the observers of that hub. PostgreSQL
// stays the authority: an observer takes its snapshot and cursor from the database, reads the database itself
// for anything before the hub's position, and goes back to reading the database itself whenever its hub
// subscription ends. Workflow code must not import this module (it loads Switchboard, which loads node:fs).

export interface FanoutBounds {
  /** Observers one conversation's hub admits; later ones read the database themselves. */
  readonly maxObservers: number;
  /** Rows queued for one observer, counting the one it is sending. One more ends its subscription. */
  readonly capacity: number;
}

// One read's rows (readEventsLimit, 32) are published together, so an observer that keeps up never holds more.
// 64 lets a briefly slow client fall two reads behind before it overflows and continues from the database,
// which keeps the last 256 frames. Capacity is also the hub's memory bound: rows are shared by reference, and a
// MESSAGES_SNAPSHOT row carries the whole message history, so a client that stops reading keeps up to 64 rows
// alive until it overflows or leaves. A polling observer kept one read, up to 32 rows, of its own.
const defaultFanoutBounds: FanoutBounds = { maxObservers: 64, capacity: 64 };

/** Whether the gateway fans out when BIRBCREW_OBSERVER_FANOUT is unset. */
const fanoutByDefault = true;

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
  /** Leaves because the database could not supply a row the hub published; counted and logged as a fallback. */
  abandon(): void;
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
  /** When this hub last logged that it was full: at most once a minute, not once per refused connection. */
  fullReportedAt: number;
}

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

/**
 * One subscriber's rows, pulled one at a time. The stream's call for a row stays pending until the consumer asks
 * for the next one, so the stream's capacity measures how far this consumer lags. Undefined when the stream
 * admits no more subscribers. `onEnd` runs once the subscription has ended and its pending call is settled.
 */
function pull<T>(stream: EventStream<T>, signal: AbortSignal, onEnd: (reason: SubscriptionEnd) => void) {
  // The row the stream is delivering, and the one the consumer is sending.
  let offered: { row: T; sent: () => void } | undefined;
  let sending: (() => void) | undefined;
  let wake: (() => void) | undefined;
  let ended = false;
  const subscribed = stream.subscribe((row) => new Promise<void>((sent) => {
    offered = { row, sent };
    wake?.();
  }), { signal });
  if (subscribed.kind === "error") return undefined;
  const subscription = subscribed.value;
  void subscription.ended.then((reason) => {
    try {
      ended = true;
      // Settles the pending listener call, so the stream releases this subscriber's lease.
      offered?.sent();
      sending?.();
      offered = sending = undefined;
      wake?.();
    } finally {
      onEnd(reason);
    }
  });
  async function next(): Promise<T | undefined> {
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
  }
  return { next, dispose: () => subscription.dispose() };
}

type Fallback = "overflow" | "listener-error" | "gap" | "closed";

/**
 * Why an observer whose subscription ended must read the database itself, or undefined when it simply left.
 * `gone` is true when the gateway is closing or the observer disconnected.
 */
function fallbackOf(reason: SubscriptionEnd, abandoned: boolean, gone: boolean): Fallback | undefined {
  switch (reason) {
    // The subscription's own reason decides: an abandon() that lost a race with overflow stays an overflow.
    case "overflow":
    case "listener-error": return reason;
    // abandon() disposes too, when the database could not supply a row the hub published.
    case "disposed": return abandoned ? "gap" : undefined;
    // A failed hub read closes the stream; so do shutdown and the observer's disconnect, which send nobody back.
    case "closed": return gone ? undefined : "closed";
    case "aborted": return undefined;
    default:
      reason satisfies never;
      return undefined;
  }
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
    // Below one read's rows, even an observer that keeps up would overflow on every full read.
    if (!(this.#bounds.capacity >= readEventsLimit)) throw new RangeError(`Observer capacity must be at least ${readEventsLimit} rows`);
    createEventStream(this.#bounds).close(); // Invalid bounds throw here, not on the first observer.
  }

  /** Open hubs, attached observers, and observers sent back to the database (overflow, full hub, failed read, gap). */
  stats() {
    return { hubs: this.#hubs.size, observers: this.#observers, fallbacks: this.#fallbacks };
  }

  /**
   * The committed rows after `cursor` for an observer the caller has already authorised (as for attach), in cursor
   * order: the database's own rows up to its hub's position, then the hub's. The consumer accepts each row before
   * asking for the next, or stops. The rows end when the observer must read the database itself from the last
   * row it accepted: no hub would take it, its subscription ended, or the database could not supply a row the hub
   * published.
   */
  async *rows(owner: string, conversationId: string, cursor: number, signal: AbortSignal): AsyncGenerator<ObservedRow, void, undefined> {
    const feed = this.attach(owner, conversationId, cursor, signal);
    if (!feed) return;
    const pool = this.#pool;
    // The observer's own reads up to `target`, a cursor its hub has already published. They stop early when the
    // database has no more rows to give.
    async function* fromDatabase(target: number) {
      while (cursor < target) {
        const rows = await readEvents(pool, owner, conversationId, cursor);
        if (!rows.length) return;
        for (const row of rows) {
          yield row;
          cursor = row.cursor;
        }
      }
    }
    try {
      yield* fromDatabase(feed.from);
      for (let row = await feed.next(); row; row = await feed.next()) {
        if (row.cursor > cursor + 1) yield* fromDatabase(row.cursor - 1);
        if (row.cursor <= cursor) continue;
        if (row.cursor !== cursor + 1) {
          // The database could not supply what the hub published, so the database alone decides from here.
          feed.abandon();
          return;
        }
        yield row;
        cursor = row.cursor;
      }
    } finally {
      feed.dispose();
    }
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
    let abandoned = false;
    const subscriber = pull(hub.stream, signal, (reason) => {
      try {
        const fallback = fallbackOf(reason, abandoned, this.#closed || signal.aborted);
        if (fallback) this.#fallbacks++;
        // A failed read is logged once for its hub, as observer_hub_failed.
        if (fallback && fallback !== "closed") warn("observer_fallback", { reason: fallback, capacity: this.#bounds.capacity });
      } finally {
        hub.observers--;
        this.#observers--;
        if (!hub.observers) this.#close(hub);
      }
    });
    if (!subscriber) {
      this.#fallbacks++;
      if (Date.now() - hub.fullReportedAt >= 60_000) {
        hub.fullReportedAt = Date.now();
        warn("observer_hub_full", { maxObservers: this.#bounds.maxObservers });
      }
      if (!hub.observers) this.#close(hub);
      return undefined;
    }
    hub.observers++;
    this.#observers++;
    return {
      from,
      next: subscriber.next,
      abandon() {
        abandoned = true;
        subscriber.dispose();
      },
      dispose: subscriber.dispose,
    };
  }

  invalidate(owner:string,conversationId:string) {
    const hub=this.#hubs.get(JSON.stringify([owner,conversationId]));
    if (hub) this.#close(hub);
  }
  /** Stops every reader. Observers still attached end with their subscription and read the database themselves. */
  close() {
    this.#closed = true;
    for (const hub of [...this.#hubs.values()]) this.#close(hub);
  }

  #open(key: string, owner: string, conversationId: string, cursor: number): Hub {
    const hub: Hub = { key, stream: createEventStream(this.#bounds), reader: new AbortController(), cursor, observers: 0,
      fullReportedAt: -Infinity };
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
        if (!rows.length) await delay(readEventsIdleMs, undefined, { signal });
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof MemberStoreError && error.code === "conversation_erased") { this.#close(hub); return; }
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
