# gert Runbook Preview (VS Code extension)

Open a `*.runbook.yaml` file and use the preview or graph button in the editor
title bar. The same actions are also available from the Command Palette.

Three commands:

| Command | Behaviour | Requires |
|---|---|---|
| **gert: Open Runbook Preview** (`gert.preview`) | Runs `gert preview --format prose` against the active `.runbook.yaml` file and opens the rendered Markdown in a side-by-side preview. | `gert` CLI on PATH (or set `gert.binaryPath`). |
| **gert: Open Runbook Graph (React Flow)** (`gert.previewGraph`) | Opens the complete runbook UI: declared inputs, Run/Debug Run/Cancel, breakpoints, watches, live node status, choice/decision/collector/debug prompts, host actions, styles, and step details. Structure loads with `gert preview --format graphjson`; runs use the `gert-stdio/v1` JSON-lines protocol. No iframe, preview server, dynamic port, or SSE connection. | `gert` CLI on PATH (or set `gert.binaryPath`). |
| **gert: Validate Runbook Inputs (Dry Run)** (`gert.validateInputs`) | Prompts for a value per declared runbook input, then runs `gert dry-run` against the real CLI. Enum-constrained inputs get a closed dropdown (declared order, nothing preselected unless `default` is itself a member); everything else — including redacted or not-yet-declared inputs — gets a free-text prompt whose value is submitted to the engine unchanged. Coded engine errors (`ENUM-0xx`) and warnings (`ENUM-W001`) are shown verbatim, never paraphrased. | `gert` CLI on PATH (or set `gert.binaryPath`). |

## Inspector

The right rail is an operator inspector rather than a generic metadata panel.
With no selection it shows run progress, current step, outcome counts, inputs,
breakpoints, source, and diagnostics. Selecting a step opens three compact tabs:

- **Definition** renders authored behavior for that kind: tool/action and arguments,
  CLI command/process policy, branch conditions, prompts/options/fields, include
  bindings, loop or join policy, approval quorum, assertions, event filters,
  display content, compensation trigger, or terminal outcome.
- **Run** shows bounded live execution data: status, attempt, timing, errors,
  output, captures, process output, and evidence.
- **Debug** contains breakpoints, watches, and actual/effective override audit data.

The inspector becomes a scrollable bottom drawer on narrow editor groups. Declared
runtime secret values are never added to graph details; sensitive authored keys
and credential-like flags, assignments, and authorization values are redacted.

## Host-action protocol

The bundled webview may request the `xts.open-view` host capability, which requires
`view_path`, `environment`, `parameters`, and `focus`. The extension statically maps
each capability; a runbook can never choose a VS Code command ID. The correlated
result is written back to the active Gert child over `gert-stdio/v1`.

```json
{
  "type": "gert.host-action.request",
  "version": "host-action/v1",
  "runId": "run-123",
  "turnId": "turn-123",
  "correlationId": "turn-123",
  "previewSessionId": "preview-session-123",
  "requestId": "preview-session-123:turn-123",
  "capability": "xts.open-view",
  "request": {
    "view_path": "logical-view-name",
    "environment": "prod",
    "parameters": { "search_string": "server-name" },
    "focus": true
  }
}
```

The final Gert wire shape is closed: aliases and undeclared fields are
rejected. At the trusted extension boundary, the capability maps only to
`xts.openViewWithParameters` with exactly
`{ viewPath, environment, parameters, focus, correlationId }`. The extension
preserves the typed `parameters` object unchanged. Runbooks own the view path and
must use the target view's declared parameter names. XTS remains responsible for
validating the target view's parameter schema, configured view roots,
authentication, and the explicitly supplied environment.

The webview receives a correlated acknowledgment:

```json
{
  "type": "gert.host-action.ack",
  "version": "host-action/v1",
  "runId": "run-123",
  "turnId": "turn-123",
  "correlationId": "turn-123",
  "previewSessionId": "preview-session-123",
  "requestId": "preview-session-123:turn-123",
  "capability": "xts.open-view",
  "status": "completed",
  "result": { "status": "opened" },
  "error": null
}
```

