// runLoop.ts — Pure run-loop logic for @gert /run handler.
//
// Keeps the chat handler active until the run reaches a terminal state,
// draining the invocation pump between state polls so tool calls are
// processed from within the live handler execution context.
//
// No vscode imports — fully exercisable with plain node --test.

import { RunPump, invokeWithTwoAttempts, RealInvokeFunc } from './runPump';

// ─── Deps interface ───────────────────────────────────────────────────────────

export interface RunLoopDeps {
  /**
   * Resolves with the terminal status string when the run completes, or
   * rejects if the server becomes unreachable.
   *
   * @param runId  — the run ID to watch
   * @param signal — AbortSignal fired when the loop exits (cleanup hook)
   */
  waitForTerminal(runId: string, signal: AbortSignal): Promise<string>;

  /** DELETE /runs/{id}.  Called on cancellation only. */
  deleteRun(runId: string): Promise<void>;

  /** Relay a progress or status message (called at each state transition). */
  onProgress(msg: string): void;
}

// ─── Result ───────────────────────────────────────────────────────────────────

export interface RunLoopResult {
  /** Terminal status string or "unknown" for deadline/server_dead. */
  status: string;
  /** How the loop terminated. */
  reason: 'terminal' | 'cancelled' | 'deadline' | 'server_dead';
}

// ─── Loop ─────────────────────────────────────────────────────────────────────

/**
 * Drives the pump consumer loop.
 *
 * Architecture:
 *   • A background pump-processor task drains `pump` as items arrive and
 *     calls `invokeWithTwoAttempts` (fire-and-forget) for each item.
 *   • The main task awaits `Promise.race([terminal, cancel, deadline])`.
 *   • On exit (any cause), the finally block aborts the state-watch signal,
 *     closes the pump (rejecting any undrained items), and awaits the pump
 *     processor so the function never returns with in-flight processor work.
 *
 * @param pump          RunPump for this run (one per @gert /run invocation)
 * @param runId         Run ID returned by POST /runs
 * @param deps          Injectable network/progress dependencies
 * @param handlerToken  Live toolInvocationToken from vscode.ChatRequest
 * @param realInvoke    Calls vscode.lm.invokeTool (injected for testability)
 * @param cancelPromise Resolves when the VS Code handler's CancellationToken fires
 * @param deadlineMs    Maximum wall-clock duration before force-termination
 * @param output        Optional output channel for per-attempt log lines
 */
export async function runLoop(
  pump: RunPump,
  runId: string,
  deps: RunLoopDeps,
  handlerToken: unknown,
  realInvoke: RealInvokeFunc,
  cancelPromise: Promise<void>,
  deadlineMs: number,
  output?: { appendLine(s: string): void },
): Promise<RunLoopResult> {
  const ac = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  // A timer-based Promise that resolves (not rejects) when the deadline fires.
  // Using resolve avoids try/catch complexity in Promise.race.
  const deadlineResolvePromise = new Promise<{ kind: 'deadline' }>((resolve) => {
    deadlineTimer = setTimeout(() => resolve({ kind: 'deadline' }), deadlineMs);
  });

  // Pump processor: runs concurrently with the state watch.
  // Sequential `while (!closed) { await waitForItem(); drainSync(); ... }`.
  // invokeWithTwoAttempts is fire-and-forget — the loop does not block on
  // individual invocations; errors are delivered via item.reject().
  const pumpTask = (async () => {
    while (!pump.closed) {
      await pump.waitForItem();
      const items = pump.drainSync();
      for (const item of items) {
        void invokeWithTwoAttempts(item, handlerToken, realInvoke, output);
      }
    }
  })();

  // Initialise so TypeScript is happy even if the switch somehow misses a case.
  let result: RunLoopResult = { status: 'unknown', reason: 'server_dead' };

  try {
    type Winner =
      | { kind: 'terminal'; status: string }
      | { kind: 'cancelled' }
      | { kind: 'deadline' }
      | { kind: 'server_dead' };

    const winner: Winner = await Promise.race([
      deps
        .waitForTerminal(runId, ac.signal)
        .then((s) => ({ kind: 'terminal' as const, status: s }))
        .catch(() => ({ kind: 'server_dead' as const })),
      cancelPromise.then(() => ({ kind: 'cancelled' as const })),
      deadlineResolvePromise,
    ]);

    switch (winner.kind) {
      case 'terminal': {
        const s = (winner as { kind: 'terminal'; status: string }).status;
        deps.onProgress(`Run ${runId}: ${s}`);
        result = { status: s, reason: 'terminal' };
        break;
      }
      case 'cancelled':
        deps.onProgress(`Cancelling run ${runId}…`);
        await deps.deleteRun(runId).catch((err: unknown) => {
          output?.appendLine(
            `[gert run] DELETE /runs/${runId} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
        result = { status: 'cancelled', reason: 'cancelled' };
        break;
      case 'deadline':
        result = { status: 'unknown', reason: 'deadline' };
        break;
      case 'server_dead':
        result = { status: 'unknown', reason: 'server_dead' };
        break;
    }
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    // Signal the state-watch dependency to stop polling.
    ac.abort();
    // Close the pump: rejects any undrained items and wakes the processor.
    pump.close('run loop exiting');
    // Wait for the processor to exit its while loop before returning.
    await pumpTask;
  }

  return result;
}
