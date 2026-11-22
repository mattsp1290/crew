import { execFile } from "node:child_process";
import { chmod, mkdir, rm, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

// A worker can leave a directory its host cannot list (mode 0300) or a tree deeper than PATH_MAX, which
// defeat Node's rm. GNU chmod and rm walk with descriptors; the worker has exited and could make no symlinks.
export async function removePrivate(directory: string) {
  try { await rm(directory, { recursive: true, force: true }); return; }
  catch { /* retried below */ }
  const run = promisify(execFile);
  await run("/bin/chmod", ["-R", "u+rwx", "--", directory]).catch(() => undefined);
  await run("/bin/rm", ["-rf", "--one-file-system", "--", directory]);
}

/** Replaces `root` with fresh 0700 directories: the root, then each named subdirectory. */
export async function preparePrivate(root: string, subdirectories: readonly string[] = []) {
  await removePrivate(root);
  for (const directory of [root, ...subdirectories.map((name) => join(root, name))]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
}

/** Removes `directory` again once `work` settles, for work that outlived its bound and may still write there.
 * Best-effort: it runs only while this runner process is alive. The runner exits right after its reply,
 * so a close or process that settles later is cleaned up by the next preparePrivate of that root. */
export function sweepWhenSettled(work: PromiseLike<unknown>, directory: string) {
  const sweep = () => removePrivate(directory).catch(() => undefined);
  void Promise.resolve(work).then(sweep, sweep);
}


/** Persist the unlink before recording a durable cross-store cleanup acknowledgement. */
export async function removePrivateDurably(directory: string) {
  await removePrivate(directory);
  let parent=dirname(directory);
  for(;;){
    try {
      const handle=await open(parent,"r");
      try {await handle.sync();} finally {await handle.close();}
      return;
    } catch(error) {
      if(!(error instanceof Error && "code" in error && error.code==="ENOENT") || dirname(parent)===parent)throw error;
      parent=dirname(parent);
    }
  }
}
