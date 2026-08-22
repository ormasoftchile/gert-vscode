export const HOST_ACTION_CAPABILITY = 'xts.open-view' as const;
export const HOST_ACTION_COMMAND = 'xts.openViewWithParameters' as const;
export const HOST_ACTION_REGISTRY = Object.freeze({
  [HOST_ACTION_CAPABILITY]: HOST_ACTION_COMMAND,
});

export type HostActionStatus =
  | 'opened'
  | 'view-not-found'
  | 'environment-not-found'
  | 'invalid-parameters'
  | 'execution-not-started';

export interface XtsOpenViewPayload {
  viewPath: string;
  environment: string;
  parameters: {
    server: string;
    database: string;
  };
  focus: boolean;
  correlationId: string;
}

interface HostActionIdentity {
  runID: string;
  turnID: string;
  correlationID: string;
  previewSessionID: string;
  requestID: string;
}

interface HostActionCancellation {
  correlationID: string;
  previewSessionID: string;
  requestID: string;
}

export interface HostActionAcknowledgment extends HostActionIdentity {
  type: 'gert.host-action.ack';
  version: 1;
  capability: typeof HOST_ACTION_CAPABILITY;
  status: HostActionStatus;
}

export interface IframeMessageEvent {
  source: unknown;
  origin: string;
  data: unknown;
}

interface ParsedRequest {
  identity: HostActionIdentity;
  payload: XtsOpenViewPayload;
}

type ParseResult =
  | { ok: true; value: ParsedRequest }
  | { ok: false; identity?: HostActionIdentity };

export interface HostActionBridgeDependencies {
  executeCommand(command: typeof HOST_ACTION_COMMAND, payload: XtsOpenViewPayload): Thenable<unknown>;
  postAcknowledgment(acknowledgment: HostActionAcknowledgment): void;
}

const ALLOWED_OUTCOMES = new Set<HostActionStatus>([
  'opened',
  'view-not-found',
  'environment-not-found',
  'invalid-parameters',
  'execution-not-started',
]);

const REQUEST_MESSAGE_KEYS = new Set([
  'type',
  'version',
  'runID',
  'turnID',
  'correlationID',
  'previewSessionID',
  'requestID',
  'request',
]);
const CANCEL_MESSAGE_KEYS = new Set([
  'type',
  'version',
  'correlationID',
  'previewSessionID',
  'requestID',
]);
const REQUEST_KEYS = new Set(['capability', 'view_path', 'environment', 'parameters', 'focus']);
const PARAMETERS_KEYS = new Set(['server', 'database']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function readString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    return undefined;
  }
  return value;
}

function readIdentity(value: unknown): string | undefined {
  const identity = readString(value, 256);
  return identity !== undefined && /^[A-Za-z0-9._:-]+$/.test(identity) ? identity : undefined;
}

function readHostActionIdentity(value: unknown): HostActionIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const runID = readIdentity(value.runID);
  const turnID = readIdentity(value.turnID);
  const correlationID = readIdentity(value.correlationID);
  const previewSessionID = readIdentity(value.previewSessionID);
  const requestID = readIdentity(value.requestID);
  return runID !== undefined &&
    turnID !== undefined &&
    correlationID !== undefined &&
    previewSessionID !== undefined &&
    requestID !== undefined
    ? { runID, turnID, correlationID, previewSessionID, requestID }
    : undefined;
}

function parseIframeRequest(value: unknown): ParseResult {
  const identity = readHostActionIdentity(value);
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, REQUEST_MESSAGE_KEYS) ||
    value.type !== 'gert.host-action.request' ||
    value.version !== 1
  ) {
    return { ok: false, identity };
  }

  const request = value.request;
  if (!isRecord(request) || !hasOnlyKeys(request, REQUEST_KEYS)) return { ok: false, identity };

  const viewPath = readString(request.view_path, 2048);
  const environment = readString(request.environment, 256);
  if (
    identity === undefined ||
    request.capability !== HOST_ACTION_CAPABILITY ||
    viewPath === undefined ||
    environment === undefined ||
    typeof request.focus !== 'boolean' ||
    !isRecord(request.parameters) ||
    !hasOnlyKeys(request.parameters, PARAMETERS_KEYS)
  ) {
    return { ok: false, identity };
  }

  const server = readString(request.parameters.server, 512);
  const database = readString(request.parameters.database, 512);
  if (server === undefined || database === undefined) return { ok: false, identity };

  return {
    ok: true,
    value: {
      identity,
      payload: {
        viewPath,
        environment,
        parameters: { server, database },
        focus: request.focus,
        correlationId: identity.correlationID,
      },
    },
  };
}

