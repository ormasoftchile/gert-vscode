'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createPreviewWebviewHtml } = require('../out/previewWebview');

test('preview wrapper bridges only canonical host-action lifecycle messages', () => {
  const html = createPreviewWebviewHtml(
    'http://127.0.0.1:7778',
    'C:\\work\\incident.runbook.yaml',
    'smooth-curves',
  );

  assert.match(html, /const trustedOrigin = "http:\/\/127\.0\.0\.1:7778";/);
  assert.match(html, /ev\.source === frame\.contentWindow/);
  assert.match(html, /ev\.origin !== trustedOrigin/);
  assert.match(html, /gert\.host-action\.request/);
  assert.match(html, /gert\.host-action\.cancel/);
  assert.match(html, /vscodeApi\.postMessage\(ev\.data\)/);
  assert.match(html, /frame\.contentWindow\.postMessage\(ev\.data, trustedOrigin\)/);
  assert.doesNotMatch(html, /postMessage\([^,]+,\s*['"]\*['"]\)/);
  assert.doesNotMatch(html, /xts\.host-action/);
});
