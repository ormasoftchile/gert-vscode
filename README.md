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

## See also

- [gert](https://github.com/ormasoftchile/gert) — the runbook engine, server,
  and CLI this extension drives.
