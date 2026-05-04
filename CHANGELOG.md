# Change Log

All notable changes to the **gert Runbook Preview** extension are documented here.

## [0.1.0] — 2026-05-04

Initial preview release.

- Open `.runbook.yaml` files as a structural graph (React Flow).
- Auto-spawn `gert serve` and reuse a free port when `gert.autoStartServer` is true.
- Live run state via SSE (`/runs/{id}/state`) with reconnect and 15s heartbeat.
- Interactive prompts (choice / decision / collector) routed through the in-editor webview.
- Commands: `gert.preview`, `gert.previewGraph`, `gert.showServerLog`, `gert.restartServer`.
