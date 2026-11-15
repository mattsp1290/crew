import type {
  FramePoint, GlobalPoint, OperationId, FrameId, PointerCompletion, KeyboardCompletion,
  ToolError, OperationRecord, ScreenshotObservation, LeaseOutcome, ResultBoundary,
} from '../../src/service/deskhand/contract.ts';

function inspectPointer(value: PointerCompletion) {
  const global: GlobalPoint = value.measured.globalPoint;
  if (value.measured.kind === 'drag') {
    const end: GlobalPoint = value.measured.end.globalPoint;
    const identity: string = value.measured.end.target.bundleId;
    void [end, identity];
  }
  void global;
}
function inspectKeyboard(value: KeyboardCompletion) {
  const point: null = value.measured.globalPoint;
  const app: string = value.measured.target.bundleId;
  void [point, app];
}
function inspectErrors(pointer: ToolError<'pointer'>, keyboard: ToolError<'keyboard'>, screenshot: ToolError<'screenshot'>) {
  if (pointer.code === 'rate_limited') { const retry: number = pointer.retryAfterMs; void retry; }
  if (pointer.code === 'stale_frame' && pointer.details.reason === 'pixels_changed') { const index: number = pointer.details.pointIndex; void index; }
  if (pointer.code === 'out_of_frame') { const width: number = pointer.details.outputPixels.width; void width; }
  if (keyboard.code === 'interrupted') {
    const lower: OperationRecord = keyboard.operation.value;
    const operation: OperationId = keyboard.reportedOperationId.value;
    const state: string = keyboard.evidence.currentState;
    const absent: 'absent' = keyboard.measured.kind;
    void [lower, operation, state, absent];
  }
  if (keyboard.code === 'log_unavailable') { const point: null = keyboard.measured.value.globalPoint; void point; }
  if (screenshot.code === 'image_too_large') { const bytes: number = screenshot.details.imageBytes; void bytes; }
}
function inspectRecord(record: OperationRecord) {
  if (record.kind === 'ended-by-restart') { const precision: 'lower-bound' = record.events.kind; void precision; }
  else { const precision: 'exact' = record.events.kind; void precision; }
}
function inspectScreenshot(screenshot: ScreenshotObservation) {
  if (screenshot.metadata.encoding.kind === 'jpeg') { const quality: number = screenshot.metadata.encoding.quality; void quality; }
  const pointer: FramePoint | null = screenshot.metadata.pointer;
  const frameId: FrameId = screenshot.metadata.frameId;
  void [pointer, frameId];
}
function inspectLease(lease: LeaseOutcome, boundary: ResultBoundary) {
  if (lease.kind === 'held') { const expiry: number = lease.lease.expiresInMs; void expiry; }
  boundary.lease(undefined, { requestId: 'r', operation: 'release' });
}
void [inspectPointer, inspectKeyboard, inspectErrors, inspectRecord, inspectScreenshot, inspectLease];
