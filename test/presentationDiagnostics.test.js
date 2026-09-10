const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { finiteHelper, resolveCodePresentation, bundledPresentationHelper } = require('../out/presentationClient');
const { helperIdentity, presentationDiagnostic, diagnosticHelperBuild } = require('../out/presentationDiagnostics');
const fixture = require('./fixtures/presentation-contract.json');

test('diagnostic snapshot excludes sources, overlay identities, request IDs and raw errors', async () => {
  const request = structuredClone(fixture.request);
  request.request_id = 'PRIVATE_REQUEST';
  request.document.text = 'PRIVATE_SOURCE🚀';
  request.overlays = [{ uri: 'PRIVATE_OVERLAY_URI', path: 'PRIVATE_PATH', version: 1, text: 'PRIVATE_OVERLAY🚀' }];
  const snapshot = presentationDiagnostic(helperIdentity(process.execPath), request, true,
    { status: 'unavailable', reason: 'helper-deadline', timings: {} }, { durationMs: 12 });
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /PRIVATE_/);
  assert.equal(snapshot.document.utf16Count, request.document.text.length);
  assert.equal(snapshot.overlays.count, 1);
  assert.equal(snapshot.overlays.utf8Bytes, Buffer.byteLength(request.overlays[0].text));
  assert.equal(snapshot.context.knownEntrypoint, true);
  const build = await diagnosticHelperBuild(snapshot.helper);
  assert.match(build.sha256, /^[A-F0-9]{64}$/);
  assert.equal((await diagnosticHelperBuild({ ...snapshot.helper, bytes: 1 })).reason, 'helper-changed-or-unavailable');
});

test('helper timing separates queued cancellation from spawned work and preserves the two-slot bound', async t => {
  const cp = require('node:child_process'), spawn = cp.spawn;
  let live = 0, maximum = 0;
  t.mock.method(cp, 'spawn', (...args) => {
    const child = spawn(...args);
    maximum = Math.max(maximum, ++live);
    child.on('close', () => live--);
    return child;
  });
  const timings = [];
  const first = finiteHelper(process.execPath, ['-e', 'setTimeout(()=>console.log("{}"),200)'], '', undefined, v => timings.push(v));
  const second = finiteHelper(process.execPath, ['-e', 'setTimeout(()=>console.log("{}"),200)'], '', undefined, v => timings.push(v));
  const controller = new AbortController();
  let cancelled;
  const third = finiteHelper(process.execPath, ['-e', 'console.log("{}")'], '', controller.signal, v => { cancelled = v; });
  const rejected = assert.rejects(third, /stale-request/);
  setTimeout(() => controller.abort(), 60);
  await Promise.all([first, second, rejected]);
  assert.equal(maximum, 2);
  assert.equal(cancelled.processMs, null);
  assert.ok(cancelled.queueMs >= 40);
  assert.equal(cancelled.reason, 'stale-request');
  assert.ok(timings.every(timing => timing.processMs >= 200 && timing.reason === 'ok'));
  assert.deepEqual(await finiteHelper(process.execPath, ['-e', 'console.log("{}")'], '', undefined, () => { throw Error('sink'); }), {});
});

test('real five-second deadline is attributed to process time without retaining stderr', { timeout: 10000 }, async () => {
  let timing;
  await assert.rejects(finiteHelper(process.execPath,
    ['-e', 'process.stderr.write("PRIVATE_STDERR");setTimeout(()=>{},20000)'], '', undefined, v => { timing = v; }), /helper-deadline/);
  assert.equal(timing.reason, 'helper-deadline');
  assert.ok(timing.processMs >= 4900 && timing.processMs < 8000);
  assert.doesNotMatch(JSON.stringify(timing), /PRIVATE_STDERR/);
});

test('production code client exposes completed capabilities and resolve phases, not just combined failure', async () => {
  const missing = await resolveCodePresentation(path.join(__dirname, 'not-a-helper.exe'), fixture.request);
  assert.equal(missing.reason, 'helper-unavailable');
  assert.equal(missing.timings.capabilities.reason, 'helper-unavailable');
  assert.equal(missing.timings.resolve, undefined);
  const request = structuredClone(fixture.request);
  const root = path.join(__dirname, 'fixtures');
  request.context.project_root = root;
  for (const b of [request.document, ...request.overlays]) {
    b.path = path.join(root, path.win32.basename(b.path));
    b.uri = require('node:url').pathToFileURL(b.path).toString();
  }
  const result = await resolveCodePresentation(process.env.GERT_PRESENTATION_HELPER || bundledPresentationHelper(path.join(__dirname, '..')), request);
  assert.equal(result.reply.status, 'resolved');
  assert.equal(result.timings.capabilities.reason, 'ok');
  assert.equal(result.timings.resolve.reason, 'ok');
});

