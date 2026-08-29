import { defineConfig } from '@vscode/test-cli';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Extension-host integration test configuration.
//
// `npm run test:e2e` compiles the test suite (tsconfig.test.json → out/test/suite/)
// then launches a real VS Code extension host (via @vscode/test-electron) with
// the extension loaded from the workspace root.
//
// The host uses the workspace folder so the extension can resolve workspace-
// relative paths during activation.  Mocha timeout is generous to allow the
// Electron process to start on slow CI machines.
//
// GERT_TEST_GREP (optional) limits Mocha to a focused acceptance check.
const vsixHarnessPath = resolve(__dirname, 'test', 'vsix-harness');

// Absolute path to the packaged VSIX. Must be present before running the
// production-surface configuration (produced by `npm run package`).
const vsixPath = resolve(__dirname, 'gert-preview.vsix');

// Per-invocation isolated user-data directory for the production-surface run.
//
// The default @vscode/test-electron profile dir (.vscode-test/user-data/) is
// shared across all runs. If a previous invocation was aborted, its Electron
// process tree may still be alive and holding an IPC server at that path. A
// new invocation connecting to that IPC server triggers VS Code's singleton
// check:
//
//   "Running extension tests from the command line is currently only supported
//   if no other instance of Code is running."
//
// Using a timestamp-based run ID produces a fresh --user-data-dir per
// invocation. The lingering process tree holds the OLD IPC handle (different
// MD5 hash of the user-data path) and causes no conflict.
//
// NOTE: --extensions-dir is NOT made unique because installExtensions calls
// resolveCliArgsFromVSCodeExecutablePath which always computes --extensions-dir
// from defaultCachePath (.vscode-test/extensions/) regardless of launchArgs.
// Both the install step and the test run must use the same extensions directory
// or the installed VSIX will not be found.
const vsixRunId      = Date.now().toString(36);
const vsixUserDataDir = join(__dirname, '.vscode-test', `vsix-ud-${vsixRunId}`);

export default defineConfig([
  {
    // Default configuration: loads the extension from the source worktree via
    // extensionDevelopmentPath (the package root). Used by HAB-E2E-02 and all
    // other suite tests that do not require an installed VSIX.
    label: 'source',
    files: [
      'out/test/suite/extension.test.js',
      'out/test/suite/hostActionBridge.test.js',
    ],
    workspaceFolder: '.',
    mocha: {
      timeout: 90000,
      ...(process.env.GERT_TEST_GREP ? { grep: process.env.GERT_TEST_GREP } : {}),
    },
  },
  {
    // Installed-VSIX production-surface configuration.
    //
    // This configuration proves that the extension host loads gert-preview from
    // the INSTALLED VSIX (not from the source worktree via extensionDevelopmentPath).
    //
    // Key differences from the default configuration:
    //   • extensionDevelopmentPath: the no-op VSIX test harness (plus optional
    //     XTS). gert-preview source is NOT loaded as a development extension.
    //   • installExtensions: [vsixPath] — gert-preview.vsix is installed into
    //     the isolated VS Code test profile via `code --install-extension`.
    //   • files: only productionSurface.test.js — the installed-VSIX acceptance test.
    //
    // Prerequisites: gert-preview.vsix must exist at the workspace root.
    // Run `npm run package` to produce it before invoking this configuration.
    //
    // Run via: vscode-test --label production-surface
    label: 'production-surface',
    files: 'out/test/suite/productionSurface.test.js',
    extensionDevelopmentPath: [vsixHarnessPath],
    installExtensions: [vsixPath],
    workspaceFolder: '.',
    // Unique per-invocation user-data-dir — see comment above vsixRunId.
    // extensions-dir is the default (.vscode-test/extensions/) to match the
    // directory where installExtensions places the VSIX artifact.
    launchArgs: [
      `--user-data-dir=${vsixUserDataDir}`,
    ],
    mocha: {
      timeout: 120000,
      ...(process.env.GERT_TEST_GREP ? { grep: process.env.GERT_TEST_GREP } : {}),
    },
  },
]);

// VSIX-only acceptance remains isolated in the production-surface profile.
