import { execFile } from "node:child_process";
import { chmod, mkdir, rm, open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

// A worker can leave a directory its host cannot list (mode 0300) or a tree deeper than PATH_MAX, which
// defeat Node's rm. GNU chmod and rm walk with descriptors; the worker has exited and could make no symlinks.
export async function removePrivate(directory: string) {
  try {
    await rm(directory, { recursive: true, force: true });
    return;
  } catch {
    /* retried below */
  }
  const run = promisify(execFile);
  await run("/bin/chmod", ["-R", "u+rwx", "--", directory]).catch(
    () => undefined,
  );
  await run("/bin/rm", ["-rf", "--one-file-system", "--", directory]);
}

/** Replaces `root` with fresh 0700 directories: the root, then each named subdirectory. */
export async function preparePrivate(
  root: string,
  subdirectories: readonly string[] = [],
) {
  await removePrivate(root);
  for (const directory of [
    root,
    ...subdirectories.map((name) => join(root, name)),
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
}

/** Removes `directory` again once `work` settles, for work that outlived its bound and may still write there.
 * Best-effort: it runs only while this runner process is alive. The runner exits right after its reply,
 * so a close or process that settles later is cleaned up by the next preparePrivate of that root. */
export function sweepWhenSettled(
  work: PromiseLike<unknown>,
  directory: string,
) {
  const sweep = () => removePrivate(directory).catch(() => undefined);
  void Promise.resolve(work).then(sweep, sweep);
}

/** Persist directory entries on this volume before exposing a filesystem identity. */
export async function syncDirectoryAncestors(directory: string) {
  let handle = await open(directory, "r");
  try {
    const device = (await handle.stat({ bigint: true })).dev;
    for (;;) {
      const current = await handle.stat({ bigint: true });
      await handle.sync();
      const parent = await open(`/proc/${process.pid}/fd/${handle.fd}/..`, "r");
      let info;
      try { info = await parent.stat({ bigint: true }); }
      catch (error) { await parent.close(); throw error; }
      if (info.dev !== device || info.ino === current.ino) {
        await parent.close();
        return;
      }
      const previous = handle;
      handle = parent;
      await previous.close();
    }
  } finally { await handle.close(); }
}
/** Pin the deletion parent so unlink and fsync cannot target different directories. */
export async function removePrivateDurably(directory: string) {
  let parent = dirname(directory);
  for (;;) {
    try {
      const handle = await open(parent, "r");
      try {
        const pinned = `/proc/${process.pid}/fd/${handle.fd}`;
        if (parent === dirname(directory)) await removePrivate(join(pinned, basename(directory)));
        // If a parent is already absent, persisting its surviving ancestor proves
        // the old subtree cannot return after an unlink-before-ack interruption.
        await syncDirectoryAncestors(pinned);
        return;
      } finally { await handle.close(); }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || dirname(parent) === parent) throw error;
      parent = dirname(parent);
    }
  }
}
