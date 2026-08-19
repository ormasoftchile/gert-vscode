// probeToken.ts — Throwaway diagnostic: does toolInvocationToken survive an await?
//
// This module implements @gert /probe-token. It invokes a caller-specified
// VS Code LM tool four times inside a single live ChatRequestHandler, each
// time using the same request.toolInvocationToken, at increasing scheduling
// distances from the synchronous handler stack:
//
//   T1 — synchronous          (mirrors Petals — expected to work)
//   T2 — after microtask      (Promise.resolve())
//   T3 — after macrotask      (setTimeout 250 ms)
//   T4 — after loopback HTTP  (single trivial round-trip — mirrors Gert topology)
//
// Per-attempt record:
//   label | ok/failed | exception class | error code (if symbolic) | elapsed ms
//   | failure category | allowlisted provider hint
//
// Security invariants (non-negotiable — never relax):
//   - The token itself is NEVER streamed, logged, or serialised.
//   - The args passed to invokeTool are NEVER streamed or logged.
//   - The tool RESULT CONTENT is NEVER streamed or logged.
//   - The token never leaves the extension host.
//
// Diagnostic additions (safe):
//   - The tool's declared inputSchema (public metadata) is streamed to the chat
//     response. A schema mismatch is the most likely cause of consistent ~5s failures.
//   - Raw error text (err.message, err.stack) is written to the OUTPUT CHANNEL ONLY
//     when gert.diagnostics.unsafeErrorText is true.  It NEVER appears in the chat
//     response, HTTP responses, run state, or child-process environment.
//   - Short own-enumerable error properties (e.g. code, name) are always written to
//     the output channel regardless of the setting.

import * as http from 'http';
import { classifyInvocationError, extractProviderHint } from './mcpBridge';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Public metadata shape for a registered LM tool (mirrors vscode.LanguageModelToolInformation). */
export interface LmToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ProbeAttemptRecord {
  label: string;
  ok: boolean;
  exceptionClass: string | null;
  errorCode: string | null;
  elapsedMs: number;
  /** Failure category from classifyInvocationError; null when ok. */
  category: string | null;
  /** Allowlisted provider hint from extractProviderHint; null when ok or no hint available. */
  providerHint: string | null;
}

export interface ProbeResult {
  toolName: string;
  attempts: ProbeAttemptRecord[];
}

// ─── Schema dump ──────────────────────────────────────────────────────────────

/**
 * Build a Markdown section that dumps the tool's declared inputSchema and a
 * one-line property-name verdict comparing the supplied input against it.
 *
 * Security: only property NAMES appear in the verdict — never property VALUES.
 * The inputSchema itself is public tool metadata; streaming it is intentional.
 */
export function buildSchemaDump(
  toolName: string,
  toolInput: Record<string, unknown>,
  tools: readonly LmToolInfo[],
): string {
  const info = tools.find((t) => t.name === toolName);
  if (!info) {
    return `> **Schema:** \`${toolName}\` not found in registry (unexpected — tool existence check passed).\n\n`;
  }

  const desc =
    typeof info.description === 'string'
      ? info.description.slice(0, 300)
      : '*(no description)*';

  const schemaJson = JSON.stringify(info.inputSchema ?? null, null, 2);

  const verdict = schemaVerdict(toolInput, info.inputSchema);

  return (
    `### Declared schema for \`${toolName}\`\n\n` +
    `**Description:** ${desc}\n\n` +
    `**Input schema:**\n\`\`\`json\n${schemaJson}\n\`\`\`\n\n` +
    `**Property-name verdict:** ${verdict}\n\n`
  );
}

/**
 * Compare the supplied toolInput keys against the declared JSON Schema.
 * Reports only property NAMES — never property values.
 */
