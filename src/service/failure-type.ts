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

/** The non-retryable Temporal types a text-engine admission refusal carries. They are workflow history:
 * keep them stable. TextAdmissionError maps each to its store code. */
export const textAdmissionFailureTypes = ["input_limit", "prompt_rejected"] as const;
export type TextAdmissionFailureType = (typeof textAdmissionFailureTypes)[number];

/** The text-engine admission refusal type in `error`'s cause chain, if any. */
export function textAdmissionFailure(error: unknown): TextAdmissionFailureType | undefined {
  return textAdmissionFailureTypes.find((type) => hasFailureType(error, type));
}
