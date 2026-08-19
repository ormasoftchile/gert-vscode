// runPump.ts — In-handler invocation pump for @gert /run.
//
// The bridge enqueues a call via lm.invokeTool(); the @gert /run chat handler
// dequeues it and calls vscode.lm.invokeTool() from its own execution context
// so VS Code's call-context enforcement is satisfied.
//
// Petals design reference: mcpBridgeGeneric.ts ~320-345 (invokeMcpTool) and
// extension.ts ~346-360 (arm-and-immediately-await pattern).
//
// This module has NO vscode imports — exercisable with plain node --test.

// ─── Pending invocation item ──────────────────────────────────────────────────

export interface PendingInvocation {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly resolve: (result: unknown) => void;
  readonly reject: (err: unknown) => void;
}

// ─── RunPump ──────────────────────────────────────────────────────────────────

/**
 * Async queue that bridges bridge-side enqueue() calls (from the HTTP request
 * handler) with handler-side drain calls (from the chat-participant handler).
 *
 * The bridge's lm.invokeTool() implementation calls enqueue(); the chat handler
 * drives the real vscode.lm.invokeTool() call and resolves each item.
 */
export class RunPump {
  private _queue: PendingInvocation[] = [];
  // Only one waiter at a time — the pump processor loop is sequential.
  private _waiter: (() => void) | null = null;
  private _closed = false;

  /**
   * Enqueue a tool invocation. Returns a Promise that resolves or rejects
   * when the chat handler processes the item. Rejects immediately if the
   * pump is already closed.
   */
  enqueue(toolName: string, input: Record<string, unknown>): Promise<unknown> {
    if (this._closed) {
      return Promise.reject(new Error('RunPump: pump is closed'));
    }
    return new Promise<unknown>((resolve, reject) => {
      this._queue.push({ toolName, input, resolve, reject });
      // Wake any waiting drainer.
      const w = this._waiter;
      this._waiter = null;
      w?.();
    });
  }

  /**
   * Returns all pending items and clears the queue synchronously.
   */
  drainSync(): PendingInvocation[] {
    return this._queue.splice(0);
  }

  /**
   * Returns a Promise that resolves when at least one item is queued (or
   * when the pump is closed). Does not consume the items.
   *
   * At most one concurrent call is supported (the pump processor loop).
   */
  waitForItem(): Promise<void> {
    if (this._queue.length > 0 || this._closed) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      // All assignments inside the Promise constructor are synchronous; no
      // race with close() because JavaScript is single-threaded.
      this._waiter = resolve;
    });
  }

  /**
   * Close the pump. All items still in the queue are rejected with an Error
   * describing the reason. Signals any outstanding waitForItem() waiter.
   * Idempotent.
   */
  close(reason = 'RunPump: pump closed'): void {
    if (this._closed) return;
    this._closed = true;
    const items = this._queue.splice(0);
    const err = new Error(reason);
    for (const item of items) item.reject(err);
    const w = this._waiter;
    this._waiter = null;
    w?.();
  }

  get closed(): boolean { return this._closed; }
  get size(): number { return this._queue.length; }
}

// ─── Canceled-error predicate ─────────────────────────────────────────────────
// Petals-derived (mcpBridgeGeneric.ts ~330, Petals codebase):
//
//   if (msg.includes("Canceled") && token !== undefined) { retry without token }
//
// VS Code raises an error whose message contains "Canceled" (capital C) when a
// tool invocation dialog is dismissed, or the invocation is cancelled by the
// runtime with a token.  We match the exact word "Canceled" rather than the
// substring "cancel" to avoid false positives from unrelated messages such as
// "cannot cancel active request" or "cancellation token required".
//
// We also match "cancelled" (British spelling) as a defensive measure.
//
// Risk: if VS Code changes this string, the Canceled branch is skipped and the
// second (no-token) attempt is not made.  The error then surfaces at the bridge
// as `invocation_error` rather than triggering the retry.  This failure mode is
// named and observable in the output-channel log.  The predicate is exported so
// test code can verify it without relying on an actual VS Code host.

export function isCanceledError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Match word boundary on "Canceled" (VS Code style) OR "cancelled" (British).
  return /\bCanceled\b/.test(msg) || /\bcancelled\b/i.test(msg);
}

// ─── Two-attempt invocation ───────────────────────────────────────────────────

/** Calls vscode.lm.invokeTool — or a test stub with the same shape. */
export type RealInvokeFunc = (
  toolName: string,
  input: Record<string, unknown>,
  token: unknown,
) => Promise<unknown>;

/**
 * Invokes a tool with at most two attempts, Petals-derived:
 *
 *   Attempt 1: with the live handler token (suppresses VS Code consent dialog).
 *   Attempt 2: only when attempt 1 throws a Canceled-class error AND a token
 *              was present — retry with token=undefined so VS Code may show the
 *              consent dialog instead.
 *
 * On a non-Canceled failure at attempt 1, no retry is made.
 * On any failure at attempt 2, item.reject() is called.
 *
 * Security: the token is NEVER written to the output channel.  Only the attempt
 * index and tool name are logged.
 */
export async function invokeWithTwoAttempts(
  item: PendingInvocation,
  handlerToken: unknown,
  realInvoke: RealInvokeFunc,
  output?: { appendLine(s: string): void },
): Promise<void> {
  try {
    const result = await realInvoke(item.toolName, item.input, handlerToken);
    output?.appendLine(`[gert run] invokeTool "${item.toolName}": attempt 1 succeeded`);
    item.resolve(result);
  } catch (firstErr: unknown) {
    if (isCanceledError(firstErr) && handlerToken !== undefined) {
      output?.appendLine(
        `[gert run] invokeTool "${item.toolName}": attempt 1 Canceled — retrying without token`,
      );
      try {
        const result = await realInvoke(item.toolName, item.input, undefined);
        output?.appendLine(`[gert run] invokeTool "${item.toolName}": attempt 2 succeeded`);
        item.resolve(result);
      } catch (secondErr: unknown) {
        output?.appendLine(`[gert run] invokeTool "${item.toolName}": attempt 2 failed`);
        item.reject(secondErr);
      }
    } else {
      output?.appendLine(`[gert run] invokeTool "${item.toolName}": attempt 1 failed (no retry)`);
      item.reject(firstErr);
    }
  }
}

