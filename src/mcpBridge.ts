// mcpBridge.ts — loopback HTTP server that lets Gert invoke VS Code's
// already-authenticated MCP tools without touching any credential.
//
// Wire contract: vscode-mcp-bridge/v1
// Default port:  7779, loopback (127.0.0.1) ONLY
//
// Security invariant: nothing that reaches the Gert process (env vars,
// run state, results, error text) may contain the capability secret or any
// MCP credential. The capability secret is minted HERE and passed TO Gert;
// Gert never generates it. Gert must echo it back on every request for
// timing-safe comparison before any MCP call is made.

import * as http from 'http';
import * as crypto from 'crypto';
import type * as vscode from 'vscode';
import { buildRegistryFromDir } from './toolDefinitionRegistry';

// ─── Wire types ──────────────────────────────────────────────────────────────

export interface BridgeRequest {
  version: string;
  request_id: string;
  tool: string;
  action: string;
  args: Record<string, unknown>;
  deadline_unix_ms?: number;
  capability_proof: string;
}

export interface BridgeErrorBody {
  code: string;
  message: string;
}

export interface BridgeResponse {
  version: string;
  request_id: string;
  result?: Record<string, unknown>;
  error?: BridgeErrorBody;
}

// ─── Dependency-injected LM interface ────────────────────────────────────────
// Production code passes vscode.lm; tests pass a plain stub object.

export type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'array';

/** Per-field output specification: declared type and whether the field is required. */
export interface OutputFieldSpec {
  type: FieldType;
  /** When false, an absent field is allowed. Present-but-null/wrong-type still fails. */
  required: boolean;
}

export interface LmToolInfo {
  name: string;
  /**
   * JSON Schema object describing the tool's accepted inputs.  When present,
   * the bridge validates adapted args against it before calling invokeTool.
   * Shape mirrors VS Code's LanguageModelToolInformation.inputSchema.
   */
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string }>;
    required?: string[];
  };
}

export interface LmToolResult {
  content: Array<{ value?: string } | { text?: string } | unknown>;
}

export interface LmCancellationToken {
  isCancellationRequested: boolean;
  onCancellationRequested: (listener: () => void) => { dispose: () => void };
}

export interface LmInterface {
  readonly tools: readonly LmToolInfo[];
  invokeTool(
    name: string,
    options: { input: Record<string, unknown>; toolInvocationToken?: unknown },
    token: LmCancellationToken,
  ): Promise<LmToolResult>;
}

// ─── Tool / action spec ────────────────────────────────────────────────────────
// The registry is built at runtime from workspace *.tool.yaml definitions.
// resolveSpec() is the single lookup surface: callers pass the registry and
// optional name-override map rather than relying on a hard-coded constant.

export interface ToolActionSpec {
  registeredName: string;
  /** Declared output fields with type and required flag. */
  outputFields: Record<string, OutputFieldSpec>;
}

/**
 * resolveSpec returns the spec for a (tool, action) pair, consulting the
 * provided registry and applying any name overrides.
 *
 * @param tool        Logical tool name (e.g. "icm")
 * @param action      Action name (e.g. "get-incident")
 * @param registry    Registry built from *.tool.yaml definitions
 * @param overrides   Optional map of "tool/action" → registered name, sourced
 *                    from the gert.mcpBridge.toolNameOverrides VS Code setting
 */
export function resolveSpec(
  tool: string,
  action: string,
  registry: Record<string, ToolActionSpec>,
  overrides?: Record<string, string>,
): ToolActionSpec | undefined {
  const key = `${tool}/${action}`;
  const spec = registry[key];
  if (!spec) return undefined;
  const overrideName = overrides?.[key];
  if (typeof overrideName === 'string' && overrideName) {
    return { ...spec, registeredName: overrideName };
  }
  return spec;
}

// ─── Result normalizer ────────────────────────────────────────────────────────
// Fail-closed with one explicit exception: a declared field marked
// required: false may be absent (optional absent → OK). Any other deviation
// is still an error:
//   • present-but-null/undefined → error
//   • present-but-wrong-type    → error
//   • required field absent     → error
//   • unknown extra field       → error (fail-closed policy)

