import { defineConfig } from '@vscode/test-cli';

// Extension-host integration test configuration.
//
// `npm run test:e2e` compiles the test suite (tsconfig.test.json → out/test/suite/)
// then launches a real VS Code extension host (via @vscode/test-electron) with
// the extension loaded from the workspace root.
//
// The host uses the workspace folder so the extension can resolve workspace-
// relative paths during activation. Mocha timeout is generous to allow the
// Electron process to start on slow CI machines.
export default defineConfig([
  {
    files: 'out/test/suite/**/*.test.js',
    workspaceFolder: '.',
    mocha: {
      timeout: 60000,
    },
  },
]);