export function schemaVerdict(
  toolInput: Record<string, unknown>,
  inputSchema: unknown,
): string {
  const schema =
    inputSchema !== null && typeof inputSchema === 'object'
      ? (inputSchema as { required?: string[]; properties?: Record<string, unknown> })
      : undefined;

  const suppliedKeys = Object.keys(toolInput);
  const requiredKeys: string[] = Array.isArray(schema?.required) ? schema!.required as string[] : [];
  const schemaProps: string[] | null =
    schema?.properties && typeof schema.properties === 'object'
      ? Object.keys(schema.properties)
      : null;

  const missingRequired = requiredKeys.filter((k) => !suppliedKeys.includes(k));
  const unknownSupplied = schemaProps
    ? suppliedKeys.filter((k) => !schemaProps.includes(k))
    : [];

  const parts: string[] = [];
  if (missingRequired.length > 0) {
    parts.push(`missing required: ${missingRequired.map((k) => `\`${k}\``).join(', ')}`);
  }
  if (unknownSupplied.length > 0) {
    parts.push(`not in schema: ${unknownSupplied.map((k) => `\`${k}\``).join(', ')}`);
  }
  if (parts.length === 0) {
    return '✅ all required properties present; no unknown properties supplied.';
  }
  return '⚠️ ' + parts.join(' | ');
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

export interface ParsedProbeArgs {
  toolName: string;
  toolInput: Record<string, unknown>;
}

/**
 * Parse the prompt text for /probe-token.
 * Expected format: `<toolName> <jsonObject>`
 * Returns an error string on failure, ParsedProbeArgs on success.
 */
export function parseProbeArgs(
  promptText: string,
): { ok: true; value: ParsedProbeArgs } | { ok: false; error: string } {
  const trimmed = promptText.trim();
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) {
    return {
      ok: false,
      error:
        'Usage: `@gert /probe-token <toolName> <jsonInput>`\n\n' +
        'Example: `@gert /probe-token mcp_icm_get_incident {"incidentId": 123456}`\n\n' +
        'No JSON input found after the tool name.',
    };
  }
  const toolName = trimmed.slice(0, spaceIdx);
  const jsonPart = trimmed.slice(spaceIdx + 1).trim();
  let toolInput: Record<string, unknown>;
  try {
    const parsed = JSON.parse(jsonPart) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        error:
          `Usage: \`@gert /probe-token <toolName> <jsonObject>\`\n\n` +
          `The JSON input must be an object (got ${Array.isArray(parsed) ? 'array' : typeof parsed}).`,
      };
    }
    toolInput = parsed as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      error:
        `Usage: \`@gert /probe-token <toolName> <jsonObject>\`\n\n` +
        `Failed to parse JSON input. Check your syntax.\n\n` +
        `Received: \`${jsonPart.slice(0, 120)}\``,
    };
  }
  return { ok: true, value: { toolName, toolInput } };
}

// ─── Single attempt executor ─────────────────────────────────────────────────

/**
 * Execute a single probe attempt.
 * Never logs, streams, or serialises the token, args, or result content.
 *
 * When outputChannel is provided:
 *   - Always logs short own-enumerable error properties (e.g. code) — never
 *     message or stack, which are free-text blobs.
 *   - When unsafeErrorText is true, additionally logs err.message and err.stack
 *     to the OUTPUT CHANNEL ONLY.  This text NEVER enters the chat response,
 *     HTTP responses, run state, or child-process environment.
 */