test('decoder failures are attributed to their code phase rather than reported as transport success', async t => {
  const helper = process.env.GERT_PRESENTATION_HELPER || bundledPresentationHelper(path.join(__dirname, '..'));
  const caps = await finiteHelper(helper, ['presentation', 'capabilities']);
  const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
  let badPhase = 'resolve';
  t.mock.method(require('node:child_process'), 'spawn', (_binary, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => true;
    child.stdin.on('finish', () => {
      child.stdout.emit('data', Buffer.from(JSON.stringify(args[1] === 'capabilities' && badPhase !== 'capabilities' ? caps : {})));
      child.emit('close', 0);
    });
    return child;
  });
  const resolve = await resolveCodePresentation(helper, fixture.request);
  assert.equal(resolve.timings.capabilities.reason, 'ok');
  assert.equal(resolve.timings.resolve.reason, resolve.reason);
  assert.notEqual(resolve.reason, 'ok');
  badPhase = 'capabilities';
  const capability = await resolveCodePresentation(helper, fixture.request);
  assert.equal(capability.timings.capabilities.reason, capability.reason);
  assert.notEqual(capability.reason, 'ok');
  assert.equal(capability.timings.resolve, undefined);
});

test('editor logs only changed terminal failures and one action exposes fresh safe context without spawning', async t => {
  const Module = require('node:module'), originalLoad = Module._load;
  const uri = { scheme: 'file', fsPath: path.join(__dirname, 'fixtures', 'diagnostic.runbook.yaml'),
    toString() { return require('node:url').pathToFileURL(this.fsPath).toString(); } };
  const doc = { uri, fileName: uri.fsPath, languageId: 'yaml', isUntitled: false, version: 1, getText: () => 'PRIVATE_SOURCE' };
  const editor = { document: doc }, lines = [], commands = {};
  const disposable = { dispose() {} }, event = () => disposable;
  let refresh, status, calls = 0, reason = 'helper-deadline';
  const vscode = {
    EventEmitter: class { event = event; fire() {} dispose() {} },
    StatusBarAlignment: { Right: 1 },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: path.dirname(uri.fsPath) } }], textDocuments: [doc],
      getConfiguration: () => ({ get: (key, fallback) => key === 'highlighting.developmentHelperPath' ? process.execPath : fallback }),
      onDidChangeTextDocument: callback => { refresh = callback; return disposable; },
      onDidOpenTextDocument: event, onDidCloseTextDocument: event, onDidChangeConfiguration: event,
      createFileSystemWatcher: () => ({ ...disposable, onDidChange: event, onDidCreate: event, onDidDelete: event }),
    },
    window: { activeTextEditor: editor, visibleTextEditors: [editor],
      createStatusBarItem: () => (status = { ...disposable, show() {}, hide() {} }),
      onDidChangeVisibleTextEditors: event, onDidChangeActiveTextEditor: event, onDidChangeActiveColorTheme: event },
    commands: { registerCommand: (id, callback) => { commands[id] = callback; return disposable; } },
  };
  t.mock.method(Module, '_load', function (id, ...args) { return id === 'vscode' ? vscode : originalLoad.call(this, id, ...args); });
  t.mock.method(require('../out/presentationClient'), 'resolveCodePresentation', async () => {
    calls++;
    return { reason, timings: { capabilities: { queueMs: 0, processMs: 5000, totalMs: 5000, reason } } };
  });
  t.mock.method(require('../out/expressionPresentationClient'), 'resolveExpressionPresentation', async () => undefined);
  const modulePath = require.resolve('../out/presentationEditor');
  delete require.cache[modulePath];
  const registration = require(modulePath).registerPresentationEditor({
    extensionPath: path.resolve(__dirname, '..'), extension: { packageJSON: { version: 'test' } },
  }, { appendLine: line => lines.push(line), show() {} });
  const settled = async () => {
    for (let n = 0; n < 30; n++) {
      if (status.text?.includes(reason)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail('Editor did not settle');
  };
  try {
    await settled();
    assert.equal(lines.length, 1);
    doc.version++; refresh(); await settled();
    assert.equal(lines.length, 1, 'An unchanged failure after editing is not logged again');
    reason = 'helper-unavailable'; refresh(); await settled();
    assert.equal(lines.length, 2);
    const before = calls;
    const snapshot = await commands[status.command]();
    assert.equal(calls, before, 'Diagnostics must not retry the helper');
    assert.equal(snapshot.document.version, 2);
    assert.equal(snapshot.code.reason, reason);
    assert.equal(snapshot.context.projectRoot, path.dirname(uri.fsPath));
    assert.equal(lines.length, 3);
    assert.doesNotMatch(lines.join('\n'), /PRIVATE_SOURCE/);
    assert.match(lines[2], /"sha256":"[A-F0-9]{64}"/);
  } finally { registration.dispose(); delete require.cache[modulePath]; }
});
