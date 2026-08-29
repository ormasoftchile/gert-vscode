# Change Log

All notable changes to the **gert Runbook Preview** extension are documented here.

## [Unreleased]

- Replaced the iframe/SSE preview with one complete bundled React Flow webview. The graph now keeps
	declared inputs, Run/Cancel, live step state, choice/decision/collector interactions, host actions,
	styles, and step details in the same view.
- Rebuilt the step panel as a dense, kind-aware operator inspector with Definition/Run/Debug tabs,
	a no-selection run overview, authored execution policy, bounded output/captures/logs/evidence,
	and responsive bottom-drawer behavior. Graph JSON now carries additive, secret-safe step details;
	branch routes merge from their actual exits and progress excludes resolved untaken arms.
- Added `gert run --stdio`, a bounded JSON-lines protocol carrying engine events and tokenized
	interaction frames over the child process's stdin/stdout. VS Code no longer starts `gert serve`,
	allocates a preview port, embeds an iframe, or opens an SSE connection.
- Added direct Debug Run support over stdio: graph breakpoints, watches, before/after pause
	inspectors, variable and effective-result patches, stepping controls, Stop, and actual/effective
	override audit markers. Debug configuration is validated before the engine starts and is never
	placed in process arguments or environment variables.
- Added explicit governed-step approval and private secret-input startup over the same stdio
	channel. Secret values no longer enter process arguments and all outbound payloads are bounded
	and redacted without changing protocol identities or opaque interaction tokens.
- Added `gert.preview.openLocation`. The React Flow graph now opens as a tab in the source
	runbook's editor group by default; `beside` remains available as an explicit setting.
- Replaced the fixed Sterling host capability with the generic `xts.open-view` contract.
	Runbooks now own arbitrary XTS view paths and pass native view parameters unchanged.
- Added an explicit in-panel XTS handoff confirmation and a non-modal reminder after a successful
	focused open. The reviewed panel action is the only confirmation; no second modal is shown.

## [0.2.1] — 2026-08-22

**Bug fix: stale preview panel reconnects after server restart.**

- **`gert.restartServer` stale-panel recovery:** After replacing or restarting the `gert` binary, the existing preview panel was left attached to the dead server — both `Gert: Restart Server` and `Gert: Preview Graph` bailed out with "Open a .runbook.yaml file first." when the webview panel was focused. `gert.restartServer` now calls `reconnectGraphPanel()`, which refreshes the existing panel's `webview.html` in-place against the freshly started server: the iframe URL is rewritten to the new server origin (no stale EventSource), pending host-action requests are cancelled with reason `run-replaced`, and the host-action bridge remains wired without requiring any text-editor focus. `gert.previewGraph` is unchanged and still requires an active `.runbook.yaml` editor.
- **Panel lifecycle tracking:** Two new module-level variables (`graphPanelRunbookPath`, `graphPanelBridge`) are set when a preview panel is created and cleared on dispose, enabling `reconnectGraphPanel` to act on a focused webview without a separate editor selection.

## [0.2.0] — 2026-08-22

**Breaking protocol change — incompatible with 0.1.x preview builds.**

- **Wire protocol:** The bridge now speaks `host-action/v1` (string version, not the legacy integer `version: 1`). `0.1.x` builds are mutually incompatible: a 0.1.x extension silently drops all `host-action/v1` messages from the served preview, and the served preview self-acks `execution-not-started` against a 0.1.x extension. Do not run a 0.2.x extension against a 0.1.x `preview.html` or vice versa.
- **Parent-origin handshake (C-1):** `previewWebview.ts` now appends `?parentOrigin=<vscode-webview-origin>` to the iframe URL it constructs. The served preview derives the `postMessage` target origin using a three-tier algorithm: `location.ancestorOrigins[0]` (primary), `?parentOrigin` query parameter (this injection — Tier 2), then `document.referrer` (fallback). This eliminates the empty-referrer `execution-not-started` self-ack that occurred in VS Code's Electron iframe context. No wildcard `'*'` origin is used at any tier.
- **Sterling handler (C-3):** `makeXtsOpenSterlingHandler` calls `xts.openViewWithParameters` for the fixed `chongliu/sterling servers and databases.xts` view and adapts the semantic Gert `server` field to the visible `search_string` prompt parameter.
- **XTS capabilities:** `xts.open-view` and `xts.open-sterling-servers-and-databases` are registered in the production capability registry via `host-action/v1`; both route to `xts.openViewWithParameters`.
- **Release identity guard:** Version `0.1.x` is permanently associated with legacy `version: 1` protocol. Marketplace listing `ormasoftchile.gert-preview` at `≥ 0.2.0` identifies the `host-action/v1` build.

## [0.1.0] — 2026-05-04

Initial preview release.

- Open `.runbook.yaml` files as a structural graph (React Flow).
- Auto-spawn `gert serve` and reuse a free port when `gert.autoStartServer` is true.
- Live run state via SSE (`/runs/{id}/state`) with reconnect and 15s heartbeat.
- Interactive prompts (choice / decision / collector) routed through the in-editor webview.
- Commands: `gert.preview`, `gert.previewGraph`, `gert.showServerLog`, `gert.restartServer`.
