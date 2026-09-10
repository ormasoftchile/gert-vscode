const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { publicationDigest, validateResults } = require('../out/typedResults');
const root = process.env.GERT_ACTIVITY_TEST_ROOT;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 120; i++) {
    const value = await check();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timeout: ${label}`);
}

// Use the existing native CDP screenshot harness, plus execution contexts for
// VS Code's out-of-process webview iframe. No DOM or production code is injected.
async function connectWebview(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
  assert.ok(target, 'isolated workbench page');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const pending = new Map(), contexts = new Map(), attached = new Set();
  let sequence = 0;
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 5000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  socket.onmessage = event => {
    const value = JSON.parse(String(event.data));
    if (value.method === 'Runtime.executionContextCreated') {
      const context = value.params.context;
      contexts.set(`${value.sessionId || ''}:${context.id}`, { id: context.id, sessionId: value.sessionId });
    }
    if (value.method === 'Runtime.executionContextDestroyed') contexts.delete(`${value.sessionId || ''}:${value.params.executionContextId}`);
    if (!value.id) return;
    const request = pending.get(value.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(value.id);
    value.error ? request.reject(new Error(value.error.message)) : request.resolve(value.result);
  };
  await send('Runtime.enable');
  const evaluate = async (expression, context) => {
    const result = await send('Runtime.evaluate', { expression, contextId: context.id, returnByValue: true }, context.sessionId);
    if (result.exceptionDetails) return undefined;
    return result.result.value;
  };
  return {
    find: async () => {
      const { targetInfos } = await send('Target.getTargets');
      for (const item of targetInfos.filter(item => item.type === 'iframe' && !attached.has(item.targetId))) {
        const { sessionId } = await send('Target.attachToTarget', { targetId: item.targetId, flatten: true });
        attached.add(item.targetId);
        await send('Runtime.enable', {}, sessionId);
      }
      for (const context of contexts.values()) {
        try {
          if (await evaluate(`!!document.querySelector('.canvas .react-flow__node')`, context)) return context;
        } catch { /* A disposed preview destroys its execution context. */ }
      }
    },
    evaluate,
    close: () => socket.close(),
  };
}

const probe = `(() => {
  const box = element => element?.getBoundingClientRect().toJSON();
  return {
    activityPanels: document.querySelectorAll('.current-activity, .execution-position-strip, [aria-label="Current activity"]').length,
    activityHeading: /current activity/i.test(document.body.innerText),
    canvas: box(document.querySelector('.canvas')),
    controls: Array.from(document.querySelectorAll('header button')).map(e => ({ text: e.textContent.trim(), disabled: e.disabled, box: box(e) })),
    nodes: Array.from(document.querySelectorAll('.react-flow__node')).map(e => ({
      id: e.dataset.id, box: box(e), status: e.querySelector('.step-node')?.className
    })),
    alerts: Array.from(document.querySelectorAll('[role="alert"]')).map(e => e.textContent),
    issueButtons: Array.from(document.querySelectorAll('.workflow-issues button')).map(e => e.textContent),
    results: document.querySelector('.typed-results')?.textContent,
    resultsState: document.querySelector('.typed-results')?.dataset.resultsState,
    runStatus: document.querySelector('.run-status')?.textContent
  };
})()`;
function assertPreview(value) {
  assert.equal(value.activityPanels, 0);
  assert.equal(value.activityHeading, false);
  assert.ok(value.canvas.width > 0 && value.canvas.height > 0);
  assert.ok(value.nodes.some(node => node.box.width > 0 && node.box.height > 0 &&
    node.box.right > value.canvas.left && node.box.left < value.canvas.right &&
    node.box.bottom > value.canvas.top && node.box.top < value.canvas.bottom), 'visible graph node');
}

exports.run = async () => {
  const evidence = [];
  let cdp, screenshots, panel;
  try {
    const extension = vscode.extensions.getExtension('ormasoftchile.gert-preview');
    assert.ok(extension); await extension.activate();
    assert.equal(path.resolve(extension.extensionPath).toLowerCase(), path.resolve(__dirname, '..').toLowerCase());
    const port = Number(process.env.GERT_ACTIVITY_CDP_PORT);
    cdp = await connectWebview(port);
    screenshots = await require('./helpers/highlighting-cdp.cjs').connect(port);
    const read = async () => cdp.evaluate(probe, await until(() => cdp.find(), 'production graph iframe'));
    const record = async (name, value) => {
      assertPreview(value);
      await screenshots.screenshot(path.join(root, `${name}.png`));
      evidence.push({ name, ...value });
      fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(evidence, null, 2));
      console.log(`PASS ${name}`);
    };
    for (const [index, file] of JSON.parse(process.env.GERT_ACTIVITY_RUNBOOKS).entries()) {
      const before = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(document);
      // Same production panel/loader as gert.previewGraph, with no loader/spawn hooks.
      panel = await vscode.commands.executeCommand('gert.test.openDirectGraphPanel', file);
      const value = await until(async () => {
        const state = await read();
        return state.nodes.length && state.controls.some(button => button.text === 'Run' && !button.disabled) && state;
      }, 'offline preview Run control');
      assert.ok(value.controls.some(button => button.text === 'Start session'));
      assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), before);
      await record(`runbook-${index + 1}`, { file, sha256: before, execution: false, ...value });
      panel.dispose(); panel = undefined;
    }
    const file = path.join(root, 'workspace', 'safe.runbook.yaml');
    fs.writeFileSync(file, 'apiVersion: runbook/v1\nid: safe\nflow: []\n');
    const graph = { schema_version: '1', hash: 'safe-ui-fixture',
      runbook: { id: 'safe', name: 'Safe UI fixture (no execution)', path: file }, frames: [], groups: [],
      nodes: ['work', 'results'].map((id, index) => ({ id, type: 'gertStep', position: { x: 0, y: index * 150 },
        data: { id, kind: id === 'results' ? 'results' : 'tool', title: id } })),
      edges: [{ id: 'next', source: 'work', target: 'results' }] };
    const openFixture = async () => {
      panel?.dispose();
      panel = await vscode.commands.executeCommand('gert.test.openDirectGraphPanel', file, {
        documentLoader: async () => graph,
        spawnRun: () => { throw new Error('UI acceptance must never execute a provider'); },
        spawnSession: () => { throw new Error('UI acceptance must never execute a provider'); },
      });
      await until(async () => (await read()).runStatus === 'idle', 'idle fixture');
    };
    const post = async message => { await panel.webview.postMessage(message); await sleep(100); };
    const frame = async value => post({ type: 'run.frame', frame: value });
    let sequence = 0;
    const step = async (status, nodeID = 'work') => frame({ type: 'run.event', event: { kind: `step/${status}`, run_id: 'safe-run',
      sequence: ++sequence, payload: { qualified_node_id: nodeID, phase: 'execute', invocation: 1, retry_attempt: 1 } } });
    await openFixture();
    await frame({ type: 'run.started', runID: 'safe-run' });
    await step('started');
    let value = await until(async () => { const state = await read(); return state.nodes.some(node => /status-running/.test(node.status)) && state; }, 'running node');
    assert.ok(value.controls.some(button => button.text === 'Cancel' && !button.disabled));
    await record('fixture-running', value);
    await step('failed');
    await post({ type: 'run.error', message: 'Safe fixture: fix the missing required input before retrying.' });
    value = await until(async () => { const state = await read(); return state.alerts.length && state.issueButtons.length && state; }, 'actionable failure');
    assert.ok(value.nodes.some(node => /status-failed/.test(node.status)));
    assert.match(value.alerts.join(' '), /fix the missing required input/);
    await record('fixture-failure', value);
    const context = await until(() => cdp.find(), 'issue iframe');
    await cdp.evaluate(`document.querySelector('.workflow-issues button').click()`, context);
    assert.equal(await cdp.evaluate(`document.querySelector('.step-inspector') !== null`, context), true);
    await openFixture();
    await frame({ type: 'run.started', runID: 'safe-run' });
    await step('started'); await step('completed');
    await step('started', 'results'); await step('completed', 'results');
    const publication = { schema_version: 'run-results/v1', publication_id: 'safe-run/root/results/1',
      plan_snapshot_digest: `sha256:${'a'.repeat(64)}`, checkpoint_sequence: 1,
      origin: { node_id: 'results', invocation: 1 },
      outputs: { safe_result: { type: 'object', value: { count: 0, success: false, items: [], optional: null } } } };
    publication.digest = publicationDigest(publication);
    validateResults(publication);
    await frame({ type: 'run.finished', runID: 'safe-run', status: 'completed',
      resultsAvailability: { state: 'available', publication } });
    value = await until(async () => { const state = await read(); return state.resultsState === 'available' && state; }, 'terminal Results');
    assert.ok(value.nodes.some(node => /status-completed/.test(node.status)));
    assert.match(value.results, /safe_result/); assert.match(value.results, /"count": 0/);
    assert.ok(value.controls.some(button => button.text === 'Run' && !button.disabled));
    await record('fixture-results', value);
    assert.equal((await vscode.commands.executeCommand('gert.test.getRuntimeState')).mcpBridgeStarted, false);
  } catch (error) {
    fs.writeFileSync(path.join(root, 'failure.txt'), error.stack);
    throw error;
  } finally {
    panel?.dispose(); cdp?.close(); screenshots?.close();
  }
};
