const test = require('node:test'), assert = require('node:assert/strict');
const { retainDisplayObservation, reconcileDisplayDocument, reconcileDisplayOverlay } = require('../out/displayObservations');
const { decodeDisplayWithdrawals } = require('../out/displayObservationStorage');
const { selectDisplayPresentation } = require('../out/displayPresentation');
const metadata = require('./fixtures/workflow-markdown-contract.json').displayMetadata;
const binding = metadata.plan_snapshot_digest;
const identity = invocation => ({ phase: 'execute', invocation, retry_attempt: 1,
  occurrence_sequence: invocation, frame_id: 'frame', frame_step_index: 0 });
const slot = text => ({ display_presentation: { ...metadata, value_status: text.length === 32768 ? 'truncated' : 'available' },
  output: { content: text } });
const invalids = [null, { ...metadata, value_status: ['redacted'] }, { ...metadata, value_status: 'redacted' },
  { ...metadata, value_status: 'unavailable' }, { ...metadata, plan_snapshot_digest: 'sha256:' + 'e'.repeat(64) }];
for (const legacy of [false, true]) for (const text of ['full\r\n😀  ', '', 'x'.repeat(32766) + '😀']) {
  test(`authority is occurrence identity, never replay arrival order: legacy=${legacy}, units=${text.length}`, () => {
    for (const bad of invalids) for (const prior of [false, true]) for (const order of [[1, 3, 5], [5, 1, 3], [3, 5, 1]]) {
      const id = legacy ? {} : identity(3);
      let ledger = prior ? retainDisplayObservation({}, 'report', 'run', { ...id, ...slot(text) }, binding) : {};
      ledger = retainDisplayObservation(ledger, 'report', 'run', { ...id, display_presentation: bad }, binding);
      for (const invocation of order)
        ledger = retainDisplayObservation(ledger, 'report', 'run', { ...identity(invocation), ...slot(text) }, binding);
      const doc = { presentation_state: { run_id: 'run', plan_snapshot_digest: binding,
        occurrences: [1, 3, 5].map(invocation => ({ identity: { qualified_node_id: 'report', ...identity(invocation) },
          details: { kind: 'display', format: 'markdown' }, ...slot(text) })) } };
      for (const item of reconcileDisplayDocument(doc, ledger).presentation_state.occurrences)
        assert.equal(item.output.content, legacy || item.identity.invocation === 3 ? undefined : text);
      const withdrawn = ledger.report.filter(value => selectDisplayPresentation(value.display_presentation, value.output, binding).text === undefined);
      ledger = decodeDisplayWithdrawals(JSON.parse(JSON.stringify({ report: withdrawn })));
      for (const invocation of order) {
        const node = { ...identity(invocation), ...slot(text) };
        const projected = reconcileDisplayOverlay({ nodes: { report: node } }, ledger, 'run', binding).nodes.report;
        assert.equal(projected.output.content, legacy || invocation === 3 ? undefined : text);
      }
      assert.equal(reconcileDisplayOverlay({ nodes: { report: slot(text) } }, ledger, 'other-run', binding).nodes.report.output.content, text);
      assert.equal(reconcileDisplayOverlay({ nodes: { other: slot(text) } }, ledger, 'run', binding).nodes.other.output.content, text);
      assert.equal(reconcileDisplayOverlay({ nodes: { report: slot(text) } }, ledger, 'run',
        'sha256:' + 'c'.repeat(64)).nodes.report.output.content, text);
    }
  });
}