export async function runAttempt(
  label: string,
  invokeTool: (token: unknown) => Promise<unknown>,
  token: unknown,
  outputChannel?: { appendLine(text: string): void } | null,
  unsafeErrorText?: boolean,
): Promise<ProbeAttemptRecord> {
  const t0 = Date.now();
  try {
    await invokeTool(token);
    const elapsedMs = Date.now() - t0;
    return { label, ok: true, exceptionClass: null, errorCode: null, elapsedMs, category: null, providerHint: null };
  } catch (err: unknown) {
    const elapsedMs = Date.now() - t0;
    const exceptionClass =
      err instanceof Error ? err.constructor.name : (err === null ? 'null' : typeof err);
    // Only capture a code property if it looks like a short symbolic string.
    const rawCode = (err !== null && typeof err === 'object' && 'code' in err)
      ? (err as Record<string, unknown>).code
      : undefined;
    const errorCode =
      typeof rawCode === 'string' && rawCode.length <= 64 ? rawCode : null;
    const category = classifyInvocationError(err);
    const providerHint = extractProviderHint(err);

    if (outputChannel) {
      // Always: log short own-enumerable symbolic properties (never message/stack).
      if (err !== null && typeof err === 'object') {
        for (const key of Object.keys(err as object)) {
          if (key === 'message' || key === 'stack') continue; // free-text blobs — excluded
          const val = (err as Record<string, unknown>)[key];
          if ((typeof val === 'string' && val.length <= 64) || typeof val === 'number') {
            outputChannel.appendLine(`[probe] ${label} err.${key} = ${String(val)}`);
          }
        }
      }
      // Opt-in: raw error text to output channel ONLY — never in chat/HTTP/state.
      if (unsafeErrorText && err instanceof Error) {
        outputChannel.appendLine(`[probe] ${label} err.message: ${err.message}`);
        if (err.stack) {
          outputChannel.appendLine(`[probe] ${label} err.stack: ${err.stack}`);
        }
      }
    }

    return { label, ok: false, exceptionClass, errorCode, elapsedMs, category, providerHint };
  }
}

// ─── Trivial loopback round-trip ─────────────────────────────────────────────

/**
 * Performs a trivial loopback HTTP round-trip to simulate Gert's topology.
 * The server is spun up, handles one request, then shut down.
 * The response body contains only a nonce — no credentials, no token.
 */
export function loopbackRoundTrip(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as import('net').AddressInfo;
      const opts: http.RequestOptions = {
        hostname: '127.0.0.1',
        port: addr.port,
        path: '/',
        method: 'GET',
      };
      const req = http.request(opts, (res) => {
        res.resume(); // drain and discard
        res.on('end', () => {
          server.close((err) => {
            if (err) reject(err); else resolve();
          });
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      req.end();
    });
    server.on('error', reject);
  });
}

// ─── Four-attempt probe ──────────────────────────────────────────────────────

/**
 * Run the four-attempt token-lifetime probe.
 *
 * CALLER MUST provide `invokeToolFn` — a function that calls
 * `vscode.lm.invokeTool(toolName, { input: toolInput, toolInvocationToken: token }, cancellationToken)`.
 * The function receives the token as a raw value.  Nothing about the token,
 * the args, or the result content is ever accessed here.
 *
 * The four attempts are always executed in order; a failure in an earlier
 * attempt does not stop later attempts.
 *
 * @param invokeToolFn  Wrapper around vscode.lm.invokeTool (injected for testability)
 * @param token         The toolInvocationToken from the live ChatRequestHandler
 * @param outputChannel Optional output channel for error diagnostics (never chat/HTTP/state)
 * @param unsafeErrorText When true, raw error text is written to outputChannel only
 */
export async function runProbe(
  invokeToolFn: (token: unknown) => Promise<unknown>,
  token: unknown,
  outputChannel?: { appendLine(text: string): void } | null,
  unsafeErrorText?: boolean,
): Promise<ProbeAttemptRecord[]> {
  const results: ProbeAttemptRecord[] = [];

  // T1 — synchronous (no await before invocation)
  results.push(await runAttempt('T1-synchronous', invokeToolFn, token, outputChannel, unsafeErrorText));

  // T2 — after a microtask
  await Promise.resolve();
  results.push(await runAttempt('T2-microtask', invokeToolFn, token, outputChannel, unsafeErrorText));

  // T3 — after a macrotask (250 ms)
  await new Promise<void>((r) => setTimeout(r, 250));
  results.push(await runAttempt('T3-macrotask', invokeToolFn, token, outputChannel, unsafeErrorText));

  // T4 — after a real loopback HTTP round-trip
  await loopbackRoundTrip();
  results.push(await runAttempt('T4-loopback', invokeToolFn, token, outputChannel, unsafeErrorText));

  return results;
}