The bridge ack statuses are `completed`, `failed`, `timed-out`, `unsupported`, and
`execution-not-started`. XTS terminal values (`opened`, `view-not-found`, `environment-not-found`,
`invalid-parameters`, `execution-not-started`) are carried inside `result.status` when the bridge status is `completed`. The extension never
includes a requested path, XTS row, or parameters in an acknowledgment.
Cancelling a matching tuple, reloading the preview, replacing its panel, or
disposing it acknowledges that tuple as `execution-not-started`; late command
results are ignored. Cancellation frames use their canonical
`correlationId`/`previewSessionId`/`requestId` subset, which is resolved only
against a pending full tuple. `unsupported` remains the framework-local Gert
result for headless execution with no host provider and is also the bridge
acknowledgment for an unregistered capability. Registered XTS capabilities do
not normally produce it from the VS Code host.

## Debug runs

Select a graph node to add a before- or after-execution breakpoint and optional
watch expressions. **Debug Run** starts `gert run --stdio --debug` and sends the
bounded breakpoint configuration over stdin before the engine starts. At a pause,
the inspector shows invocation identity, watches, runtime variables, the immutable
actual result, and controls for Continue, Apply and continue, Step into, Step over,
Step out, and Stop. After-execution pauses can patch effective output/status;
before-execution pauses can patch runtime variables. Applied overrides retain the
actual and effective values in the node audit details.

Reusable debug-profile list/save remains owned by Gert's validated profile store
and is not exposed by this server-free extension yet. Interactive breakpoints,
watches, stepping, and overrides do not require profile persistence.

When governance requires approval, the same inspector displays an Approve/Deny
prompt. Approval requires an operator identity and is recorded by Gert; direct
stdio runs never silently use the no-op approval gate.

Inputs declared as `type: secret` render as password fields and are sent in the
private `run.configure` stdin frame. They are never placed in child-process
arguments or emitted in run frames.

XTS host actions pause on an explicit **Open XTS** control in the run panel.
That reviewed in-panel action is the only launch confirmation; the extension
does not show a second modal. A reminder appears after a focused XTS view opens.

## Settings

- `gert.packageMap` — package-map selection for direct `gert run` execution. Absolute, or relative
  to the active runbook's project root. If it names `*.serve-package-map.yaml`, the extension uses
  the sibling `*.package-map.yaml` when present. Leave empty to use `package-map.yaml`. Example:
  `"packages/incident-routing.vscode-mcp.serve-package-map.yaml"`.
- `gert.binaryPath` — path to the `gert` CLI (default `gert`).
- `gert.preview.openLocation` — where the React Flow graph opens: `sameGroup` (default) opens it
  as a tab in the runbook editor's group; `beside` creates or uses an adjacent editor group.
- `gert.mcpBridge.toolNameOverrides` — a JSON object mapping logical `"tool/action"` keys to
  registered MCP tool names. Use this to correct a name mismatch in a live session without a code
  change or extension release. Example:
  ```json
  {
    "tsg-recommendation/recommend": "my-org-tsg-recommend",
    "icm/get-incident": "corp-icm-get-incident"
  }
  ```
  This setting takes precedence over the name declared in the workspace's `.tool.yaml` definitions.
  The YAML-derived names are still used for all entries not listed here.

## Prerequisites

- VS Code 1.95 or newer.
- Node.js 20 or newer, including `npm`.
- Go 1.25 or newer to build the sibling `gert` CLI repository.

## Build and debug

Open this repository in VS Code and press F5. The debug task installs npm dependencies when needed, compiles the extension, builds `..\gert\gert.exe`, and prepends `..\gert` to the Extension Development Host PATH.

Manual build:

```sh
npm ci
npm run compile
```

## Package (.vsix)

Reproducible local build from a clean checkout:

```sh
npm ci
npm run package
```

`npm run package` includes the runtime `js-yaml` dependency. Do not pass
`--no-dependencies`; that produces an extension which cannot activate.

Or use the pre-wired npm scripts:

```sh
npm run package          # produces gert-preview.vsix (uses version from package.json)
npm run package:clean    # wipes out/ first, recompiles, then packages
```

**Local install:**

```sh
code --install-extension gert-preview.vsix
```

Uninstall: `code --uninstall-extension ormasoftchile.gert-preview`

The CI workflow `.github/workflows/ci.yml` runs `npm run package` on every PR
and uploads the resulting `.vsix` as a build artifact.

## See also

- [gert](https://github.com/ormasoftchile/gert) — the runbook engine, server,
  and CLI this extension drives.
- This extension carries no `runbook/v1` JSON Schema, no YAML parser, and no
  member-validation logic of its own: every file is parsed and validated by
  the real `gert` CLI/server, and enum acceptance/rejection is always the
  engine's verdict (see
  `.squad/decisions/inbox/barbara-client-enum-compatibility-ruling.md` in
  `gert-private`, AR-CE-1).
