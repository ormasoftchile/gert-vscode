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

export interface LmToolInfo {
  name: string;
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

// ─── Tool / action registry ───────────────────────────────────────────────────
// THE ONE PLACE where (tool, action) → registered MCP tool name and declared
// output schema live. Add entries here when new tool actions are on-boarded.
// Unknown extra fields in MCP results are REJECTED (fail-closed policy).

export interface ToolActionSpec {
  registeredName: string;
  // Every key that must appear in the result, with its required JS type.
  // Extra keys not listed here cause normalizeResult to fail.
  outputFields: Record<string, FieldType>;
}

export const TOOL_ACTION_REGISTRY: Record<string, ToolActionSpec> = {
  'icm/get-incident': {
    registeredName: 'icm-get-incident',
    outputFields: {
      title: 'string',
      service: 'string',
      environment: 'string',
      logical_server: 'string',
      database: 'string',
    },
  },
  'tsg-recommendation/recommend': {
    registeredName: 'tsg-recommendation-recommend',
    outputFields: {
      outcome: 'string',
      suggested: 'string',
    },
  },
};

// resolveSpec returns the spec for a (tool, action) pair, or undefined.
export function resolveSpec(tool: string, action: string): ToolActionSpec | undefined {
  return TOOL_ACTION_REGISTRY[`${tool}/${action}`];
}

// ─── Result normalizer ────────────────────────────────────────────────────────
// Fail-closed: missing declared field → error; unknown extra field → error;
// type-incompatible value → error.

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
  for (const [field, expected] of Object.entries(spec.outputFields)) {
    if (!(field in obj)) {
      return { ok: false, reason: `declared output field "${field}" is missing from MCP result` };
    }
    const v = obj[field];
    if (v === null || v === undefined) {
      return { ok: false, reason: `declared output field "${field}" is null/undefined` };
    }
    const actual = Array.isArray(v) ? 'array' : typeof v;
    if (actual !== expected) {
      return {
        ok: false,
        reason: `field "${field}": expected ${expected}, got ${actual}`,
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

// ─── McpBridge class ─────────────────────────────────────────────────────────

const BRIDGE_VERSION = 'vscode-mcp-bridge/v1';

export class McpBridge {
  private readonly secret: string;
  private readonly server: http.Server;
  private readonly inflight = new Map<string, Promise<BridgeResponse>>();
  private readonly completed = new Map<string, BridgeResponse>();
  private _port: number;
  private disposed = false;
  private readonly output?: { appendLine(s: string): void };

  private constructor(
    private readonly lm: LmInterface,
    port: number,
    output?: { appendLine(s: string): void },
  ) {
    this.secret = crypto.randomBytes(32).toString('hex');
    this._port = port;
    this.output = output;
    this.server = http.createServer((req, res) => {
      this.dispatch(req, res).catch((err) => {
        // last-ditch: the handler already wraps everything, so this is a
        // programming error. Respond 500 and swallow.
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
  ): Promise<McpBridge> {
    return new Promise((resolve, reject) => {
      const bridge = new McpBridge(lm, port, output);
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

  private log(msg: string): void {
    this.output?.appendLine(redact(this.secret, msg));
  }

  // dispatch handles one HTTP request: parse, validate, route to handle().
  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.disposed) {
      return this.sendError(res, 503, 'bridge_disconnected', 'Bridge is shutting down', '');
    }

    // Read body.
    let bodyText: string;
    try {
      bodyText = await readBody(req);
    } catch {
      return this.sendError(res, 400, 'malformed_request', 'Failed to read request body', '');
    }

    // Parse JSON.
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

    // Version check — echo our version in error even when request has none.
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

    // Capability proof — timing-safe comparison.
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

    // Idempotency: return cached completed response.
    const cached = this.completed.get(request_id);
    if (cached) {
      return this.sendJson(res, 200, cached);
    }

    // Idempotency: join an in-flight invocation.
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
    const spec = resolveSpec(req.tool, req.action);
    if (!spec) {
      return this.errorResponse(req.request_id, 'tool_not_found',
        `no tool action registered for "${req.tool}/${req.action}"`);
    }

    // Verify the tool is actually registered in vscode.lm.tools.
    const toolInfo = this.lm.tools.find((t) => t.name === spec.registeredName);
    if (!toolInfo) {
      return this.errorResponse(req.request_id, 'tool_unavailable',
        `MCP tool "${spec.registeredName}" is not registered in vscode.lm.tools`);
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
        const msg = err instanceof Error ? err.message : String(err);
        if (/auth|credential|token|unauthorized|forbidden/i.test(msg)) {
          return this.errorResponse(req.request_id, 'authorization_unavailable',
            'MCP tool authorization is not available');
        }
        return this.errorResponse(req.request_id, 'invocation_error', 'MCP invocation failed');
      }

      // Parse JSON from text content.
      const text = extractTextFromResult(raw);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return this.errorResponse(req.request_id, 'result_parse_error',
          'MCP result content is not valid JSON');
      }

      const normalized = normalizeResult(parsed, spec);
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

  // checkCapability does a timing-safe comparison of the provided proof
  // against the minted secret. Guards the length check so timingSafeEqual
  // does not throw on mismatched buffer lengths.
  private checkCapability(proof: unknown): boolean {
    if (typeof proof !== 'string') return false;
    const expected = Buffer.from(this.secret, 'utf8');
    const actual = Buffer.from(proof, 'utf8');
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  }

  // errorResponse builds a BridgeResponse with an error body, redacting the
  // secret from the message before it leaves the bridge.
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

// Minimal cancellation-token-source that satisfies LmCancellationToken.
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



