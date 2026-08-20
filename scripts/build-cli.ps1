param(
  [string]$ExtensionRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
  Write-Error "gert CLI debug build failed: $Message"
  exit 1
}

function Find-Go {
  $fromPath = Get-Command go -ErrorAction SilentlyContinue
  if ($fromPath) {
    return $fromPath.Source
  }

  $candidates = @(
    'C:\Program Files\Go\bin\go.exe',
    'C:\Go\bin\go.exe'
  )
  if ($env:LOCALAPPDATA) {
    $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Go\bin\go.exe')
  }

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return $candidate
    }
  }

  return $null
}

$ExtensionRoot = [System.IO.Path]::GetFullPath($ExtensionRoot)
$gertRepo = [System.IO.Path]::GetFullPath((Join-Path $ExtensionRoot '..\gert'))

if (-not (Test-Path -LiteralPath $gertRepo -PathType Container)) {
  Fail "expected sibling repository at $gertRepo, but it does not exist. Clone https://github.com/ormasoftchile/gert next to gert-vscode, then press F5 again."
}

$goMod = Join-Path $gertRepo 'go.mod'
$cmdGert = Join-Path $gertRepo 'cmd\gert'
if (-not (Test-Path -LiteralPath $goMod -PathType Leaf) -or -not (Test-Path -LiteralPath $cmdGert -PathType Container)) {
  Fail "$gertRepo does not look like the gert CLI repository. Expected go.mod and cmd\gert. Clone https://github.com/ormasoftchile/gert next to gert-vscode."
}

$go = Find-Go
if (-not $go) {
  Fail "Go was not found on PATH or in common Windows install locations. Install Go 1.25+ from https://go.dev/dl/ (or winget install GoLang.Go), then reopen VS Code. Checked PATH, C:\Program Files\Go\bin\go.exe, %LOCALAPPDATA%\Programs\Go\bin\go.exe, and C:\Go\bin\go.exe."
}

Write-Host "Building gert CLI using $go in $gertRepo."
Push-Location $gertRepo
try {
  & $go build -o gert.exe ./cmd/gert
  if ($LASTEXITCODE -ne 0) {
    Fail "go build exited with code $LASTEXITCODE. Resolve the Go build error above, then press F5 again."
  }
} finally {
  Pop-Location
}

$output = Join-Path $gertRepo 'gert.exe'
if (-not (Test-Path -LiteralPath $output -PathType Leaf)) {
  Fail "go build reported success but $output was not created."
}

Write-Host "gert CLI debug build complete: $output"
