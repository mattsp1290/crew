import { createHash } from "node:crypto";
import { MemberStoreError } from "./domain.ts";

export type ItemReceipt = { bytes: number; digest: Buffer };

export function matchesNativeReply(reply: string, receipts: (ItemReceipt & { ordinal: number })[]) {
  const raw = Buffer.from(reply);
  let offset = 0;
  for (const [ordinal, { bytes, digest, ordinal: stored }] of receipts.entries()) {
    if (ordinal !== stored) return false;
    const item = raw.subarray(offset, offset + bytes);
    if (item.length !== bytes || !createHash("sha256").update(item).digest().equals(digest)) return false;
    offset += bytes;
  }
  return offset === raw.length;
}

function redactCompletedItems(items: string[], ids: Set<string>, final: boolean) {
  const joined = items.join("");
  const hidden = new Uint8Array(joined.length);
  let complete = joined.length;
  for (const id of ids) {
    for (let at = joined.indexOf(id); at >= 0; at = joined.indexOf(id, at + 1)) {
      hidden.fill(1, at, at + id.length);
    }
    if (final) continue;
    // The next item may finish a private ID. Wait to publish the item containing its prefix.
    for (let n = Math.min(id.length - 1, joined.length); n > 0; n--) {
      if (joined.endsWith(id.slice(0, n))) {
        complete = Math.min(complete, joined.length - n);
        break;
      }
    }
  }
  const visible: string[] = [];
  let offset = 0;
  for (const item of items) {
    const end = offset + item.length;
    if (end > complete) break;
    let text = "";
    for (let pos = offset; pos < end; pos++) {
      if (!hidden[pos]) text += joined[pos];
      else if (pos === offset || !hidden[pos - 1]) text += "[tool call]";
    }
    visible.push(text);
    offset = end;
  }
  return visible;
}

// SDK item events and the live MCP callback arrive on separate transports.
export function codexItemWriter(knownIds: string[], awaitingCall: boolean,
  publish: (index: number, text: string, receipt: ItemReceipt) => Promise<void>) {
  const ids = new Set(knownIds);
  const items: string[] = [];
  let next = 0;
  let pending = Promise.resolve();
  function flush(final: boolean) {
    pending = pending.then(async () => {
      if (awaitingCall && !final) return;
      const visible = redactCompletedItems(items, ids, final);
      while (next < visible.length) {
        const raw = Buffer.from(items[next]);
        await publish(next, visible[next], {bytes:raw.length, digest:createHash("sha256").update(raw).digest()});
        next++;
      }
    });
    return pending;
  }
  return {
    append(text: string) {
      if (items.length >= 128) throw new MemberStoreError("input_limit");
      items.push(text);
      return flush(false);
    },
    disclose(...names: string[]) {
      for (const name of names) ids.add(name);
      awaitingCall = false;
      return flush(false);
    },
    finish() { return flush(true); },
  };
}
