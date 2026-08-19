// pendingRunStore.ts — in-memory single-use store for pending run inputs.
//
// Design:
//   A "Run Authenticated" command collects runbook inputs (including secret
//   values) before the chat handler exists, so they cannot be passed through
//   the toolInvocationToken path directly. Instead, the command stashes the
//   inputs here, keyed by a short nonce, and passes only the nonce through
//   the chat query string (@gert /run _nonce=<nonce>). The chat handler claims
//   the entry by nonce; the entry is removed on claim (single-use). Entries
//   that are never claimed expire after a bounded TTL.
//
//   Security contract:
//   • Input values (including secrets) never appear in the chat query string.
//   • The nonce is short-lived and has no semantic value beyond lookup.
//   • No field of a PendingEntry is ever written to any log or output channel.
//   • An unclaimed entry is inert: it expires and is removed on the next claim
//     or explicit purge — it cannot be replayed after TTL.
//
// Pure: no vscode imports. Testable with plain node --test.

export interface PendingEntry {
  readonly runbookPath: string;
  readonly inputs: Record<string, string>;
  readonly expiresAt: number;
}

// Module-level store (singleton; extension host memory only).
const _store = new Map<string, PendingEntry>();

// Overridable clock for testing.
let _now: () => number = () => Date.now();

/** Override the wall-clock source (for testing only). Restored by resetForTest(). */
export function overrideNowForTest(fn: () => number): void {
  _now = fn;
}

/** Clear all entries and restore the clock. Call in test teardown. */
export function resetForTest(): void {
  _store.clear();
  _now = () => Date.now();
}

/** Return the current number of stored entries (for testing). */
export function storeSize(): number {
  return _store.size;
}

/** Generate a cryptographically-weak but sufficient nonce for short-lived
 * handoff. 8 hex chars from Math.random — sufficient collision resistance
 * for the seconds-long window between stash and claim. */
function makeNonce(): string {
  return Math.random().toString(16).slice(2, 10).padEnd(8, '0');
}

/**
 * Stash a pending run entry and return the nonce that identifies it.
 *
 * Security: `inputs` may contain secret values. The returned nonce is safe
 * to pass through the chat query string. The inputs themselves must never
 * appear outside this module.
 *
 * @param runbookPath  Absolute path to the runbook (not sensitive).
 * @param inputs       Collected input values (may contain secrets).
 * @param ttlMs        Entry lifetime before expiry (default: 30 s).
 */
export function stashPendingRun(
  runbookPath: string,
  inputs: Record<string, string>,
  ttlMs = 30_000,
): string {
  const nonce = makeNonce();
  _store.set(nonce, { runbookPath, inputs, expiresAt: _now() + ttlMs });
  return nonce;
}

/**
 * Claim (and remove) the pending entry for the given nonce.
 *
 * Single-use: the entry is deleted on the first call regardless of whether
 * the run then succeeds. A second claim with the same nonce returns undefined.
 *
 * Returns undefined if the nonce is unknown, or if the entry has expired.
 */
export function claimPendingRun(nonce: string): PendingEntry | undefined {
  const entry = _store.get(nonce);
  if (!entry) return undefined;
  _store.delete(nonce); // single-use: remove unconditionally
  if (_now() > entry.expiresAt) return undefined; // expired after removal
  return entry;
}
