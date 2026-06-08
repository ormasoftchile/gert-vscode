# gert Runbook Preview (VS Code extension)

Two commands:

| Command | Behaviour | Requires |
|---|---|---|
| **gert: Open Runbook Preview** (`gert.preview`) | Runs `gert preview --format prose` against the active `.runbook.yaml` file and opens the rendered Markdown in a side-by-side preview. | `gert` CLI on PATH (or set `gert.binaryPath`). |
| **gert: Open Runbook Graph (React Flow)** (`gert.previewGraph`) | Opens a webview pointed at the gert server's `/preview/` page, which mounts the React Flow `<RunbookView>` component. | `gert serve` running, `gert.serverUrl` configured. |

## Settings

- `gert.binaryPath` — path to the `gert` CLI (default `gert`).
- `gert.serverUrl` — base URL of the gert server (default `http://localhost:7778`).

## Build

```sh
npm install
npm run compile
```

Then press F5 in VS Code to launch an Extension Development Host.

## Package (.vsix)

```sh
npm run package          # produces gert-preview.vsix
npm run package:clean    # rebuild from scratch
```

The CI workflow `.github/workflows/ci.yml` runs `npm run package` on every PR
and uploads the resulting `.vsix` as a build artifact.

To install a local build: `code --install-extension gert-preview.vsix`.

## Schema validation

The extension contributes a JSON Schema for `.runbook.yaml` / `.runbook.yml` files. When the [Red Hat YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml) is installed, VS Code uses this schema to provide structural validation, completions, and hover docs for all runbook files automatically — no per-file `$schema:` declaration required.

**Peer dependency:** `redhat.vscode-yaml` must be installed for schema validation to activate.

The schema is vendored from `gert-private` under `schemas/runbook.v1.schema.json`. To check for drift or refresh the vendor copy, run:

```sh
npm run schema:check    # exits 0 if in sync, 1 if drifted
npm run schema:update   # overwrites vendored copy with canonical
```

**Assumption:** `gert-private` is cloned as a sibling directory of `gert-vscode` (i.e., `../gert-private/`). Set `GERT_PRIVATE_ROOT` to override.

## See also

- [gert](https://github.com/ormasoftchile/gert) — the runbook engine, server,
  and CLI this extension drives.
