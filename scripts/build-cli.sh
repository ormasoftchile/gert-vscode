#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "gert CLI debug build failed: $1" >&2
  exit 1
}

find_go() {
  if command -v go >/dev/null 2>&1; then
    command -v go
    return 0
  fi
  for candidate in /opt/homebrew/bin/go /usr/local/go/bin/go /usr/local/bin/go /usr/bin/go "$HOME/go/bin/go"; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="${1:-"$(cd "$SCRIPT_DIR/.." && pwd)"}"
EXTENSION_ROOT="$(cd "$EXTENSION_ROOT" 2>/dev/null && pwd || echo "$EXTENSION_ROOT")"
GERT_REPO="$(cd "$EXTENSION_ROOT/../gert" 2>/dev/null && pwd || echo "$EXTENSION_ROOT/../gert")"

if [ ! -d "$GERT_REPO" ]; then
  fail "expected sibling repository at $GERT_REPO, but it does not exist. Clone https://github.com/ormasoftchile/gert next to gert-vscode, then press F5 again."
fi

GO_MOD="$GERT_REPO/go.mod"
CMD_GERT="$GERT_REPO/cmd/gert"
if [ ! -f "$GO_MOD" ] || [ ! -d "$CMD_GERT" ]; then
  fail "$GERT_REPO does not look like the gert CLI repository. Expected go.mod and cmd/gert. Clone https://github.com/ormasoftchile/gert next to gert-vscode."
fi

GO_BIN="$(find_go || true)"
if [ -z "$GO_BIN" ]; then
  fail "Go was not found on PATH or in common install locations. Install Go 1.25+ from https://go.dev/dl/ (or brew install go), then reopen VS Code."
fi

echo "Building gert CLI using $GO_BIN in $GERT_REPO."
(
  cd "$GERT_REPO"
  "$GO_BIN" build -o gert ./cmd/gert
) || fail "go build exited with an error. Resolve the Go build error above, then press F5 again."

OUTPUT="$GERT_REPO/gert"
if [ ! -f "$OUTPUT" ]; then
  fail "go build reported success but $OUTPUT was not created."
fi

echo "gert CLI debug build complete: $OUTPUT"
