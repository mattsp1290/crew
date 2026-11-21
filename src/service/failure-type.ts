import { ApplicationFailure } from "@temporalio/common";

/** True when `error` or any error in its cause chain is an ApplicationFailure of `type`.
 * Shared by MemberClient and the workflow, so it stays free of Node and I/O imports. */
export function hasFailureType(error: unknown, type: string): boolean {
  const seen = new Set<unknown>();
  for (let cause: unknown = error; cause instanceof Error && !seen.has(cause); cause = cause.cause) {
    seen.add(cause);
    if (cause instanceof ApplicationFailure && cause.type === type) return true;
  }
  return false;
}
