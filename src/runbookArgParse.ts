// runbookArgParse.ts — pure argument parser for the @gert /run chat prompt.
//
// No vscode imports — fully testable with plain node --test.
//
// Grammar (all fields optional):
//   /run [<runbookPath>] [key=value ...] [_nonce=<nonce>]
//
// Rules:
//   • The first whitespace-delimited token that does NOT contain '=' (at
//     position > 0) is the runbook path.  A leading '=' (e.g. "=bad") is
//     treated as a kv pair with an empty key and is ignored.
//   • All remaining tokens of the form key=value are parsed as inputs.
//     Only the first '=' is the separator; a value such as "a=b=c" yields
//     key "a", value "b=c" — the extra '=' is preserved verbatim.
//   • The special key _nonce is extracted into ParsedRunArgs.nonce and is
//     NOT included in the inputs map.
//   • An empty or whitespace-only prompt yields all-undefined/empty fields.
//
// Five edge cases covered by tests (PARSE-1..5 in runbookArgParse.test.js):
//   PARSE-1: bare "" / whitespace                → no path, no inputs, no nonce
//   PARSE-2: "/run path/to/file.runbook.yaml"    → path set, inputs empty
//   PARSE-3: "/run key=value"                    → no path, one input
//   PARSE-4: "/run path/to/file.runbook.yaml k=v"→ both path and input
//   PARSE-5: "/run k=v=with=equals"              → value contains '=', correct

export interface ParsedRunArgs {
  /** Explicitly supplied runbook path, or undefined if absent. */
  runbookPath: string | undefined;
  /** Collected key=value inputs (never contains _nonce). */
  inputs: Record<string, string>;
  /** Extracted nonce for the pending-run store, or undefined if absent. */
  nonce: string | undefined;
}

/**
 * Parse the prompt text that follows "@gert /run" into its components.
 *
 * The prompt is split on whitespace; each token is classified:
 *   • No '=' at position > 0 → positional (first one becomes runbookPath).
 *   • Contains '=' at position > 0 → key=value pair.
 *   • Key is "_nonce" → nonce; otherwise added to inputs.
 */
export function parseRunArgs(prompt: string): ParsedRunArgs {
  const tokens = prompt.trim().split(/\s+/).filter(Boolean);
  let runbookPath: string | undefined;
  const inputs: Record<string, string> = {};
  let nonce: string | undefined;

  for (const token of tokens) {
    const eqIdx = token.indexOf('=');
    if (eqIdx <= 0) {
      // Positional token (no '=' or '=' at position 0 → not a kv pair).
      // Only the first positional token is treated as the runbook path.
      if (runbookPath === undefined) {
        runbookPath = token;
      }
    } else {
      const key = token.slice(0, eqIdx);
      const value = token.slice(eqIdx + 1); // value may itself contain '='
      if (key === '_nonce') {
        nonce = value;
      } else {
        inputs[key] = value;
      }
    }
  }

  return { runbookPath, inputs, nonce };
}

/**
 * Determine the runbook path to use for a /run invocation.
 *
 * Precedence:
 *   1. Explicit path from prompt (must end in .runbook.yaml).
 *   2. Active editor path (must end in .runbook.yaml).
 *   3. undefined → caller should show a picker.
 *
 * A non-.runbook.yaml active editor is NOT silently used — it returns
 * undefined so the picker is shown rather than running the wrong file.
 *
 * @param promptPath       Path from parseRunArgs (may be undefined).
 * @param activeEditorPath document.fileName of the active editor (may be undefined).
 */
export function resolveRunbookPath(
  promptPath: string | undefined,
  activeEditorPath: string | undefined,
): string | undefined {
  if (promptPath !== undefined && promptPath.endsWith('.runbook.yaml')) {
    return promptPath;
  }
  if (activeEditorPath !== undefined && activeEditorPath.endsWith('.runbook.yaml')) {
    return activeEditorPath;
  }
  return undefined;
}

/**
 * Format the output-channel log line emitted when a run starts.
 *
 * Security: only runId and runbookPath are included — never input values.
 * Extracted as a pure function so tests can assert the format without
 * a VS Code runtime.
 */
export function formatRunStartLog(runId: string, runbookPath: string): string {
  return `[gert run] run=${runId} runbook=${runbookPath}`;;
}

/**
 * Build the chat query string for the Run Authenticated command → chat
 * handler handoff. Only the nonce (and optionally the runbook path, which
 * is not sensitive) are embedded; input values are never included.
 *
 * Security: this function MUST NOT receive raw input values.  The pending-run
 * store holds values; this function receives only the nonce that keys them.
 */
export function buildRunChatQuery(nonce: string, runbookPath?: string): string {
  // runbookPath is included so the handler has a display label; the nonce
  // is the authoritative source for inputs. If absent, the handler resolves
  // the path from the pending entry.
  const pathPart = runbookPath ? ` ${runbookPath}` : '';
  return `@gert /run${pathPart} _nonce=${nonce}`;
}
