// serverLaunch.ts — pure decision functions for spawning the gert server.
//
// No vscode dependency. All functions are deterministic given their inputs so
// they can be unit-tested without an extension host or a spawned process.
// serverManager.ts is a thin caller that provides the runtime inputs.

import * as fs from 'fs';
import * as path from 'path';

/**
 * localServerAddress returns the bind address string passed to `gert serve
 * --addr`. Always 127.0.0.1, never a bare :port or localhost:
 *
 *   - Bare `:port` — gert core rejects non-loopback connections without auth.
 *   - `localhost` — on dual-stack hosts resolves to ::1 (IPv6), a different
 *     socket than the IPv4 bind; every probe request would ECONNREFUSED.
 */
export function localServerAddress(port: number): string {
  return `127.0.0.1:${port}`;
}

/**
 * buildServeArgs constructs the argv array for `gert serve`.
 *
 * - Always an array: no shell string, no quoting hazard, no interpolation.
 * - `--package-map` is included ONLY when `packageMapPath` is provided.
 *   Passing an empty string is never the right behaviour and is guarded
 *   at the call site by returning undefined from resolvePackageMapPath.
 */
export function buildServeArgs(addr: string, packageMapPath?: string): string[] {
  if (packageMapPath !== undefined) {
    return ['serve', '--addr', addr, '--package-map', packageMapPath];
  }
  return ['serve', '--addr', addr];
}

/**
 * resolvePackageMapPath returns the absolute path of the package-map file to
 * pass to `gert serve --package-map`, or undefined when none applies (flag
 * must be omitted).
 *
 * Resolution chain (highest priority first):
 *   1. `settingValue` — the value of the `gert.packageMap` VS Code setting.
 *      - Absolute: used as-is.
 *      - Relative: resolved against `projectRoot` (the active runbook's
 *        project root from pickServerRoot — never workspaceFolders[0]).
 *      - If the resolved path is not a file, logs a missed hit and falls
 *        through (no silent truncation; the caller logs the warning).
 *   2. Convention — `<projectRoot>/package-map.yaml`, if present.
 *   3. undefined — `--package-map` is omitted from the argv array.
 *
 * Returning undefined from step 3 is the only way `--package-map` is absent.
 * An empty string is never returned; the caller (buildServeArgs) must not
 * receive one.
 */
export function resolvePackageMapPath(
  projectRoot: string,
  settingValue: string | undefined,
): string | undefined {
  // Step 1: explicit setting value.
  if (settingValue && settingValue.trim()) {
    const resolved = path.isAbsolute(settingValue)
      ? settingValue
      : path.join(projectRoot, settingValue);
    try {
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch {
      // File absent — fall through to convention so a stale setting does not
      // silently break the user. The caller logs a diagnostic.
    }
  }

  // Step 2: project-root convention.
  const convention = path.join(projectRoot, 'package-map.yaml');
  try {
    if (fs.statSync(convention).isFile()) return convention;
  } catch {
    // No convention file — omit flag.
  }

  // Step 3: no map applies.
  return undefined;
}
