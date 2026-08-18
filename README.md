# gert Runbook Preview (VS Code extension)

Open a `*.runbook.yaml` file and use the preview or graph button in the editor
title bar. The same actions are also available from the Command Palette.

Three commands:

| Command | Behaviour | Requires |
|---|---|---|
| **gert: Open Runbook Preview** (`gert.preview`) | Runs `gert preview --format prose` against the active `.runbook.yaml` file and opens the rendered Markdown in a side-by-side preview. | `gert` CLI on PATH (or set `gert.binaryPath`). |
| **gert: Open Runbook Graph (React Flow)** (`gert.previewGraph`) | Opens a webview pointed at the gert server's `/preview/` page, which mounts the React Flow `<RunbookView>` component. | The extension starts `gert serve` automatically by default. |
| **gert: Validate Runbook Inputs (Dry Run)** (`gert.validateInputs`) | Prompts for a value per declared runbook input, then runs `gert dry-run` against the real CLI. Enum-constrained inputs get a closed dropdown (declared order, nothing preselected unless `default` is itself a member); everything else — including redacted or not-yet-declared inputs — gets a free-text prompt whose value is submitted to the engine unchanged. Coded engine errors (`ENUM-0xx`) and warnings (`ENUM-W001`) are shown verbatim, never paraphrased. | `gert` CLI on PATH (or set `gert.binaryPath`). |

## Settings

- `gert.packageMap` — path to the package-map file passed to `gert serve --package-map`.
  Absolute, or relative to the active runbook's project root. Leave empty to fall back to the
  project-root convention (`package-map.yaml`). If neither the setting path nor the convention
  file exists, `--package-map` is omitted. This is the correct way to select the `vscode-mcp`
  binding when multiple bindings coexist (e.g. `package-map.yaml` for stdio, `package-map.mock.yaml`
  for deterministic testing). Example: `"package-map.vscode.yaml"`.
- `gert.binaryPath` — path to the `gert` CLI (default `gert`).
- `gert.serverUrl` — base URL of the gert server (default `http://localhost:7778`).
- `gert.autoStartServer` — start and manage `gert serve` automatically (default `true`).
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

## Build

```sh
npm ci
npm run compile
```

Then press F5 in VS Code to launch an Extension Development Host.

## Package (.vsix)

Reproducible local build from a clean checkout:

```sh
npm ci
npm run compile
npx vsce package --no-dependencies -o gert-preview-<version>.vsix
# e.g.
npx vsce package --no-dependencies -o gert-preview-0.1.0.vsix
```

Or use the pre-wired npm scripts:

```sh
npm run package          # produces gert-preview.vsix (uses version from package.json)
npm run package:clean    # wipes out/ first, recompiles, then packages
```

**Versioned install** (replace `<version>` with the version in `package.json`):

```sh
code --install-extension gert-preview-<version>.vsix
# e.g.
code --install-extension gert-preview-0.1.0.vsix
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
