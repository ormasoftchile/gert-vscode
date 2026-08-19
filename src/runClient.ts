// runClient.ts — Minimal HTTP client for Gert server run lifecycle.
//
// Uses Node's built-in http module.  No vscode imports.
// All exported functions are pure async I/O and are testable with node --test.

import * as http from 'http';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RunState {
  /** engine.RunStatus value: "pending"|"running"|"completed"|"failed"|"cancelled" */
  status: string;
  currentStep?: string;
}

/** Terminal statuses per engine.RunStatus (interactions.go, isTerminalState). */
export const TERMINAL_STATUSES = new Set<string>(['completed', 'failed', 'cancelled']);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

// ─── API ──────────────────────────────────────────────────────────────────────

/**
 * POST /runs — creates a new run and returns the runID.
 *
 * Returns 201 immediately; Gert drives the run in a background goroutine
 * (interactions.go handleRunsCreate: `go s.advanceRun(runCtx, entry)`).
 */
export async function createRun(
  base: string,
  runbookPath: string,
  inputs: Record<string, string>,
): Promise<string> {
  const body = JSON.stringify({
    runbookPath,
    inputs,
    mode: 'real',
    actor: 'vscode',
  });
  const { status, responseBody } = await httpRequest('POST', `${base}/runs`, body, 'application/json');
  if (status !== 201) {
    throw new Error(`POST /runs: unexpected status ${status}: ${responseBody.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    throw new Error(`POST /runs: invalid JSON response: ${responseBody.slice(0, 200)}`);
  }
  const runID = (parsed as Record<string, unknown>).runID;
  if (typeof runID !== 'string' || !runID) {
    throw new Error('POST /runs: missing runID in response');
  }
  return runID;
}

/**
 * DELETE /runs/{id} — cancels a run.  Idempotent (returns 204 even if already
 * complete; only 404 indicates the run was never registered).
 */
export async function deleteRun(base: string, runId: string): Promise<void> {
  const { status } = await httpRequest(
    'DELETE',
    `${base}/runs/${encodeURIComponent(runId)}`,
    '',
    '',
  );
  if (status !== 204 && status !== 404) {
    throw new Error(`DELETE /runs/${runId}: unexpected status ${status}`);
  }
}

/**
 * Poll the run state once via JSON-RPC POST /rpc (method "run.status").
 * Returns null when the server is unreachable or the run is not found.
 */
export async function pollRunState(base: string, runId: string): Promise<RunState | null> {
  const reqBody = JSON.stringify({
    jsonrpc: '2.0',
    method: 'run.status',
    params: { runID: runId },
    id: 1,
  });
  let status: number;
  let responseBody: string;
  try {
    ({ status, responseBody } = await httpRequest('POST', `${base}/rpc`, reqBody, 'application/json'));
  } catch {
    return null;
  }
  if (status !== 200) return null;
  try {
    const parsed = JSON.parse(responseBody) as {
      result?: { state?: string; currentStep?: string };
      error?: unknown;
    };
    if (!parsed.result) return null;
    return {
      status: parsed.result.state ?? 'unknown',
      currentStep: parsed.result.currentStep,
    };
  } catch {
    return null;
  }
}

/**
 * Polls `GET /runs/{id}/state` (via repeated JSON-RPC calls) until the run
 * reaches a terminal status or the AbortSignal fires.
 *
 * Resolves with the terminal status string.
 * Rejects with an Error when the signal fires or the server becomes
 * unreachable for maxConsecutiveFailures consecutive polls.
 */
export function waitForTerminalState(
  base: string,
  runId: string,
  signal: AbortSignal,
  pollIntervalMs = 500,
  maxConsecutiveFailures = 6, // ~3 s at default interval
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let done = false;
    let consecutiveFailures = 0;
    let timerId: ReturnType<typeof setInterval>;

    const finish = (status: string): void => {
      if (done) return;
      done = true;
      clearInterval(timerId);
      resolve(status);
    };

    const fail = (err: Error): void => {
      if (done) return;
      done = true;
      clearInterval(timerId);
      reject(err);
    };

    const poll = (): void => {
      if (done) return;
      pollRunState(base, runId).then((state) => {
        if (done) return;
        if (state === null) {
          consecutiveFailures++;
          if (consecutiveFailures >= maxConsecutiveFailures) {
            fail(new Error('gert server unreachable'));
          }
          return;
        }
        consecutiveFailures = 0;
        if (isTerminalStatus(state.status)) {
          finish(state.status);
        }
      }).catch(() => {
        consecutiveFailures++;
        if (consecutiveFailures >= maxConsecutiveFailures) {
          fail(new Error('gert server unreachable'));
        }
      });
    };

    // Immediate first poll.
    poll();
    timerId = setInterval(poll, pollIntervalMs);

    signal.addEventListener('abort', () => {
      clearInterval(timerId);
      done = true;
      // Do NOT call reject here — the caller (runLoop) handles AbortSignal
      // termination by racing with cancelPromise.  We just stop polling.
    });
  });
}

// ─── Internal HTTP helper ────────────────────────────────────────────────────

function httpRequest(
  method: string,
  url: string,
  body: string,
  contentType: string,
): Promise<{ status: number; responseBody: string }> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      reject(new Error(`httpRequest: invalid URL "${url}"`));
      return;
    }
    const opts: http.RequestOptions = {
      hostname: u.hostname,
      port: u.port ? Number(u.port) : undefined,
      path: u.pathname + (u.search ?? ''),
      method,
      headers: body
        ? {
            'Content-Type': contentType,
            'Content-Length': Buffer.byteLength(body),
          }
        : undefined,
    };
    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          responseBody: Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
