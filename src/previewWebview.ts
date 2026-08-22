export function createPreviewWebviewHtml(base: string, runbookPath: string, initialStyle: string): string {
  const previewOrigin = new URL(base).origin;
  const frameUrl = `${base}/preview/?runbookPath=${encodeURIComponent(runbookPath)}&style=${encodeURIComponent(initialStyle)}`;
  return `<!doctype html>
<html><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${base}; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>html,body,iframe{margin:0;height:100vh;width:100vw;border:0}</style>
</head><body>
<iframe id="gert-frame" src="${frameUrl}"></iframe>
<script>
  const vscodeApi = acquireVsCodeApi();
  const trustedOrigin = ${JSON.stringify(previewOrigin)};
  window.addEventListener('message', (ev) => {
    const frame = document.getElementById('gert-frame');
    if (!frame || !frame.contentWindow || !ev.data) return;
    if (ev.source === frame.contentWindow) {
      if (ev.origin !== trustedOrigin || typeof ev.data !== 'object') return;
      if (ev.data.type === 'gert.host-action.request' || ev.data.type === 'gert.host-action.cancel') {
        vscodeApi.postMessage(ev.data);
      }
      return;
    }
    frame.contentWindow.postMessage(ev.data, trustedOrigin);
  });
</script>
</body></html>`;
}