export function normalizeResult(
  raw: unknown,
  spec: ToolActionSpec,
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'MCP result is not a JSON object' };
  }
  const obj = raw as Record<string, unknown>;

  // Fail on any key not declared in outputFields.
  for (const key of Object.keys(obj)) {
    if (!(key in spec.outputFields)) {
      return { ok: false, reason: `unexpected extra field in MCP result: "${key}"` };
    }
  }

  const out: Record<string, unknown> = {};
  for (const [field, fieldSpec] of Object.entries(spec.outputFields)) {
    if (!(field in obj)) {
      if (!fieldSpec.required) {
        // Optional field absent — this is a valid outcome; omit from output.
        continue;
      }
      return { ok: false, reason: `declared output field "${field}" is missing from MCP result` };
    }
    const v = obj[field];
    // present-but-null/undefined is always an error, even for optional fields.
    if (v === null || v === undefined) {
      return { ok: false, reason: `declared output field "${field}" is null/undefined` };
    }
    const actual = Array.isArray(v) ? 'array' : typeof v;
    if (actual !== fieldSpec.type) {
      return {
        ok: false,
        reason: `field "${field}": expected ${fieldSpec.type}, got ${actual}`,
      };
    }
    out[field] = v;
  }
  return { ok: true, value: out };
}

// extractTextFromResult pulls text from a LanguageModelToolResult content
// array, concatenating all text parts.
export function extractTextFromResult(result: LmToolResult): string {
  const parts: string[] = [];
  for (const part of result.content) {
    if (part && typeof part === 'object') {
      const p = part as Record<string, unknown>;
      if (typeof p['value'] === 'string') parts.push(p['value']);
      else if (typeof p['text'] === 'string') parts.push(p['text']);
    }
  }
  return parts.join('');
}

// ─── Redaction guard ─────────────────────────────────────────────────────────
// Scrubs the capability secret from any string before it leaves the bridge.
// Used on every outbound message and log line.

function redact(secret: string, text: string): string {
  if (!secret) return text;
  // Use a global replace; the secret is 64 hex chars so no regex special chars.
  return text.split(secret).join('[REDACTED]');
}

// ─── Invocation error classifier ─────────────────────────────────────────────
// Allowlisted categories for vscode.lm.invokeTool failures.  Provider
// exception text is NEVER forwarded; we classify from it and then drop it.
//
// invocation_token_unavailable — VS Code rejected the call because no
//   toolInvocationToken was present (bridge runs outside a chat-participant
//   handler; no token is available to supply).
// authorization_unavailable    — auth/credential/forbidden failure from the
//   provider or VS Code auth layer.
// provider_input_rejected      — the provider rejected the supplied arguments
//   (input-validation failure raised by the MCP server itself, not our schema
//   guard which fires earlier as input_validation_error).
// invocation_error             — any other or unrecognised exception; the safe
//   conservative fallback.

export type InvocationErrorCategory =
  | 'invocation_token_unavailable'
  | 'authorization_unavailable'
  | 'provider_input_rejected'
  | 'invocation_error';

export function classifyInvocationError(err: unknown): InvocationErrorCategory {
  const msg = err instanceof Error ? err.message : String(err);
  // Token-unavailable: VS Code requires a toolInvocationToken that only exists
  // inside a ChatRequestHandler; calling with undefined triggers this.
  if (/invocation.?token|toolInvocationToken|no.*token.*invocation|token.*required/i.test(msg)) {
    return 'invocation_token_unavailable';
  }
  // Authorization / credential failure — preserve the existing category meaning.
  if (/auth|credential|unauthorized|forbidden/i.test(msg)) {
    return 'authorization_unavailable';
  }
  // Provider rejected the supplied arguments at its own validation layer.
  if (/invalid.?input|input.?invalid|invalid.?param|bad.?request|schema.?error|validation.?error/i.test(msg)) {
    return 'provider_input_rejected';
  }
  // Conservative fallback — unknown or ambiguous exception.
  return 'invocation_error';
}

// ─── Input schema validation ──────────────────────────────────────────────────
// Validates adapted args against a tool's live inputSchema BEFORE invoking the
// tool. Fail-closed: any missing required parameter, unknown parameter, or type
// mismatch returns an error string; undefined means the args are valid.