function parseIframeCancellation(value: unknown): HostActionCancellation | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, CANCEL_MESSAGE_KEYS) ||
    value.type !== 'gert.host-action.cancel' ||
    value.version !== 1
  ) {
    return undefined;
  }
  const correlationID = readIdentity(value.correlationID);
  const previewSessionID = readIdentity(value.previewSessionID);
  const requestID = readIdentity(value.requestID);
  if (correlationID === undefined || previewSessionID === undefined || requestID === undefined) {
    return undefined;
  }
  return { correlationID, previewSessionID, requestID };
}

function outcomeFrom(value: unknown): HostActionStatus {
  if (isRecord(value) && typeof value.status === 'string' && ALLOWED_OUTCOMES.has(value.status as HostActionStatus)) {
    return value.status as HostActionStatus;
  }
  return 'execution-not-started';
}

function acknowledgment(identity: HostActionIdentity, status: HostActionStatus): HostActionAcknowledgment {
  return {
    type: 'gert.host-action.ack',
    version: 1,
    ...identity,
    capability: HOST_ACTION_CAPABILITY,
    status,
  };
}

function identityKey(identity: HostActionIdentity): string {
  return [
    identity.runID,
    identity.turnID,
    identity.correlationID,
    identity.previewSessionID,
    identity.requestID,
  ].join('\u0000');
}

// The wrapper calls this before handing an iframe request to VS Code. Keeping
// it independent of DOM types makes the origin/source security rule unit-testable.
export function isTrustedIframeHostActionMessage(
  event: IframeMessageEvent,
  expectedOrigin: string,
  expectedSource: unknown,
): boolean {
  return (
    event.source === expectedSource &&
    event.origin === expectedOrigin &&
    isRecord(event.data) &&
    (event.data.type === 'gert.host-action.request' || event.data.type === 'gert.host-action.cancel')
  );
}

// The extension accepts only the wrapper's direct forwarding of a final Gert
// wire message; it does not preserve a second, independently shaped envelope.
export function isHostActionWrapperMessage(message: unknown): boolean {
  return isRecord(message) &&
    (message.type === 'gert.host-action.request' || message.type === 'gert.host-action.cancel');
}

export class HostActionBridge {
  private generation = 0;
  private readonly pending = new Map<string, HostActionIdentity>();
  private readonly completed = new Set<string>();

  constructor(private readonly dependencies: HostActionBridgeDependencies) {}

  invalidate(): void {
    this.generation += 1;
    for (const [key, identity] of this.pending) {
      this.completed.add(key);
      this.dependencies.postAcknowledgment(acknowledgment(identity, 'execution-not-started'));
    }
    this.pending.clear();
  }

  async receive(message: unknown): Promise<void> {
    if (!isHostActionWrapperMessage(message)) return;

    const cancellation = parseIframeCancellation(message);
    if (cancellation !== undefined) {
      this.cancel(cancellation);
      return;
    }

    const parsed = parseIframeRequest(message);
    if (!parsed.ok) {
      if (parsed.identity) {
        this.dependencies.postAcknowledgment(acknowledgment(parsed.identity, 'invalid-parameters'));
      }
      return;
    }

    const key = identityKey(parsed.value.identity);
    if (this.pending.has(key) || this.completed.has(key)) return;

    const generation = this.generation;
    this.pending.set(key, parsed.value.identity);
    let status: HostActionStatus;
    try {
      const result = await this.dependencies.executeCommand(
        HOST_ACTION_REGISTRY[HOST_ACTION_CAPABILITY],
        parsed.value.payload,
      );
      status = outcomeFrom(result);
    } catch {
      status = 'execution-not-started';
    }

    if (generation !== this.generation || !this.pending.delete(key)) return;
    this.completed.add(key);
    this.dependencies.postAcknowledgment(acknowledgment(parsed.value.identity, status));
  }

  private cancel(cancellation: HostActionCancellation): void {
    const pending = [...this.pending.entries()].find(([, identity]) =>
      identity.correlationID === cancellation.correlationID &&
      identity.previewSessionID === cancellation.previewSessionID &&
      identity.requestID === cancellation.requestID,
    );
    if (pending === undefined) return;
    const [key, identity] = pending;
    this.pending.delete(key);
    this.completed.add(key);
    this.dependencies.postAcknowledgment(acknowledgment(identity, 'execution-not-started'));
  }
}
