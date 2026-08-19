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
//   | dialog inferred (heuristic: elapsed > DIALOG_THRESHOLD_MS)
//
// Security invariants (non-negotiable — never relax):
//   - The token itself is NEVER streamed, logged, or serialised.
//   - The args passed to invokeTool are NEVER streamed or logged.
//   - The tool RESULT CONTENT is NEVER streamed or logged.
//   - The token never leaves the extension host.

import * as http from 'http';
import type * as vscode from 'vscode';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProbeAttemptRecord {
  label: string;
  ok: boolean;
  exceptionClass: string | null;
  errorCode: string | null;
  elapsedMs: number;
  /** True when elapsed time exceeded DIALOG_THRESHOLD_MS; undefined when ok. */
  dialogInferred: boolean | undefined;
}

export interface ProbeResult {
  toolName: string;
  attempts: ProbeAttemptRecord[];
}

/** Elapsed ms above this threshold suggests a blocking dialog appeared. */
const DIALOG_THRESHOLD_MS = 4_000;

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
 */
export async function runAttempt(
  label: string,
  invokeTool: (token: unknown) => Promise<unknown>,
  token: unknown,
): Promise<ProbeAttemptRecord> {
  const t0 = Date.now();
  try {
    await invokeTool(token);
    const elapsedMs = Date.now() - t0;
    return { label, ok: true, exceptionClass: null, errorCode: null, elapsedMs, dialogInferred: undefined };
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
    const dialogInferred = elapsedMs > DIALOG_THRESHOLD_MS;
    return { label, ok: false, exceptionClass, errorCode, elapsedMs, dialogInferred };
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
 */
export async function runProbe(
  invokeToolFn: (token: unknown) => Promise<unknown>,
  token: unknown,
): Promise<ProbeAttemptRecord[]> {
  const results: ProbeAttemptRecord[] = [];

  // T1 — synchronous (no await before invocation)
  results.push(await runAttempt('T1-synchronous', invokeToolFn, token));

  // T2 — after a microtask
  await Promise.resolve();
  results.push(await runAttempt('T2-microtask', invokeToolFn, token));

  // T3 — after a macrotask (250 ms)
  await new Promise<void>((r) => setTimeout(r, 250));
  results.push(await runAttempt('T3-macrotask', invokeToolFn, token));

  // T4 — after a real loopback HTTP round-trip
  await loopbackRoundTrip();
  results.push(await runAttempt('T4-loopback', invokeToolFn, token));

  return results;
}

// ─── Markdown table renderer ──────────────────────────────────────────────────

/** Format a single attempt record as a Markdown table row. */
function formatRow(r: ProbeAttemptRecord): string {
  const status = r.ok ? '✅ ok' : '❌ failed';
  const exc = r.exceptionClass ?? '—';
  const code = r.errorCode ?? '—';
  const dialog =
    r.dialogInferred === undefined
      ? '—'
      : r.dialogInferred
      ? '⚠️ likely (inferred from elapsed time)'
      : 'no (inferred)';
  return `| ${r.label} | ${status} | ${exc} | ${code} | ${r.elapsedMs} ms | ${dialog} |`;
}

/**
 * Render the probe results as a Markdown table.
 * NEVER includes token, args, or result content.
 */
export function renderProbeTable(toolName: string, attempts: ProbeAttemptRecord[]): string {
  const header = [
    `### Token-lifetime probe: \`${toolName}\``,
    '',
    '> **Dialog inferred** from elapsed time > 4 s — not API-detected.',
    '',
    '| Attempt | Result | Exception class | Error code | Elapsed | Dialog? |',
    '|---------|--------|-----------------|------------|---------|---------|',
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
 * @param vscodeLmTools  vscode.lm.tools (for tool existence check)
 * @param invokeRaw      vscode.lm.invokeTool (injected for testability; same signature)
 * @param cancellation   cancellation token from the chat request
 * @param response       chat response stream
 */
export async function handleProbeToken(
  promptText: string,
  token: unknown,
  vscodeLmTools: readonly { name: string }[],
  invokeRaw: (
    name: string,
    options: { input: Record<string, unknown>; toolInvocationToken: unknown },
    cancellation: unknown,
  ) => Promise<unknown>,
  cancellation: unknown,
  response: { markdown(text: string): void },
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

  // Build the invokeTool wrapper.
  // SECURITY: toolInput is captured in this closure and never streamed/logged.
  const invokeToolFn = (tok: unknown): Promise<unknown> =>
    invokeRaw(toolName, { input: toolInput, toolInvocationToken: tok }, cancellation);

  response.markdown(`⏳ **probe-token**: running 4 attempts against \`${toolName}\`…\n`);

  const attempts = await runProbe(invokeToolFn, token);
  response.markdown(renderProbeTable(toolName, attempts));
}