function checkJsonSchemaType(param: string, value: unknown, expectedType: string): string | undefined {
  switch (expectedType) {
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value))
        return `parameter "${param}": expected integer, got ${typeof value}`;
      break;
    case 'number':
      if (typeof value !== 'number')
        return `parameter "${param}": expected number, got ${typeof value}`;
      break;
    case 'string':
      if (typeof value !== 'string')
        return `parameter "${param}": expected string, got ${typeof value}`;
      break;
    case 'boolean':
      if (typeof value !== 'boolean')
        return `parameter "${param}": expected boolean, got ${typeof value}`;
      break;
    case 'array':
      if (!Array.isArray(value))
        return `parameter "${param}": expected array, got ${typeof value}`;
      break;
    case 'object':
      if (typeof value !== 'object' || Array.isArray(value) || value === null)
        return `parameter "${param}": expected object, got ${Array.isArray(value) ? 'array' : typeof value}`;
      break;
  }
  return undefined;
}

export function validateArgsAgainstSchema(
  args: Record<string, unknown>,
  schema: NonNullable<LmToolInfo['inputSchema']>,
): string | undefined {
  const props = schema.properties ?? {};
  const required = schema.required ?? [];

  // Required params must be present.
  for (const param of required) {
    if (!(param in args))
      return `required parameter "${param}" is missing`;
  }

  // No extra params allowed (fail-closed).
  for (const key of Object.keys(args)) {
    if (!(key in props))
      return `parameter "${key}" is not declared in the tool's input schema`;
  }

  // Type check each supplied param.
  for (const [key, value] of Object.entries(args)) {
    const propSchema = props[key];
    if (!propSchema?.type) continue;
    const err = checkJsonSchemaType(key, value, propSchema.type);
    if (err) return err;
  }

  return undefined;
}

// ─── McpBridge class ─────────────────────────────────────────────────────────

const BRIDGE_VERSION = 'vscode-mcp-bridge/v1';

export interface McpBridgeOptions {
  /** Pre-built registry. Takes precedence over registryDir when both are given. */
  registry?: Record<string, ToolActionSpec>;
  /** Directory to scan for *.tool.yaml definitions. Used when registry is not provided. */
  registryDir?: string;
  /**
   * Tool name overrides keyed by "tool/action". Sourced from the
   * gert.mcpBridge.toolNameOverrides VS Code setting. Overrides the
   * YAML-derived registered name for live-session corrections without a
   * code change or release.
   */
  overrides?: Record<string, string>;
}

export class McpBridge {
  private readonly secret: string;
  private readonly server: http.Server;
  private readonly inflight = new Map<string, Promise<BridgeResponse>>();
  private readonly completed = new Map<string, BridgeResponse>();
  private _port: number;
  private disposed = false;
  private readonly output?: { appendLine(s: string): void };
  private registry: Record<string, ToolActionSpec>;
  private readonly overrides: Record<string, string>;

