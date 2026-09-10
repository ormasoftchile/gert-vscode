const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const { terminalPresentation } = require('../out/presentationProjection');
const source = fs.readFileSync(path.join(__dirname, '..', 'webview', 'graph.tsx'), 'utf8');
function productionFunction(name, next, dependencies) {
  const fn = source.slice(source.indexOf(`function ${name}(`), source.indexOf(`function ${next}(`));
  const js = transformSync(fn, { loader: 'ts', target: 'es2022' }).code;
  const fnValue = vm.runInNewContext(js + `\n${name}`, {
    ...require('../out/executionProgress'), ...require('../out/runStatus'), ...require('../out/displayObservations'), ...dependencies,
  });
  return (current, update, binding = require('./fixtures/workflow-markdown-contract.json').displayMetadata.plan_snapshot_digest) =>
    fnValue(current, update, binding);
}
test('actual direct reducer retains terminal classifications and values through full status summaries', () => {
  const envelope = structuredClone(require('./fixtures/presentation-contract.json').graph_details_example.code_presentation);
  Object.assign(envelope, { origin: 'frozen', plan_snapshot_digest: 'sha256:' + 'b'.repeat(64) });
  const apply = productionFunction('applyRuntimeEvent', 'applyTerminalSteps', {
    terminalPresentation, eventNodeID: event => event.payload.qualified_node_id,
    recordValue: value => value && typeof value === 'object' ? value : undefined,
  });
  test('Workflow Markdown direct terminal preserves exact strings and distinct occurrence selections', () => {
    const metadata = require('./fixtures/workflow-markdown-contract.json').displayMetadata;
    const apply = productionFunction('applyRuntimeEvent', 'applyTerminalSteps', {
      terminalPresentation, eventNodeID: event => event.payload.qualified_node_id,
      recordValue: value => value && typeof value === 'object' ? value : undefined,
    });
    const summarize = productionFunction('applyTerminalSteps', 'graphInputDeclarations', { terminalPresentation });
    let state = {};
    for (const [invocation, text] of [[1, 'first\r\n😀  '], [2, 'second\n']]) {
      state = apply(state, { kind: 'step/started', run_id: 'run', sequence: invocation * 2, payload: {
        qualified_node_id: 'include/report', invocation } });
      state = apply(state, { kind: 'step/completed', run_id: 'run', sequence: invocation * 2 + 1, payload: {
        qualified_node_id: 'include/report', invocation, output: { content: text }, display_presentation: metadata } });
    }
    const before = JSON.stringify(state);
    const final = summarize(state, [{ node_id: 'include/report', status: 'completed', output: { content: 'unclassified' } }]);
    assert.equal(final['include/report'].output.content, 'second\n');
    assert.equal(final['include/report'].occurrences[0].output.content, 'first\r\n😀  ');
    assert.equal(final['include/report'].occurrences.length, 2);
    assert.equal(JSON.stringify(state), before);
    const withheld = summarize(final, [{ node_id: 'include/report', status: 'completed',
      display_presentation: { ...metadata, value_status: 'redacted' }, output: { content: 'must not survive late protection' } }]);
    assert.equal(withheld['include/report'].output.content, undefined);
    assert.equal(withheld['include/report'].occurrences[1].output.content, undefined);
    assert.equal(withheld['include/report'].occurrences[0].output.content, 'first\r\n😀  ');
  });
  const completed = apply({}, { kind: 'step/completed', payload: {
    qualified_node_id: 'wrapper/child', output: { script: 'approved terminal string' },
    code_presentation: envelope, output_value_status: { script: 'available' },
  } });
  const summarize = productionFunction('applyTerminalSteps', 'graphInputDeclarations', { terminalPresentation });
  const final = summarize(completed, [{ node_id: 'wrapper/child', status: 'completed',
    output: { preview_fields_omitted: 1, script: 'UNCLASSIFIED_SUMMARY_STRING' } }]);
  assert.equal(final['wrapper/child'].output.script, 'approved terminal string');
  assert.equal(final['wrapper/child'].codePresentation.plan_snapshot_digest, envelope.plan_snapshot_digest);
  assert.equal(final['wrapper/child'].outputValueStatus.script, 'available');
  assert.ok(!JSON.stringify(final).includes('UNCLASSIFIED_SUMMARY_STRING'));
  const next = apply(final, { kind: 'step/started', payload: { qualified_node_id: 'wrapper/child' } });
  assert.equal(next['wrapper/child'].codePresentation, undefined);
  assert.equal(next['wrapper/child'].output, undefined);
});
test('late started event preserves same-occurrence terminal status and existing Markdown', () => {
  const metadata = require('./fixtures/workflow-markdown-contract.json').displayMetadata;
  const apply = productionFunction('applyRuntimeEvent', 'applyTerminalSteps', {
    terminalPresentation, eventNodeID: event => event.payload.qualified_node_id,
    recordValue: value => value && typeof value === 'object' ? value : undefined,
  });
  const payload = { qualified_node_id: 'report', invocation: 1, occurrence_sequence: 1, frame_id: 'frame' };
  const completed = apply({}, { kind: 'step/completed', run_id: 'run', sequence: 1,
    payload: { ...payload, display_presentation: metadata, output: { content: 'actual retained report\r\n' } } });
  const late = apply(completed, { kind: 'step/started', run_id: 'run', sequence: 2, payload });
  assert.equal(late.report.status, 'completed', 'same occurrence cannot regress after its terminal event');
  assert.equal(late.report.output.content, 'actual retained report\r\n');
  const newer = apply(late, { kind: 'step/started', run_id: 'run', sequence: 3, payload: { ...payload, invocation: 2 } });
  assert.equal(newer.report.output, undefined, 'genuinely newer occurrence resets current output');
  assert.equal(newer.report.occurrences[0].output.content, 'actual retained report\r\n');
});