// ─── Markdown table renderer ──────────────────────────────────────────────────

/** Format a single attempt record as a Markdown table row. */
function formatRow(r: ProbeAttemptRecord): string {
  const status = r.ok ? '✅ ok' : '❌ failed';
  const exc = r.exceptionClass ?? '—';
  const code = r.errorCode ?? '—';
  const cat = r.category ?? '—';
  const hint = r.providerHint ? r.providerHint : '—';
  return `| ${r.label} | ${status} | ${exc} | ${code} | ${r.elapsedMs} ms | ${cat} | ${hint} |`;
}

/**
 * Render the probe results as a Markdown table.
 * NEVER includes token, args, or result content.
 */
export function renderProbeTable(toolName: string, attempts: ProbeAttemptRecord[]): string {
  const header = [
    `### Token-lifetime probe: \`${toolName}\``,
    '',
    '| Attempt | Result | Exception class | Error code | Elapsed | Category | Provider hint |',
    '|---------|--------|-----------------|------------|---------|----------|---------------|',
  ];
  const rows = attempts.map(formatRow);
  return [...header, ...rows, ''].join('\n');
}

// ─── Chat handler entry point ─────────────────────────────────────────────────

/**
 * Handle a /probe-token chat request.
 * Streams a result table to `response`; never exposes token, args, or result content.
 *
 * @param promptText     request.prompt (text after the command name)
 * @param token          request.toolInvocationToken (the live handler token)
 * @param vscodeLmTools  vscode.lm.tools (for tool existence check and schema dump)
 * @param invokeRaw      vscode.lm.invokeTool (injected for testability; same signature)
 * @param cancellation   cancellation token from the chat request
 * @param response       chat response stream
 * @param outputChannel  extension output channel for error diagnostics (never chat/HTTP/state)
 * @param unsafeErrorText when true, raw err.message/stack are written to outputChannel only
 */
export async function handleProbeToken(
  promptText: string,
  token: unknown,
  vscodeLmTools: readonly LmToolInfo[],
  invokeRaw: (
    name: string,
    options: { input: Record<string, unknown>; toolInvocationToken: unknown },
    cancellation: unknown,
  ) => Promise<unknown>,
  cancellation: unknown,
  response: { markdown(text: string): void },
  outputChannel?: { appendLine(text: string): void } | null,
  unsafeErrorText?: boolean,
): Promise<void> {
  const parsed = parseProbeArgs(promptText);
  if (!parsed.ok) {
    response.markdown(`❌ **probe-token: bad arguments**\n\n${parsed.error}`);
    return;
  }

  const { toolName, toolInput } = parsed.value;

  // Verify the tool exists in the current LM tool registry.
  const exists = vscodeLmTools.some((t) => t.name === toolName);
  if (!exists) {
    // List only tool names — no sensitive details.
    const available = vscodeLmTools.map((t) => t.name).join(', ') || '(none registered)';
    response.markdown(
      `❌ **probe-token: tool not found**\n\n` +
      `Tool \`${toolName}\` is not registered in \`vscode.lm.tools\`.\n\n` +
      `Registered tools: ${available}`,
    );
    return;
  }

  // Dump the tool's declared inputSchema (public metadata) and a property-name verdict.
  // This is the highest-value datum: a schema mismatch explains consistent ~5s failures.
  response.markdown(buildSchemaDump(toolName, toolInput, vscodeLmTools));

  // Build the invokeTool wrapper.
  // SECURITY: toolInput is captured in this closure and never streamed/logged.
  const invokeToolFn = (tok: unknown): Promise<unknown> =>
    invokeRaw(toolName, { input: toolInput, toolInvocationToken: tok }, cancellation);

  response.markdown(`⏳ **probe-token**: running 4 attempts against \`${toolName}\`…\n`);

  const attempts = await runProbe(invokeToolFn, token, outputChannel, unsafeErrorText ?? false);
  response.markdown(renderProbeTable(toolName, attempts));
}