  private constructor(
    private readonly lm: LmInterface,
    port: number,
    output: { appendLine(s: string): void } | undefined,
    registry: Record<string, ToolActionSpec>,
    overrides: Record<string, string>,
  ) {
    this.secret = crypto.randomBytes(32).toString('hex');
    this._port = port;
    this.output = output;
    this.registry = registry;
    this.overrides = overrides;
    this.server = http.createServer((req, res) => {
      this.dispatch(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
        this.log(`[mcpBridge] unhandled error in dispatch: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  }

  // create starts the listener and resolves once it is bound.
  static create(
    lm: LmInterface,
    port = 7779,
    output?: { appendLine(s: string): void },
    options?: McpBridgeOptions,
  ): Promise<McpBridge> {
    // Resolve registry: explicit > dir scan > empty
    let registry: Record<string, ToolActionSpec>;
    if (options?.registry) {
      registry = options.registry;
    } else if (options?.registryDir) {
      registry = buildRegistryFromDir(options.registryDir);
    } else {
      registry = {};
    }
    const overrides = options?.overrides ?? {};

    return new Promise((resolve, reject) => {
      const bridge = new McpBridge(lm, port, output, registry, overrides);
      bridge.server.on('error', reject);
      bridge.server.listen(port, '127.0.0.1', () => {
        const addr = bridge.server.address();
        if (addr && typeof addr === 'object') {
          bridge._port = addr.port;
        }
        resolve(bridge);
      });
    });
  }

  get bridgeToken(): string {
    return this.secret;
  }

  get bridgeUrl(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.server.close();
    this.inflight.clear();
    this.completed.clear();
  }

  /**
   * Replace the registry used for all subsequent requests. Call this whenever
   * the active runbook changes so bridge dispatches from the correct project's
   * tool definitions, not the stale snapshot taken at bridge creation.
   */
  updateRegistry(registry: Record<string, ToolActionSpec>): void {
    this.registry = registry;
  }

  private log(msg: string): void {
    this.output?.appendLine(redact(this.secret, msg));
  }

  // dispatch handles one HTTP request: parse, validate, route to handle().
  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.disposed) {
      return this.sendError(res, 503, 'bridge_disconnected', 'Bridge is shutting down', '');
    }

    let bodyText: string;
    try {
      bodyText = await readBody(req);
    } catch {
      return this.sendError(res, 400, 'malformed_request', 'Failed to read request body', '');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return this.sendError(res, 400, 'malformed_request', 'Request body is not valid JSON', '');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return this.sendError(res, 400, 'malformed_request', 'Request body must be a JSON object', '');
    }

    const body = parsed as Partial<BridgeRequest>;

    if (body.version !== BRIDGE_VERSION) {
      return this.sendError(
        res,
        400,
        'version_mismatch',
        `expected version "${BRIDGE_VERSION}", got "${body.version ?? '(missing)'}"`,
        body.request_id ?? '',
      );
    }

    if (!body.request_id || typeof body.request_id !== 'string') {
      return this.sendError(res, 400, 'malformed_request', 'request_id is required', '');
    }

    const request_id = body.request_id;

    if (!this.checkCapability(body.capability_proof)) {
      return this.sendError(res, 403, 'capability_rejected', 'capability_proof is invalid', request_id);
    }

    if (!body.tool || typeof body.tool !== 'string' ||
        !body.action || typeof body.action !== 'string') {
      return this.sendError(res, 400, 'malformed_request', 'tool and action are required strings', request_id);
    }

    if (body.args !== undefined && (typeof body.args !== 'object' || Array.isArray(body.args))) {
      return this.sendError(res, 400, 'malformed_request', 'args must be a JSON object', request_id);
    }

    const args = (body.args ?? {}) as Record<string, unknown>;

    const cached = this.completed.get(request_id);
    if (cached) {
      return this.sendJson(res, 200, cached);
    }

    const inflight = this.inflight.get(request_id);
    if (inflight) {
      return this.sendJson(res, 200, await inflight);
    }

    const promise = this.handle({
      version: BRIDGE_VERSION,
      request_id,
      tool: body.tool,
      action: body.action,
      args,
      deadline_unix_ms: typeof body.deadline_unix_ms === 'number' ? body.deadline_unix_ms : undefined,
      capability_proof: body.capability_proof as string,
    });

    this.inflight.set(request_id, promise);
    let result: BridgeResponse;
    try {
      result = await promise;
    } finally {
      this.inflight.delete(request_id);
    }
    this.completed.set(request_id, result);
    return this.sendJson(res, result.error?.code === 'bridge_disconnected' ? 503 : 200, result);
  }

  // handle performs the authorized MCP invocation for a validated request.
  private async handle(req: BridgeRequest): Promise<BridgeResponse> {
    const spec = resolveSpec(req.tool, req.action, this.registry, this.overrides);
    if (!spec) {
      return this.errorResponse(req.request_id, 'tool_not_found',
        `no tool action registered for "${req.tool}/${req.action}"`);
    }

    // Verify the tool is registered in vscode.lm.tools; name available names
    // so a mismatch is diagnosable without reading source code.
    const toolInfo = this.lm.tools.find((t) => t.name === spec.registeredName);
    if (!toolInfo) {
      const available = this.lm.tools.map((t) => t.name).join(', ') || '(none)';
      return this.errorResponse(req.request_id, 'tool_unavailable',
        `logical action "${req.tool}/${req.action}" resolved to registered name "${spec.registeredName}", ` +
        `which is not present in vscode.lm.tools; available: [${available}]`);
    }

    // Validate adapted args against the tool's live inputSchema before any
    // invocation. Fail-closed: missing required, unknown, or wrong-type params
    // all produce a coded error; no partial arg set is ever sent downstream.
    if (toolInfo.inputSchema) {
      const schemaError = validateArgsAgainstSchema(req.args, toolInfo.inputSchema);
      if (schemaError) {
        return this.errorResponse(req.request_id, 'input_validation_error', schemaError);
      }
    }

    // Set up deadline / cancellation.
    const cts = makeCancellationSource();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    if (req.deadline_unix_ms) {
      const remaining = req.deadline_unix_ms - Date.now();
      if (remaining <= 0) {
        cts.cancel();
        timedOut = true;
      } else {
        deadlineTimer = setTimeout(() => {
          timedOut = true;
          cts.cancel();
        }, remaining);
      }
    }

    try {
      if (timedOut) {
        return this.errorResponse(req.request_id, 'deadline_exceeded', 'deadline already passed');
      }

      let raw: LmToolResult;
      try {
        raw = await this.lm.invokeTool(
          spec.registeredName,
          { input: req.args },
          cts.token,
        );
      } catch (err: unknown) {
        if (timedOut || cts.token.isCancellationRequested) {
          return this.errorResponse(req.request_id, 'deadline_exceeded', 'invocation timed out');
        }
        const category = classifyInvocationError(err);
        // Log safe metadata only: class name + chosen category + request id.
        // Never log the exception message, args, or any result content.
        const className = err instanceof Error ? err.constructor.name : typeof err;
        this.log(`[mcpBridge] invocation error: category=${category} class=${className} request_id=${req.request_id}`);
        const safeMessage: Record<InvocationErrorCategory, string> = {
          invocation_token_unavailable: 'MCP tool invocation token is unavailable (bridge runs outside a chat-participant request)',
          authorization_unavailable:    'MCP tool authorization is not available',
          provider_input_rejected:      'MCP tool provider rejected the supplied input',
          invocation_error:             'MCP invocation failed',
        };
        return this.errorResponse(req.request_id, category, safeMessage[category]);
      }

      const text = extractTextFromResult(raw);
      let parsedResult: unknown;
      try {
        parsedResult = JSON.parse(text);
      } catch {
        return this.errorResponse(req.request_id, 'result_parse_error',
          'MCP result content is not valid JSON');
      }

      const normalized = normalizeResult(parsedResult, spec);
      if (!normalized.ok) {
        return this.errorResponse(req.request_id, 'result_normalization_error', normalized.reason);
      }

      return {
        version: BRIDGE_VERSION,
        request_id: req.request_id,
        result: normalized.value,
      };
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    }
  }

  private checkCapability(proof: unknown): boolean {
    if (typeof proof !== 'string') return false;
    const expected = Buffer.from(this.secret, 'utf8');
    const actual = Buffer.from(proof, 'utf8');
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  }

  private errorResponse(request_id: string, code: string, message: string): BridgeResponse {
    return {
      version: BRIDGE_VERSION,
      request_id,
      error: { code, message: redact(this.secret, message) },
    };
  }

  private sendError(
    res: http.ServerResponse,
    status: number,
    code: string,
    message: string,
    request_id: string,
  ): void {
    const body: BridgeResponse = {
      version: BRIDGE_VERSION,
      request_id,
      error: { code, message: redact(this.secret, message) },
    };
    this.sendJson(res, status, body);
  }

  private sendJson(res: http.ServerResponse, status: number, body: BridgeResponse): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function makeCancellationSource(): {
  token: LmCancellationToken;
  cancel: () => void;
} {
  let cancelled = false;
  const listeners: Array<() => void> = [];
  const token: LmCancellationToken = {
    get isCancellationRequested() { return cancelled; },
    onCancellationRequested(listener) {
      if (cancelled) { listener(); return { dispose: () => {} }; }
      listeners.push(listener);
      return { dispose: () => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); } };
    },
  };
  return {
    token,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      for (const l of listeners) l();
    },
  };
}


