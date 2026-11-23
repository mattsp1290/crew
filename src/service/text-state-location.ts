import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  stat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
  access,
  open,
} from "node:fs/promises";
import { dirname, relative, isAbsolute, join, sep } from "node:path";
import type { PoolClient } from "pg";
import { z } from "zod";
import {
  conversationKey,
  isTextEngine,
  MemberStoreError,
  type Conversation,
  type TextEngine,
} from "./domain.ts";
import { syncDirectoryAncestors } from "./private-directory.ts";
import { assertContentWritable } from "./content-erasure-store.ts";

export function textTurnRootPath(
  stateDir: string,
  member: Conversation,
  engine: TextEngine,
) {
  return textVolumeRootPath(join(stateDir, engine), member, engine);
}
export function textVolumeRootPath(directory: string, member: Conversation, engine: TextEngine) {
  conversationKey.parse({ ownerId: member.ownerId, conversationId: member.conversationId });
  z.uuid().parse(member.memberId);
  if (!isAbsolute(directory) || member.engine !== engine) throw new MemberStoreError("conflict");
  return join(directory, createHash("sha256").update(member.ownerId).digest("hex"), member.memberId, member.conversationId);
}
async function readVolumeMarker(directory: string, engine: TextEngine) {
  const path = join(directory, ".birbcrew-text-volume"), marker = await lstat(path);
  if (!marker.isFile() || marker.isSymbolicLink()) throw new MemberStoreError("content_location_unknown");
  await syncDirectoryAncestors(directory);
  return { locationId: z.uuid().parse(await readFile(path, "utf8")), engine };
}
/** Keep the verified filesystem alive across SQL waits, renames and replacement mounts. */
export async function pinTextStateLocation(stateDir: string, engine: TextEngine) {
  const handle = await open(join(stateDir, engine), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const directory = `/proc/${process.pid}/fd/${handle.fd}`;
  try {
    return { ...await readVolumeMarker(directory, engine), directory, close: () => handle.close() };
  } catch(error) { await handle.close(); throw error; }
}

export type TextVolumeLocation = Omit<Awaited<ReturnType<typeof pinTextStateLocation>>, "close">;
export type TextStateRoot = string | Pick<TextVolumeLocation, "directory" | "engine">;

export async function textStateLocation(stateDir: string, engine: TextEngine) {
  if (!isAbsolute(stateDir))
    throw new MemberStoreError("content_location_unknown");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const base = await realpath(stateDir);
  const directory = join(stateDir, engine);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (
    (await lstat(directory)).isSymbolicLink() ||
    (await realpath(directory)) !== join(base, engine)
  )
    throw new MemberStoreError("content_location_unknown");
  const path = join(directory, ".birbcrew-text-volume");
  try { return await readVolumeMarker(directory, engine); }
  catch(error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const id = randomUUID(),
    staged = join(directory, ".volume-" + id);
  await writeFile(staged, id, { flag: "wx", mode: 0o600, flush: true });
  try {
    await link(staged, path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  } finally {
    await rm(staged);
  }
  // A concurrent initializer also syncs the winner's published entry.
  return readVolumeMarker(directory, engine);
}
export async function registerTextLaunch(
  db: PoolClient,
  member: Conversation,
  key: { requestId: string; token: string },
  locationId: string,
) {
  if (!isTextEngine(member.engine))
    throw new MemberStoreError("content_erasure_unsupported");
  await assertContentWritable(db, member);
  const {
    rows: [location],
  } = await db.query<{ engine: string }>(
    "SELECT engine FROM birbcrew_ts.text_state_locations WHERE location_id=$1",
    [locationId],
  );
  if (location?.engine !== member.engine)
    throw new MemberStoreError("content_location_unknown");
  await db.query(
    "INSERT INTO birbcrew_ts.text_conversation_locations(conversation_id,location_id,profile) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
    [member.conversationId, locationId, member.profile],
  );
  await db.query(
    "INSERT INTO birbcrew_ts.text_runtime_cleanup_proofs(conversation_id,request_id,token,location_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    [member.conversationId, key.requestId, key.token, locationId],
  );
}
/** Check every existing parent without following symlinks into an unrelated volume. */
export async function assertTextVolumeRoot(volume: string, member: Conversation, engine: TextEngine) {
  const root = textVolumeRootPath(volume, member, engine);
  const canonicalVolume = await realpath(volume);
  const canonicalRoot = textVolumeRootPath(canonicalVolume, member, engine);
  // Mounts can cross a location boundary without being symlinks, including bind mounts.
  // Inspect the namespace before chmod/removal, even for roots we cannot list.
  const mounts = await readFile("/proc/self/mountinfo", "utf8");
  for (const line of mounts.trim().split("\n")) {
    const encoded = line.split(" ")[4];
    if (!encoded) throw new MemberStoreError("content_location_unknown");
    const mount = encoded.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    if (mount.startsWith(canonicalVolume + sep) && (mount === canonicalRoot || mount.startsWith(canonicalRoot + sep) || canonicalRoot.startsWith(mount + sep)))
      throw new MemberStoreError("content_location_unknown");
  }
  let directory = volume;
  for (const part of root.slice(directory.length + 1).split(sep)) {
    directory = join(directory, part);
    try {
      if ((await lstat(directory)).isSymbolicLink())
        throw new MemberStoreError("content_location_unknown");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
  }
  return root;
}
/** Pin before validation, then refuse a changed namespace binding before acknowledgement. */
export async function pinTextCleanupRoot(volume: string, member: Conversation, engine: TextEngine) {
  const original = textVolumeRootPath(volume, member, engine);
  let parent = dirname(original);
  let handle;
  for (;;) {
    try { handle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | (parent === volume ? 0 : constants.O_NOFOLLOW)); break; }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || parent === volume) throw error;
      parent = dirname(parent);
    }
  }
  try {
    const identity = await handle.stat({bigint:true});
    const verify = async () => {
      const current = await (parent === volume ? stat(parent, {bigint:true}) : lstat(parent, {bigint:true}));
      if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) throw new MemberStoreError("content_location_unknown");
    };
    await assertTextVolumeRoot(volume, member, engine);
    await verify();
    return {root: join(`/proc/${process.pid}/fd/${handle.fd}`, relative(parent, original)), original, verify, close: () => handle.close()};
  } catch (error) { await handle.close(); throw error; }
}
export async function rootAbsent(root: string) {
  try {
    await access(root);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return true;
    throw error;
  }
}
