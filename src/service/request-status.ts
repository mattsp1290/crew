/** The public receipt classifier. Raw uncertainty is checked independently for erasure. */
export function requestStatusFromRow(row: {
  phase: string | null;
  admission: string | null;
  reason: string | null;
  receipt_id?: string | null;
  waiting?: boolean;
}) {
  return row.phase === "committed"
    ? "completed"
    : row.admission === "rejected"
      ? row.reason === "predecessor_cancelled"
        ? "cancelled"
        : "failed"
      : row.phase === "uncertain"
        ? "uncertain"
        : row.receipt_id
          ? "cancellation_requested"
          : row.waiting
            ? "waiting"
            : row.phase === "started"
              ? "running"
              : "accepted";
}
