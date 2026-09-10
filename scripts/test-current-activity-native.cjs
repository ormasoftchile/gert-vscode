const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { runTests } = require('@vscode/test-electron');

const root = path.resolve(__dirname, '..');
const executable = process.env.GERT_VSCODE_EXECUTABLE;
const runbooks = process.argv.slice(2).map(file => path.resolve(file));
if (!executable || !fs.existsSync(executable) || runbooks.length !== 2 || runbooks.some(file => !fs.existsSync(file))) {
  throw new Error('Set GERT_VSCODE_EXECUTABLE to an installed Code executable and supply two existing runbook paths.');
}
const runRoot = path.join(root, '.vscode-test', `current-activity-${Date.now().toString(36)}`);
for (const dir of ['workspace', 'profile', 'extensions', 'appdata', 'localappdata', 'runtime-data']) {
  fs.mkdirSync(path.join(runRoot, dir), { recursive: true });
}
fs.mkdirSync(path.join(runRoot, 'profile', 'User'));
fs.writeFileSync(path.join(runRoot, 'profile', 'User', 'settings.json'), JSON.stringify({
  'telemetry.telemetryLevel': 'off', 'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false,
  'update.mode': 'none', 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false,
  'gert.highlighting.enabled': false, 'gert.autocomplete.enabled': false,
  'gert.binaryPath': path.join(root, 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'gert.exe' : 'gert'),
}));

async function main() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const options = {
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'test', 'current-activity-native.cjs'),
    launchArgs: [path.join(runRoot, 'workspace'), `--user-data-dir=${path.join(runRoot, 'profile')}`,
      `--extensions-dir=${path.join(runRoot, 'extensions')}`, '--new-window', '--skip-welcome', '--skip-release-notes',
      '--disable-workspace-trust', '--disable-telemetry', '--disable-background-networking', '--disable-gpu',
      '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>',
      '--disable-extension=vscode.github', '--disable-extension=vscode.github-authentication',
      '--disable-extension=vscode.microsoft-authentication', '--disable-extension=vscode.git',
      '--disable-extension=GitHub.copilot-chat', '--disable-extension=TypeScriptTeam.jsts-chat-features',
      `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
    extensionTestsEnv: {
      GERT_ACTIVITY_TEST_ROOT: runRoot, GERT_ACTIVITY_RUNBOOKS: JSON.stringify(runbooks),
      GERT_ACTIVITY_CDP_PORT: String(port),
      APPDATA: path.join(runRoot, 'appdata'), LOCALAPPDATA: path.join(runRoot, 'localappdata'),
      TEMP: path.join(runRoot, 'runtime-data'), TMP: path.join(runRoot, 'runtime-data'),
      HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
    },
  };
  fs.writeFileSync(path.join(runRoot, 'launch.json'), JSON.stringify(options, null, 2));
  console.log(`Evidence: ${runRoot}`);
  await runTests(options);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
