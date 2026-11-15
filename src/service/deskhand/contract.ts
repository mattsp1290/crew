import { readFileSync, readdirSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { fullFormats } from 'ajv-formats/dist/formats.js';
import { sameJsonValue } from '../json-values.ts';
import * as vocabulary from './vocabulary.generated.ts';
import { parseJsonRejectingDuplicateKeys } from './strict-json.ts';

type Member<T extends readonly unknown[]> = T[number];
export type ToolName = Member<typeof vocabulary.toolNames>;
type ErrorCode = Member<typeof vocabulary.errorCodes>;
type ToolCode<T extends ToolName> = Member<typeof vocabulary.errorsByTool[T]>;
type State = Member<typeof vocabulary.states>;
type StaleReason = Member<typeof vocabulary.staleReasons>;
type OperationStatus = Member<typeof vocabulary.operationStatuses>;
export type LeaseOperation = Member<typeof vocabulary.leaseOperations>;
export type Presence<T> = Readonly<{ kind: 'absent' }> | Readonly<{ kind: 'present'; value: T }>;
type Present<T> = Extract<Presence<T>, { kind: 'present' }>;
export type HolderId = string & { readonly __brand: 'DeskhandHolderId' };
export type OperationId = string & { readonly __brand: 'DeskhandOperationId' };
export type FrameId = string & { readonly __brand: 'DeskhandFrameId' };
export type DisplayId = number & { readonly __brand: 'DeskhandDisplayId' };
export type Sha256 = string & { readonly __brand: 'DeskhandSha256' };
export type EndpointIdentity = string & { readonly __brand: 'DeskhandEndpointIdentity' };
export type FramePoint = Readonly<{ unit: 'frame-pixel'; x: number; y: number }>;
export type GlobalPoint = Readonly<{ unit: 'global-point'; x: number; y: number }>;
export type GlobalRect = GlobalPoint & Readonly<{ width: number; height: number }>;
export type PixelSize = Readonly<{ width: number; height: number }>;
export type AppIdentity = Readonly<{ bundleId: string | null; teamId: string | null; name: string }>;
export type IdentifiedApp = AppIdentity & Readonly<{ bundleId: string }>;
export type ExactEvents = Readonly<{ kind: 'exact'; value: number }>;
export type OperationRecord =
  | Readonly<{ kind: 'pending'; status: Extract<OperationStatus, 'accepted' | 'executing'>; events: ExactEvents }>
  | Readonly<{ kind: 'ended'; status: Extract<OperationStatus, 'completed' | 'aborted' | 'failed' | 'failed_before_execution'>; events: ExactEvents }>
  | Readonly<{ kind: 'ended-by-restart'; status: Extract<OperationStatus, 'aborted_by_restart'>; events: { readonly kind: 'lower-bound'; readonly value: number } }>;
export type CallerLease = Readonly<{ kind: 'not-held-by-caller' }> | Readonly<{
  kind: 'held-by-caller'; acquiredAt: string; expiresAt: string; expiresInMs: number;
}>;
export interface DesktopLimits {
  readonly maxLongEdge: number;
  readonly minLongEdge: number;
  readonly maxPixels: number;
  readonly maxImageBytes: number;
  readonly frameMaxAgeMs: number;
  readonly userActivityLookbackMs: number;
  readonly actionsPerMinute: number;
  readonly leaseTtlMinMs: number;
  readonly leaseTtlMaxMs: number;
  readonly keyboardMaxTextLength: number;
  readonly operationRetentionMs: number;
  readonly operationMaxRecords: number;
}
export interface DesktopStatus {
  readonly contractVersion: typeof vocabulary.contractVersion;
  readonly mcpProtocolVersion: typeof vocabulary.protocolVersion;
  readonly serverVersion: string;
  readonly mac: string;
  readonly time: string;
  readonly startedAt: string;
  readonly state: State;
  readonly activeStates: readonly Member<typeof vocabulary.blockingStates>[];
  readonly conditions: readonly Member<typeof vocabulary.conditions>[];
  readonly armedUntil: string | null;
  readonly lease: Readonly<{ kind: 'unscoped' }> | Readonly<{ kind: 'caller'; lease: CallerLease }>;
  readonly displayGeneration: number;
  readonly limits: DesktopLimits;
}
export interface LookupObservation {
  readonly status: DesktopStatus;
  readonly operationId: OperationId;
  readonly record: OperationRecord | Readonly<{ kind: 'not-recorded-now' }>;
}
export interface Display {
  readonly id: DisplayId;
  readonly uuid: string;
  readonly name: string;
  readonly isMain: boolean;
  readonly isBuiltin: boolean;
  readonly asleep: false;
  readonly bounds: GlobalRect;
  readonly pixels: PixelSize;
  readonly pointPixelScale: number;
}
export interface DisplayCatalog { readonly generation: number; readonly displays: readonly Display[] }
export type ReportedEncoding =
  | Readonly<{ kind: 'jpeg'; mime: typeof vocabulary.jpegMime; quality: Member<typeof vocabulary.jpegQualities>; bytes: number }>
  | Readonly<{ kind: 'png'; mime: typeof vocabulary.pngMime; bytes: number }>;
export interface ScreenshotMetadata {
  readonly frameId: FrameId;
  readonly sha256: Sha256;
  readonly displayId: DisplayId;
  readonly displayGeneration: number;
  readonly capture: GlobalRect;
  readonly sourcePixels: PixelSize;
  readonly outputPixels: PixelSize;
  readonly pointPixelScale: number;
  readonly downscale: number;
  readonly encoding: ReportedEncoding;
  readonly capturedAt: string;
  readonly maxAgeMs: number;
  readonly pointer: FramePoint | null;
  readonly frontmost: AppIdentity;
}
export type ScreenshotObservation = Readonly<{ kind: 'metadata-only'; metadata: ScreenshotMetadata }>;
interface MeasurementFacts {
  readonly frontmost: AppIdentity;
  readonly target: AppIdentity | null;
  readonly windowTitle: string | null;
  readonly measuredAt: string;
}
interface SuccessMeasurement extends MeasurementFacts { readonly frontmost: IdentifiedApp; readonly target: IdentifiedApp }
interface DragEnd { readonly target: AppIdentity; readonly windowTitle: string | null; readonly globalPoint: GlobalPoint }
export type PointerMeasurement = SuccessMeasurement & Readonly<{ globalPoint: GlobalPoint }> & (
  Readonly<{ kind: 'target' }> | Readonly<{ kind: 'drag'; end: DragEnd & { readonly target: IdentifiedApp } }>
);
export type KeyboardMeasurement = SuccessMeasurement & Readonly<{ kind: 'keyboard'; globalPoint: null; end?: never }>;
export type PointerErrorMeasurement = MeasurementFacts & Readonly<{ globalPoint: GlobalPoint | null; end: Presence<DragEnd> }>;
export type KeyboardErrorMeasurement = MeasurementFacts & Readonly<{ globalPoint: null; end?: never }>;
type ErrorMeasurement<T extends ToolName> = T extends 'pointer' ? PointerErrorMeasurement : T extends 'keyboard' ? KeyboardErrorMeasurement : never;
interface CompletionFacts {
  readonly operationId: OperationId;
  readonly frameId: FrameId;
  readonly status: typeof vocabulary.completedStatus;
  readonly events: ExactEvents;
  readonly replayed: boolean;
  readonly completedAt: string;
}
export type PointerCompletion = CompletionFacts & Readonly<{ measured: PointerMeasurement }>;
export type KeyboardCompletion = CompletionFacts & Readonly<{ measured: KeyboardMeasurement }>;
export type ReturnEvidence =
  | Readonly<{ kind: 'not-admitted'; state: State }>
  | Readonly<{ kind: 'first-admission'; state: State }>
  | Readonly<{ kind: 'replay'; originalState: State; currentState: State }>;
export interface KnownDiagnostics {
  readonly reason?: StaleReason;
  readonly argument?: string;
  readonly pointIndex?: number;
  readonly outputPixels?: PixelSize;
  readonly imageBytes?: number;
  readonly maxImageBytes?: number;
  readonly idleMs?: number;
  readonly deniedBy?: Member<typeof vocabulary.deniedBy>;
  readonly shortcut?: string;
  readonly otherLeaseExpiresInMs?: number;
}
type RequiredDiagnostic<K extends keyof KnownDiagnostics> = KnownDiagnostics & Required<Pick<KnownDiagnostics, K>>;
interface DetailsByCode {
  readonly stale_frame: RequiredDiagnostic<'reason'> & (
    Readonly<{ reason: Exclude<StaleReason, 'pixels_changed'> }> |
    Readonly<{ reason: 'pixels_changed'; pointIndex: number }>
  );
  readonly invalid_argument: RequiredDiagnostic<'argument'>;
  readonly out_of_frame: RequiredDiagnostic<'pointIndex' | 'outputPixels'>;
  readonly image_too_large: RequiredDiagnostic<'imageBytes' | 'maxImageBytes'>;
  readonly user_active: RequiredDiagnostic<'idleMs'>;
  readonly denied_app: RequiredDiagnostic<'deniedBy'>;
  readonly denied_shortcut: RequiredDiagnostic<'shortcut'>;
  readonly lease_held_by_other: RequiredDiagnostic<'otherLeaseExpiresInMs'>;
}
interface CommonErrorFacts {
  readonly message: string;
  readonly reportedOperationId: Presence<OperationId>;
  readonly operation: Presence<OperationRecord>;
  readonly evidence: ReturnEvidence;
}
type ErrorVariant<C extends ErrorCode, M> = CommonErrorFacts & Readonly<{ code: C }> &
  (C extends 'operation_in_progress' | 'operation_id_conflict' | 'interrupted' | 'cancelled' ? Readonly<{
    reportedOperationId: Present<OperationId>; operation: Present<OperationRecord>;
  }> : unknown) &
  (C extends 'interrupted' | 'cancelled' ? Readonly<{ evidence: Extract<ReturnEvidence, { kind: 'replay' }> }> : unknown) &
  (C extends 'interrupted' ? Readonly<{ measured: { readonly kind: 'absent' } }> :
    C extends 'denied_app' | 'log_unavailable' ? Readonly<{ measured: Present<M> }> : Readonly<{ measured: Presence<M> }>) &
  (C extends 'rate_limited' ? Readonly<{ retryAfterMs: number }> : Readonly<{ retryAfterMs: Presence<number> }>) &
  (C extends keyof DetailsByCode ? Readonly<{ details: DetailsByCode[C] }> : Readonly<{ details?: never }>);
type ErrorVariants<M> = { [C in ErrorCode]: ErrorVariant<C, M> }[ErrorCode];
export type ToolError<T extends ToolName> = ErrorVariants<ErrorMeasurement<T>> & Readonly<{ tool: T; code: ToolCode<T> }>;
export type LeaseOutcome =
  | Readonly<{ kind: 'held'; operation: Exclude<LeaseOperation, typeof vocabulary.releaseOperation>; outcome: Extract<Member<typeof vocabulary.leaseOutcomes>, 'acquired' | 'renewed'>; lease: Extract<CallerLease, { kind: 'held-by-caller' }> }>
  | Readonly<{ kind: 'released' | 'not-held'; operation: typeof vocabulary.releaseOperation; lease: Extract<CallerLease, { kind: 'not-held-by-caller' }> }>
  | Readonly<{ kind: 'refused'; operation: LeaseOperation; refusal: LeaseRefusal; lease: Extract<CallerLease, { kind: 'not-held-by-caller' }> }>;
type LeaseRefusal = Readonly<{ code: 'lease_held_by_other'; otherExpiresInMs: number }> |
  Readonly<{ code: Exclude<Member<typeof vocabulary.leaseRefusals>, 'lease_held_by_other'> }>;
export interface BoundaryContext { readonly endpoint: EndpointIdentity; readonly holderId: HolderId; readonly expectedMac: string }
export interface ExpectedReply { readonly requestId: string | number }
export interface ObservedFrameContext {
  readonly endpoint: EndpointIdentity; readonly holderId: HolderId; readonly displayId: DisplayId; readonly frameId: FrameId;
}
export interface ExpectedKeyboard { readonly operationId: OperationId; readonly frame: ObservedFrameContext }
export type ExpectedPointer = ExpectedKeyboard & Readonly<{ action: 'drag' | 'target' }>;
export type ContractFault = Readonly<{
  kind: 'contract'; reason: 'rpc' | 'schema' | 'correlation' | 'content' | 'projection' | 'image-metadata';
  stage: 'envelope' | 'tool' | 'relationship' | 'construction';
}>;
type Rejected = Readonly<{ kind: 'rejected'; failure: ContractFault }>;
type RpcError = Readonly<{ kind: 'rpc-error'; code: Member<typeof vocabulary.rpcErrors> }>;
export type Accepted<T, Tool extends ToolName> = Readonly<{ kind: 'ok'; value: T }> |
  Readonly<{ kind: 'tool-error'; error: ToolError<Tool> }> | Rejected | RpcError;
export interface ResultBoundary {
  status(raw: unknown, expected: ExpectedReply & { readonly holder: 'configured-holder' | 'no-holder' }): Accepted<DesktopStatus, 'status'>;
  lookup(raw: unknown, expected: ExpectedReply & { readonly operationId: OperationId }): Accepted<LookupObservation, 'status'>;
  displays(raw: unknown, expected: ExpectedReply): Accepted<DisplayCatalog, 'displays'>;
  screenshot(raw: unknown, expected: ExpectedReply & { readonly displayId: Presence<DisplayId> }): Accepted<ScreenshotObservation, 'screenshot'>;
  lease(raw: unknown, expected: ExpectedReply & { readonly operation: LeaseOperation }): Accepted<LeaseOutcome, 'lease'>;
  pointer(raw: unknown, expected: ExpectedReply & ExpectedPointer): Accepted<PointerCompletion, 'pointer'>;
  keyboard(raw: unknown, expected: ExpectedReply & ExpectedKeyboard): Accepted<KeyboardCompletion, 'keyboard'>;
}

const schemaRoot = new URL('../../../vendor/deskhand/contract-v0.11-draft/docs/schemas/', import.meta.url);
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictTuples: false,
  strictRequired: false, validateFormats: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
for (const [name, format] of Object.entries(fullFormats)) ajv.addFormat(name, format);
for (const directory of ['', 'tools/', 'wire/']) {
  for (const entry of readdirSync(new URL(directory, schemaRoot), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      const schema: unknown = JSON.parse(readFileSync(new URL(`${directory}${entry.name}`, schemaRoot), 'utf8'));
      if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('deskhand-schema');
      ajv.addSchema(schema);
    }
  }
}
function validates(path: string, value: unknown): boolean {
  const validate = ajv.getSchema(`https://deskhand.invalid/schemas/${path}`);
  if (!validate) throw new Error('deskhand-schema');
  return validate(value) === true;
}
class BoundaryFailure extends Error {
  readonly reason: ContractFault['reason'];
  readonly stage: ContractFault['stage'];
  constructor(reason: ContractFault['reason'], stage: ContractFault['stage']) {
    super('deskhand-boundary');
    this.reason = reason;
    this.stage = stage;
  }
}
function requireFact(condition: boolean, reason: ContractFault['reason'] = 'projection', stage: ContractFault['stage'] = 'construction'): asserts condition {
  if (!condition) throw new BoundaryFailure(reason, stage);
}
function safely<T>(read: () => T): T | Rejected {
  try { return read(); }
  catch (error) {
    return { kind: 'rejected', failure: { kind: 'contract', reason: error instanceof BoundaryFailure ? error.reason : 'projection', stage: error instanceof BoundaryFailure ? error.stage : 'construction' } };
  }
}
function object(value: unknown): Record<string, unknown> {
  requireFact(value !== null && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string { requireFact(typeof value === 'string'); return value; }
function number(value: unknown): number { requireFact(typeof value === 'number' && Number.isFinite(value)); return value; }
function boolean(value: unknown): boolean { requireFact(typeof value === 'boolean'); return value; }
function nullableString(value: unknown): string | null { return value === null ? null : string(value); }
function array(value: unknown): unknown[] { requireFact(Array.isArray(value)); return value; }
function literal<T extends string | number>(value: unknown, choices: readonly T[]): T {
  const found = choices.find((choice) => choice === value);
  requireFact(found !== undefined);
  return found;
}
function present<T>(value: T): Present<T> { return { kind: 'present', value }; }
function optional<T>(value: unknown, read: (value: unknown) => T): Presence<T> { return value === undefined ? { kind: 'absent' } : present(read(value)); }
function required<T>(value: Presence<T>): Present<T> { requireFact(value.kind === 'present'); return value; }
function isHolderId(value: unknown): value is HolderId { return typeof value === 'string' && validates('defs.json#/$defs/holder_id', value); }
function isOperationId(value: unknown): value is OperationId { return typeof value === 'string' && validates('defs.json#/$defs/operation_id', value); }
function isFrameId(value: unknown): value is FrameId { return typeof value === 'string' && validates('defs.json#/$defs/frame_id', value); }
function isDisplayId(value: unknown): value is DisplayId { return typeof value === 'number' && validates('defs.json#/$defs/display_id', value); }
function isSha256(value: unknown): value is Sha256 { return typeof value === 'string' && validates('defs.json#/$defs/sha256', value); }
function isEndpointIdentity(value: unknown): value is EndpointIdentity {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return url.protocol === 'https:' && url.href === value && !url.username && !url.password && !url.hash; }
  catch { return false; }
}
export function holderId(value: unknown): HolderId { requireFact(isHolderId(value)); return value; }
export function operationId(value: unknown): OperationId { requireFact(isOperationId(value)); return value; }
export function frameId(value: unknown): FrameId { requireFact(isFrameId(value)); return value; }
export function displayId(value: unknown): DisplayId { requireFact(isDisplayId(value)); return value; }
export function endpointIdentity(value: unknown): EndpointIdentity { requireFact(isEndpointIdentity(value)); return value; }
function sha256(value: unknown): Sha256 { requireFact(isSha256(value)); return value; }

function point(value: unknown): GlobalPoint {
  const wire = object(value);
  return { unit: 'global-point', x: number(wire.x), y: number(wire.y) };
}
function framePoint(value: unknown): FramePoint {
  const wire = object(value);
  return { unit: 'frame-pixel', x: number(wire.x), y: number(wire.y) };
}
function pixels(value: unknown): PixelSize {
  const wire = object(value);
  return { width: number(wire.width), height: number(wire.height) };
}
function rectangle(value: unknown): GlobalRect {
  const wire = object(value);
  return { ...point(wire), width: number(wire.width), height: number(wire.height) };
}
function app(value: unknown): AppIdentity {
  const wire = object(value);
  return { bundleId: nullableString(wire.bundle_id), teamId: nullableString(wire.team_id), name: string(wire.name) };
}
function identifiedApp(value: unknown): IdentifiedApp {
  const identity = app(value);
  requireFact(identity.bundleId !== null);
  return { ...identity, bundleId: identity.bundleId };
}
function callerLease(value: unknown): CallerLease {
  const wire = object(value);
  if (!boolean(wire.held_by_caller)) return { kind: 'not-held-by-caller' };
  return { kind: 'held-by-caller', acquiredAt: string(wire.acquired_at), expiresAt: string(wire.expires_at), expiresInMs: number(wire.expires_in_ms) };
}
function operationRecord(value: unknown): OperationRecord {
  const wire = object(value);
  const status = literal(wire.status, vocabulary.operationStatuses);
  const count = number(wire.events_posted);
  requireFact((status !== 'accepted' && status !== 'failed_before_execution') || count === 0, 'schema', 'relationship');
  switch (status) {
    case 'accepted': case 'executing': return { kind: 'pending', status, events: { kind: 'exact', value: count } };
    case 'completed': case 'aborted': case 'failed': case 'failed_before_execution':
      return { kind: 'ended', status, events: { kind: 'exact', value: count } };
    case 'aborted_by_restart': return { kind: 'ended-by-restart', status, events: { kind: 'lower-bound', value: count } };
    default: { const exhaustive: never = status; return exhaustive; }
  }
}
function desktopStatus(wire: Record<string, unknown>, context: BoundaryContext, holder: 'configured-holder' | 'no-holder'): DesktopStatus {
  requireFact(wire.mac === context.expectedMac, 'correlation', 'relationship');
  requireFact((wire.lease === null) === (holder === 'no-holder'), 'correlation', 'relationship');
  const limits = object(wire.limits);
  const activeStates = array(wire.active_states).map((state) => literal(state, vocabulary.blockingStates));
  const conditions = array(wire.conditions).map((condition) => literal(condition, vocabulary.conditions));
  const armedUntil = nullableString(wire.armed_until);
  const lease: DesktopStatus['lease'] = wire.lease === null ? { kind: 'unscoped' } : { kind: 'caller', lease: callerLease(wire.lease) };
  requireFact(activeStates.every((state, index) => index === 0 ||
    vocabulary.blockingStates.indexOf(activeStates[index - 1]) < vocabulary.blockingStates.indexOf(state)), 'schema', 'relationship');
  requireFact(!activeStates.includes('paused') || activeStates.includes('disarmed'), 'schema', 'relationship');
  requireFact(activeStates.includes('disarmed') === (armedUntil === null), 'schema', 'relationship');
  requireFact(!activeStates.some((state) => state === 'gated' || state === 'paused' || state === 'disarmed') ||
    lease.kind === 'unscoped' || lease.lease.kind === 'not-held-by-caller', 'schema', 'relationship');
  requireFact(!conditions.includes('login_window') || activeStates.includes('not_console'), 'schema', 'relationship');
  return {
    contractVersion: literal(wire.contract_version, [vocabulary.contractVersion]),
    mcpProtocolVersion: literal(wire.mcp_protocol_version, [vocabulary.protocolVersion]),
    serverVersion: string(wire.server_version), mac: string(wire.mac), time: string(wire.time), startedAt: string(wire.started_at),
    state: literal(wire.state, vocabulary.states),
    activeStates, conditions, armedUntil, lease,
    displayGeneration: number(wire.display_config_generation),
    limits: {
      maxLongEdge: number(limits.max_long_edge), minLongEdge: number(limits.min_long_edge), maxPixels: number(limits.max_pixels),
      maxImageBytes: number(limits.max_image_bytes), frameMaxAgeMs: number(limits.frame_max_age_ms),
      userActivityLookbackMs: number(limits.user_activity_lookback_ms), actionsPerMinute: number(limits.actions_per_minute),
      leaseTtlMinMs: number(limits.lease_ttl_min_ms), leaseTtlMaxMs: number(limits.lease_ttl_max_ms),
      keyboardMaxTextLength: number(limits.keyboard_max_text_length), operationRetentionMs: number(limits.operation_retention_ms),
      operationMaxRecords: number(limits.operation_max_records),
    },
  };
}
function displayCatalog(wire: Record<string, unknown>): DisplayCatalog {
  const displays = array(wire.displays).map((value): Display => {
    const display = object(value);
    const asleep = boolean(display.asleep);
    requireFact(asleep === false, 'schema', 'relationship');
    return { id: displayId(display.display_id), uuid: string(display.uuid), name: string(display.name),
      isMain: boolean(display.is_main), isBuiltin: boolean(display.is_builtin), asleep,
      bounds: rectangle(display.bounds), pixels: pixels(display.pixel_size), pointPixelScale: number(display.point_pixel_scale) };
  });
  requireFact(new Set(displays.map((display) => display.id)).size === displays.length, 'schema', 'relationship');
  return { generation: number(wire.display_config_generation), displays };
}
function screenshotObservation(wire: Record<string, unknown>, expectedDisplay: Presence<DisplayId>): ScreenshotObservation {
  const id = displayId(wire.display_id);
  requireFact(expectedDisplay.kind === 'absent' || expectedDisplay.value === id, 'correlation', 'relationship');
  const outputPixels = pixels(wire.output_pixel_size);
  const sourcePixels = pixels(wire.source_pixel_size);
  const downscale = number(wire.downscale);
  const pointer = wire.pointer_position === null ? null : framePoint(wire.pointer_position);
  requireFact(outputPixels.width * outputPixels.height <= vocabulary.maxPixels, 'image-metadata', 'relationship');
  requireFact(outputPixels.width <= sourcePixels.width && outputPixels.height <= sourcePixels.height, 'image-metadata', 'relationship');
  requireFact(downscale !== 1 || (outputPixels.width === sourcePixels.width && outputPixels.height === sourcePixels.height), 'image-metadata', 'relationship');
  requireFact(pointer === null || (pointer.x >= 0 && pointer.x < outputPixels.width &&
    pointer.y >= 0 && pointer.y < outputPixels.height), 'image-metadata', 'relationship');
  const format = literal(wire.format, vocabulary.formats);
  const bytes = number(wire.image_bytes);
  let encoding: ReportedEncoding;
  switch (format) {
    case 'jpeg': encoding = { kind: format, mime: literal(wire.mime_type, [vocabulary.jpegMime]), quality: literal(wire.jpeg_quality, vocabulary.jpegQualities), bytes }; break;
    case 'png': encoding = { kind: format, mime: literal(wire.mime_type, [vocabulary.pngMime]), bytes }; break;
    default: { const exhaustive: never = format; return exhaustive; }
  }
  return { kind: 'metadata-only', metadata: {
    frameId: frameId(wire.frame_id), sha256: sha256(wire.sha256), displayId: id, displayGeneration: number(wire.display_config_generation),
    capture: rectangle(wire.capture_rect), sourcePixels, outputPixels,
    pointPixelScale: number(wire.point_pixel_scale), downscale, encoding,
    capturedAt: string(wire.captured_at), maxAgeMs: number(wire.max_age_ms),
    pointer, frontmost: app(wire.frontmost_app),
  } };
}
function leaseOutcome(wire: Record<string, unknown>, expectedOperation: LeaseOperation): LeaseOutcome {
  const result = object(wire.lease_result);
  const operation = literal(result.op, vocabulary.leaseOperations);
  requireFact(operation === expectedOperation, 'correlation', 'relationship');
  const outcome = literal(result.outcome, vocabulary.leaseOutcomes);
  const lease = callerLease(wire.lease);
  switch (outcome) {
    case 'acquired': case 'renewed':
      requireFact(operation !== vocabulary.releaseOperation && lease.kind === 'held-by-caller');
      return { kind: 'held', operation, outcome, lease };
    case 'released': case 'not_held':
      requireFact(operation === vocabulary.releaseOperation && lease.kind === 'not-held-by-caller');
      return { kind: outcome === 'released' ? 'released' : 'not-held', operation, lease };
    case 'refused': {
      requireFact(lease.kind === 'not-held-by-caller');
      const code = literal(result.code, vocabulary.leaseRefusals);
      const refusal: LeaseRefusal = code === 'lease_held_by_other' ? { code, otherExpiresInMs: number(result.expires_in_ms) } : { code };
      return { kind: 'refused', operation, refusal, lease };
    }
    default: { const exhaustive: never = outcome; return exhaustive; }
  }
}
function measurementFacts(wire: Record<string, unknown>): MeasurementFacts {
  return { frontmost: app(wire.frontmost_app), target: wire.target_app === null ? null : app(wire.target_app),
    windowTitle: nullableString(wire.window_title), measuredAt: string(wire.measured_at) };
}
function dragEnd(value: unknown): DragEnd {
  const wire = object(value);
  return { target: app(wire.target_app), windowTitle: nullableString(wire.window_title), globalPoint: point(wire.global_point) };
}
function checkDrag(wire: Record<string, unknown>, action: ExpectedPointer['action'], code?: ErrorCode): void {
  requireFact(Object.hasOwn(wire, 'drag_end') === (action === 'drag' && code !== 'denied_app'), 'schema', 'relationship');
}
function pointerMeasurement(value: unknown, action: ExpectedPointer['action']): PointerMeasurement {
  const wire = object(value);
  checkDrag(wire, action);
  const facts = { ...measurementFacts(wire), frontmost: identifiedApp(wire.frontmost_app), target: identifiedApp(wire.target_app), globalPoint: point(wire.global_point) };
  if (action === 'target') return { ...facts, kind: 'target' };
  const end = object(wire.drag_end);
  return { ...facts, kind: 'drag', end: { ...dragEnd(end), target: identifiedApp(end.target_app) } };
}
function keyboardMeasurement(value: unknown): KeyboardMeasurement {
  const wire = object(value);
  requireFact(wire.global_point === null && !Object.hasOwn(wire, 'drag_end'), 'schema', 'relationship');
  return { ...measurementFacts(wire), kind: 'keyboard', frontmost: identifiedApp(wire.frontmost_app), target: identifiedApp(wire.target_app), globalPoint: null };
}
function pointerErrorMeasurement(value: unknown, action: ExpectedPointer['action'], code: ErrorCode): PointerErrorMeasurement {
  const wire = object(value);
  checkDrag(wire, action, code);
  return { ...measurementFacts(wire), globalPoint: wire.global_point === null ? null : point(wire.global_point), end: optional(wire.drag_end, dragEnd) };
}
function keyboardErrorMeasurement(value: unknown): KeyboardErrorMeasurement {
  const wire = object(value);
  requireFact(wire.global_point === null && !Object.hasOwn(wire, 'drag_end'), 'schema', 'relationship');
  return { ...measurementFacts(wire), globalPoint: null };
}
function completionFacts(wire: Record<string, unknown>, expected: ExpectedKeyboard): CompletionFacts {
  requireFact(wire.operation_id === expected.operationId && wire.frame_id === expected.frame.frameId, 'correlation', 'relationship');
  return { operationId: operationId(wire.operation_id), frameId: frameId(wire.frame_id), status: literal(wire.status, [vocabulary.completedStatus]),
    events: { kind: 'exact', value: number(wire.events_posted) }, replayed: boolean(wire.replayed), completedAt: string(wire.completed_at) };
}
function diagnostics(value: unknown): KnownDiagnostics {
  const wire = object(value);
  return {
    ...(wire.reason === undefined ? {} : { reason: literal(wire.reason, vocabulary.staleReasons) }),
    ...(wire.argument === undefined ? {} : { argument: string(wire.argument) }),
    ...(wire.point_index === undefined ? {} : { pointIndex: number(wire.point_index) }),
    ...(wire.output_pixel_size === undefined ? {} : { outputPixels: pixels(wire.output_pixel_size) }),
    ...(wire.image_bytes === undefined ? {} : { imageBytes: number(wire.image_bytes) }),
    ...(wire.max_image_bytes === undefined ? {} : { maxImageBytes: number(wire.max_image_bytes) }),
    ...(wire.idle_ms === undefined ? {} : { idleMs: number(wire.idle_ms) }),
    ...(wire.denied_by === undefined ? {} : { deniedBy: literal(wire.denied_by, vocabulary.deniedBy) }),
    ...(wire.shortcut === undefined ? {} : { shortcut: string(wire.shortcut) }),
    ...(wire.expires_in_ms === undefined ? {} : { otherLeaseExpiresInMs: number(wire.expires_in_ms) }),
  };
}
function returnEvidence(wire: Record<string, unknown>): ReturnEvidence {
  const state = literal(wire.state, vocabulary.states);
  if (wire.replayed === undefined) return { kind: 'not-admitted', state };
  return boolean(wire.replayed) ? { kind: 'replay', originalState: state, currentState: literal(wire.current_state, vocabulary.states) } : { kind: 'first-admission', state };
}
function errorVariants<M>(wire: Record<string, unknown>, measured: Presence<M>): ErrorVariants<M> {
  const code = literal(wire.code, vocabulary.errorCodes);
  const facts = { message: string(wire.message), reportedOperationId: optional(wire.operation_id, operationId), operation: optional(wire.operation, operationRecord),
    evidence: returnEvidence(wire), measured, retryAfterMs: optional(wire.retry_after_ms, number) };
  switch (code) {
    case 'invalid_argument': {
      const details = diagnostics(wire.details);
      requireFact(details.argument !== undefined);
      return { ...facts, code, details: { ...details, argument: details.argument } };
    }
    case 'stale_frame': {
      const details = diagnostics(wire.details);
      requireFact(details.reason !== undefined);
      if (details.reason === 'pixels_changed') {
        requireFact(details.pointIndex !== undefined);
        return { ...facts, code, details: { ...details, reason: details.reason, pointIndex: details.pointIndex } };
      }
      return { ...facts, code, details: { ...details, reason: details.reason } };
    }
    case 'out_of_frame': {
      const details = diagnostics(wire.details);
      requireFact(details.pointIndex !== undefined && details.outputPixels !== undefined);
      requireFact(details.outputPixels.width <= vocabulary.maxWidth && details.outputPixels.height <= vocabulary.maxHeight &&
        details.outputPixels.width * details.outputPixels.height <= vocabulary.maxPixels, 'image-metadata', 'relationship');
      return { ...facts, code, details: { ...details, pointIndex: details.pointIndex, outputPixels: details.outputPixels } };
    }
    case 'image_too_large': {
      const details = diagnostics(wire.details);
      requireFact(details.imageBytes !== undefined && details.maxImageBytes !== undefined);
      requireFact(details.imageBytes > vocabulary.maxImageBytes && details.maxImageBytes === vocabulary.maxImageBytes, 'image-metadata', 'relationship');
      return { ...facts, code, details: { ...details, imageBytes: details.imageBytes, maxImageBytes: details.maxImageBytes } };
    }
    case 'user_active': {
      const details = diagnostics(wire.details);
      requireFact(details.idleMs !== undefined);
      return { ...facts, code, details: { ...details, idleMs: details.idleMs } };
    }
    case 'denied_app': {
      const details = diagnostics(wire.details);
      requireFact(details.deniedBy !== undefined);
      return { ...facts, code, measured: required(measured), details: { ...details, deniedBy: details.deniedBy } };
    }
    case 'denied_shortcut': {
      const details = diagnostics(wire.details);
      requireFact(details.shortcut !== undefined);
      return { ...facts, code, details: { ...details, shortcut: details.shortcut } };
    }
    case 'lease_held_by_other': {
      const details = diagnostics(wire.details);
      requireFact(details.otherLeaseExpiresInMs !== undefined);
      return { ...facts, code, details: { ...details, otherLeaseExpiresInMs: details.otherLeaseExpiresInMs } };
    }
    case 'rate_limited': return { ...facts, code, retryAfterMs: number(wire.retry_after_ms) };
    case 'log_unavailable': return { ...facts, code, measured: required(measured) };
    case 'operation_in_progress': case 'operation_id_conflict':
      return { ...facts, code, reportedOperationId: required(facts.reportedOperationId), operation: required(facts.operation) };
    case 'interrupted':
      requireFact(facts.evidence.kind === 'replay' && measured.kind === 'absent');
      return { ...facts, code, evidence: facts.evidence, measured, reportedOperationId: required(facts.reportedOperationId), operation: required(facts.operation) };
    case 'cancelled':
      requireFact(facts.evidence.kind === 'replay');
      return { ...facts, code, evidence: facts.evidence, reportedOperationId: required(facts.reportedOperationId), operation: required(facts.operation) };
    case 'gated': case 'paused': case 'disarmed': case 'not_console': case 'locked': case 'display_asleep':
    case 'permission_missing': case 'permission_stale': case 'secure_input': case 'busy': case 'lease_not_held':
    case 'lease_expired': case 'operation_capacity': case 'cleanup_pending': case 'internal_error':
      return { ...facts, code };
    default: { const exhaustive: never = code; return exhaustive; }
  }
}
function hasToolCode<T extends ToolName, E extends { readonly code: ErrorCode }>(error: E, tool: T): error is E & { readonly code: ToolCode<T> } {
  return vocabulary.errorsByTool[tool].some((code) => code === error.code);
}
function toolError<T extends ToolName>(tool: T, wire: Record<string, unknown>, measured: Presence<ErrorMeasurement<T>>): ToolError<T> {
  const error = errorVariants(wire, measured);
  requireFact(hasToolCode(error, tool));
  return { ...error, tool };
}
function admittedRecord(code: ErrorCode, wire: Record<string, unknown>, tool: ToolName): void {
  const record = object(wire.operation);
  switch (code) {
    case 'interrupted':
      requireFact(record.status === 'aborted_by_restart' || record.status === 'failed_before_execution', 'schema', 'relationship');
      requireFact(wire.state === wire.current_state, 'schema', 'relationship');
      return;
    case 'internal_error':
      requireFact(record.status === 'failed', 'schema', 'relationship');
      return;
    case 'stale_frame':
      requireFact(tool === 'pointer' && object(wire.details).reason === 'pixels_changed' && record.events_posted === 0, 'schema', 'relationship');
      requireFact(object(wire.details).point_index === 0, 'schema', 'relationship');
      requireFact(record.status === 'aborted', 'schema', 'relationship');
      return;
    case 'gated': case 'paused': case 'disarmed': case 'not_console': case 'locked': case 'display_asleep':
    case 'permission_missing': case 'permission_stale': case 'secure_input': case 'user_active': case 'denied_app':
    case 'lease_not_held': case 'lease_expired': case 'cancelled':
      requireFact(record.status === 'aborted', 'schema', 'relationship');
      return;
    case 'out_of_frame': case 'denied_shortcut': case 'rate_limited': case 'busy': case 'lease_held_by_other':
    case 'invalid_argument': case 'image_too_large': case 'operation_in_progress': case 'operation_id_conflict':
    case 'operation_capacity': case 'log_unavailable': case 'cleanup_pending':
      throw new BoundaryFailure('schema', 'relationship');
    default: { const exhaustive: never = code; return exhaustive; }
  }
}
function errorSemantics(wire: Record<string, unknown>, tool: ToolName, expected?: ExpectedKeyboard): ErrorCode {
  const code = literal(wire.code, vocabulary.errorCodes);
  const input = tool === 'pointer' || tool === 'keyboard';
  requireFact(input || ['operation_id', 'operation', 'replayed', 'current_state', 'measured'].every((key) => !Object.hasOwn(wire, key)), 'schema', 'relationship');
  const admitted = Object.hasOwn(wire, 'replayed');
  if (!admitted && Object.hasOwn(wire, 'operation')) {
    switch (code) {
      case 'cleanup_pending': case 'lease_held_by_other': case 'lease_expired': case 'lease_not_held':
      case 'rate_limited': case 'operation_capacity': case 'stale_frame': case 'out_of_frame':
      case 'user_active': case 'denied_shortcut': case 'denied_app': case 'log_unavailable':
        throw new BoundaryFailure('schema', 'relationship');
    }
  }
  if (code === 'stale_frame') {
    const reason = object(wire.details).reason;
    requireFact(reason !== 'pixels_changed' || tool === 'pointer', 'schema', 'relationship');
    requireFact(reason !== 'frontmost_changed' || tool === 'keyboard', 'schema', 'relationship');
  }
  const needsMeasurement = input && code !== 'interrupted' && (admitted || code === 'denied_app' || code === 'log_unavailable');
  requireFact(Object.hasOwn(wire, 'measured') === needsMeasurement, 'schema', 'relationship');
  requireFact(!admitted || (Object.hasOwn(wire, 'operation') && Object.hasOwn(wire, 'operation_id')), 'schema', 'relationship');
  requireFact(!Object.hasOwn(wire, 'operation') || Object.hasOwn(wire, 'operation_id'), 'schema', 'relationship');
  if (admitted) admittedRecord(code, wire, tool);
  if (code === 'operation_in_progress') {
    const status = object(wire.operation).status;
    requireFact(status === 'accepted' || status === 'executing', 'schema', 'relationship');
  }
  if (expected && Object.hasOwn(wire, 'operation_id')) requireFact(wire.operation_id === expected.operationId, 'correlation', 'relationship');
  return code;
}
function bindFrame(context: BoundaryContext, expected: ExpectedKeyboard): void {
  requireFact(isOperationId(expected.operationId) && isFrameId(expected.frame.frameId) && isDisplayId(expected.frame.displayId), 'correlation', 'relationship');
  requireFact(expected.frame.endpoint === context.endpoint && expected.frame.holderId === context.holderId, 'correlation', 'relationship');
}
type Envelope = RpcError | Readonly<{ kind: 'success' | 'error'; wire: Record<string, unknown> }>;
function envelope(raw: unknown, expected: ExpectedReply, tool: ToolName): Envelope {
  requireFact(typeof expected.requestId === 'string' || (typeof expected.requestId === 'number' && Number.isFinite(expected.requestId)), 'correlation', 'envelope');
  if (validates('wire/jsonrpc-error.json', raw)) {
    const wire = object(raw);
    requireFact(wire.id === expected.requestId, 'correlation', 'envelope');
    return { kind: 'rpc-error', code: literal(object(wire.error).code, vocabulary.rpcErrors) };
  }
  requireFact(validates('wire/jsonrpc-response.json', raw), 'rpc', 'envelope');
  const response = object(raw);
  requireFact(response.id === expected.requestId, 'correlation', 'envelope');
  requireFact(validates('wire/tools-call-result.json', response.result), 'schema', 'envelope');
  const result = object(response.result);
  requireFact(validates(`tools/${tool}.output.json`, result.structuredContent), 'schema', 'tool');
  const wire = object(result.structuredContent);
  const content = array(result.content);
  const textBlock = object(content.at(-1));
  let text: unknown;
  try { text = parseJsonRejectingDuplicateKeys(string(textBlock.text)); }
  catch { throw new BoundaryFailure('content', 'relationship'); }
  requireFact(sameJsonValue(text, wire), 'content', 'relationship');
  const isError = boolean(result.isError);
  if (tool === 'screenshot' && !isError) {
    requireFact(content.length === 2 && object(content[0]).mimeType === wire.mime_type, 'content', 'relationship');
  } else requireFact(content.length === 1, 'content', 'relationship');
  return { kind: isError ? 'error' : 'success', wire };
}

export function createResultBoundary(configuration: BoundaryContext): ResultBoundary {
  const context = { endpoint: endpointIdentity(configuration.endpoint), holderId: holderId(configuration.holderId), expectedMac: string(configuration.expectedMac) };
  return {
    status: (raw, expected) => safely(() => {
      const result = envelope(raw, expected, 'status');
      if (result.kind === 'rpc-error') return result;
      if (result.kind === 'error') {
        errorSemantics(result.wire, 'status');
        return { kind: 'tool-error', error: toolError('status', result.wire, { kind: 'absent' }) };
      }
      requireFact(!Object.hasOwn(result.wire, 'operation'), 'correlation', 'relationship');
      return { kind: 'ok', value: desktopStatus(result.wire, context, expected.holder) };
    }),
    lookup: (raw, expected) => safely(() => {
      requireFact(isOperationId(expected.operationId), 'correlation', 'relationship');
      const result = envelope(raw, expected, 'status');
      if (result.kind === 'rpc-error') return result;
      if (result.kind === 'error') {
        errorSemantics(result.wire, 'status');
        return { kind: 'tool-error', error: toolError('status', result.wire, { kind: 'absent' }) };
      }
      requireFact(Object.hasOwn(result.wire, 'operation'), 'correlation', 'relationship');
      return { kind: 'ok', value: { status: desktopStatus(result.wire, context, 'configured-holder'), operationId: expected.operationId,
        record: result.wire.operation === null ? { kind: 'not-recorded-now' } : operationRecord(result.wire.operation) } };
    }),
    displays: (raw, expected) => safely(() => {
      const result = envelope(raw, expected, 'displays');
      if (result.kind === 'rpc-error') return result;
      if (result.kind === 'error') {
        errorSemantics(result.wire, 'displays');
        return { kind: 'tool-error', error: toolError('displays', result.wire, { kind: 'absent' }) };
      }
      return { kind: 'ok', value: displayCatalog(result.wire) };
    }),
    screenshot: (raw, expected) => safely(() => {
      if (expected.displayId.kind === 'present') requireFact(isDisplayId(expected.displayId.value), 'correlation', 'relationship');
      const result = envelope(raw, expected, 'screenshot');
      if (result.kind === 'rpc-error') return result;
      if (result.kind === 'error') {
        errorSemantics(result.wire, 'screenshot');
        return { kind: 'tool-error', error: toolError('screenshot', result.wire, { kind: 'absent' }) };
      }
      return { kind: 'ok', value: screenshotObservation(result.wire, expected.displayId) };
    }),
    lease: (raw, expected) => safely(() => {
      const result = envelope(raw, expected, 'lease');
      if (result.kind === 'rpc-error') return result;
      if (result.kind === 'error') {
        errorSemantics(result.wire, 'lease');
        return { kind: 'tool-error', error: toolError('lease', result.wire, { kind: 'absent' }) };
      }
      return { kind: 'ok', value: leaseOutcome(result.wire, expected.operation) };
    }),
    pointer: (raw, expected) => safely(() => {
      bindFrame(context, expected);
      requireFact(expected.action === 'target' || expected.action === 'drag', 'correlation', 'relationship');
      const result = envelope(raw, expected, 'pointer');
      if (result.kind === 'rpc-error') return result;
      if (result.kind === 'error') {
        const code = errorSemantics(result.wire, 'pointer', expected);
        const measured = optional(result.wire.measured, (value) => pointerErrorMeasurement(value, expected.action, code));
        const error = toolError('pointer', result.wire, measured);
        const pointIndex = error.code === 'out_of_frame' ||
          error.code === 'stale_frame' && error.details.reason === 'pixels_changed' || error.code === 'denied_app'
          ? error.details.pointIndex : undefined;
        if (pointIndex !== undefined) requireFact(expected.action === 'target' ? pointIndex === 0 : pointIndex < vocabulary.maxDragPoints, 'schema', 'relationship');
        if (error.code === 'denied_app' && error.details.pointIndex !== undefined) requireFact(error.measured.value.globalPoint !== null, 'schema', 'relationship');
        return { kind: 'tool-error', error };
      }
      return { kind: 'ok', value: { ...completionFacts(result.wire, expected), measured: pointerMeasurement(result.wire.measured, expected.action) } };
    }),
    keyboard: (raw, expected) => safely(() => {
      bindFrame(context, expected);
      const result = envelope(raw, expected, 'keyboard');
      if (result.kind === 'rpc-error') return result;
      if (result.kind === 'error') {
        errorSemantics(result.wire, 'keyboard', expected);
        const error = toolError('keyboard', result.wire, optional(result.wire.measured, keyboardErrorMeasurement));
        requireFact(error.code !== 'denied_app' || error.details.pointIndex === undefined, 'schema', 'relationship');
        return { kind: 'tool-error', error };
      }
      return { kind: 'ok', value: { ...completionFacts(result.wire, expected), measured: keyboardMeasurement(result.wire.measured) } };
    }),
  } satisfies ResultBoundary & Record<ToolName, unknown>;
}
