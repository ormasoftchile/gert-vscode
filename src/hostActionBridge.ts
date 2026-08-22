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

export interface HostActionAcknowledgment {
  type: 'xts.host-action.ack';
  capability: typeof HOST_ACTION_CAPABILITY;
  correlation_id: string;
  interaction_id: string;
  status: HostActionStatus;
}

export interface IframeMessageEvent {
  source: unknown;
  origin: string;
  data: unknown;
}

interface ParsedRequest {
  correlationId: string;
  interactionId: string;
  payload: XtsOpenViewPayload;
}

type ParseResult =
  | { ok: true; value: ParsedRequest }
  | { ok: false; identity?: { correlationId: string; interactionId: string } };

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

const REQUEST_KEYS = new Set([
  'view_path',
  'viewPath',
  'environment',
  'parameters',
  'focus',
  'correlation_id',
  'correlationId',
  'interaction_id',
  'interactionId',
]);

const PARAMETERS_KEYS = new Set(['server', 'database']);
const WIRE_MESSAGE_KEYS = new Set(['type', 'capability', 'request']);

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
  const identity = readString(value, 128);
  return identity !== undefined && /^[A-Za-z0-9._:-]+$/.test(identity) ? identity : undefined;
}

function readAliasedString(
  record: Record<string, unknown>,
  snakeCaseName: string,
  camelCaseName: string,
  reader: (value: unknown) => string | undefined,
): string | undefined {
  const snakeValue = record[snakeCaseName];
  const camelValue = record[camelCaseName];
  if (snakeValue !== undefined && camelValue !== undefined && snakeValue !== camelValue) return undefined;
  return reader(snakeValue ?? camelValue);
}

function readAcknowledgmentIdentity(value: unknown): { correlationId: string; interactionId: string } | undefined {
  if (!isRecord(value)) return undefined;
  const correlationId = readAliasedString(value, 'correlation_id', 'correlationId', readIdentity);
  const interactionId = readAliasedString(value, 'interaction_id', 'interactionId', readIdentity);
  return correlationId !== undefined && interactionId !== undefined ? { correlationId, interactionId } : undefined;
}

function parseIframeRequest(value: unknown): ParseResult {
  const identity = isRecord(value) ? readAcknowledgmentIdentity(value.request) : undefined;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, WIRE_MESSAGE_KEYS) ||
    value.type !== 'xts.host-action.request' ||
    value.capability !== HOST_ACTION_CAPABILITY
  ) {
    return { ok: false, identity };
  }

  const request = value.request;
  if (!isRecord(request) || !hasOnlyKeys(request, REQUEST_KEYS)) return { ok: false, identity };

  const viewPath = readAliasedString(request, 'view_path', 'viewPath', (candidate) => readString(candidate, 2048));
  const environment = readString(request.environment, 256);
  const correlationId = identity?.correlationId;
  const interactionId = identity?.interactionId;
  if (
    viewPath === undefined ||
    environment === undefined ||
    correlationId === undefined ||
    interactionId === undefined ||
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
      correlationId,
      interactionId,
      payload: {
        viewPath,
        environment,
        parameters: { server, database },
        focus: request.focus,
        correlationId,
      },
    },
  };
}

function outcomeFrom(value: unknown): HostActionStatus {
  if (isRecord(value) && typeof value.status === 'string' && ALLOWED_OUTCOMES.has(value.status as HostActionStatus)) {
    return value.status as HostActionStatus;
  }
  return 'opened';
}

function outcomeFromError(error: unknown): HostActionStatus {
  if (isRecord(error)) {
    const status = typeof error.status === 'string' ? error.status : error.code;
    if (typeof status === 'string' && ALLOWED_OUTCOMES.has(status as HostActionStatus)) {
      return status as HostActionStatus;
    }
  }
  return 'execution-not-started';
}

function acknowledgment(
  correlationId: string,
  interactionId: string,
  status: HostActionStatus,
): HostActionAcknowledgment {
  return {
    type: 'xts.host-action.ack',
    capability: HOST_ACTION_CAPABILITY,
    correlation_id: correlationId,
    interaction_id: interactionId,
    status,
  };
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
    event.data.type === 'xts.host-action.request'
  );
}

// The only accepted wrapper-to-extension envelope. The inner wire shape stays
// here so upstream naming adjustments do not bleed into VS Code command calls.
export function isHostActionWrapperMessage(
  message: unknown,
): message is { type: 'gert.host-action.request'; payload: unknown } {
  return isRecord(message) &&
    message.type === 'gert.host-action.request' &&
    Object.keys(message).length === 2 &&
    'payload' in message;
}

export class HostActionBridge {
  private generation = 0;
  private readonly pending = new Set<string>();
  private readonly completed = new Set<string>();

  constructor(private readonly dependencies: HostActionBridgeDependencies) {}

  invalidate(): void {
    this.generation += 1;
    this.pending.clear();
    this.completed.clear();
  }

  async receive(message: unknown): Promise<void> {
    if (!isHostActionWrapperMessage(message)) return;
    const payload = message.payload;
    const parsed = parseIframeRequest(payload);
    if (!parsed.ok) {
      if (parsed.identity) {
        this.dependencies.postAcknowledgment(
          acknowledgment(parsed.identity.correlationId, parsed.identity.interactionId, 'invalid-parameters'),
        );
      }
      return;
    }

    const key = `${parsed.value.correlationId}\u0000${parsed.value.interactionId}`;
    if (this.pending.has(key) || this.completed.has(key)) return;

    const generation = this.generation;
    this.pending.add(key);
    let status: HostActionStatus;
    try {
      const result = await this.dependencies.executeCommand(
        HOST_ACTION_REGISTRY[HOST_ACTION_CAPABILITY],
        parsed.value.payload,
      );
      status = outcomeFrom(result);
    } catch (error: unknown) {
      status = outcomeFromError(error);
    }

    if (generation !== this.generation || !this.pending.delete(key)) return;
    this.completed.add(key);
    this.dependencies.postAcknowledgment(
      acknowledgment(parsed.value.correlationId, parsed.value.interactionId, status),
    );
  }
}
