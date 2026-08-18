// ServerManager owns the lifecycle of a `gert serve` child process.
//
// On first request it spawns the server on a free local port, waits for
// it to be reachable, and reuses it for subsequent requests in the same
// session. On extension deactivate the process is killed.
//
// If `gert.serverUrl` is set to a non-default value the user is opting
// out of auto-spawn and the manager just returns that URL.

import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { pickServerRoot } from './serverRoot';
import { localServerAddress, buildServeArgs, resolvePackageMapPath } from './serverLaunch';

const DEFAULT_SERVER_URL = 'http://localhost:7778';

export class ServerManager {
  private proc: ChildProcess | null = null;
  private url: string | null = null;
  private starting: Promise<string> | null = null;
  private readonly output: vscode.OutputChannel;
  // Bridge environment provisioned by the extension on activation.
  // Passed through to every `gert serve` child process so Gert can reach
  // the loopback MCP bridge without ever learning the auth credentials.
  private bridgeEnv: { GERT_VSCODE_BRIDGE_URL: string; GERT_VSCODE_BRIDGE_TOKEN: string } | null = null;

  constructor(output: vscode.OutputChannel) {
    this.output = output;
  }

  // setBridgeEnv provisions the loopback bridge coordinates. Must be called
  // before the first ensureRunning if you want Gert to see the bridge.
  setBridgeEnv(url: string, token: string): void {
    this.bridgeEnv = { GERT_VSCODE_BRIDGE_URL: url, GERT_VSCODE_BRIDGE_TOKEN: token };
  }

  // ensureRunning returns a base URL (e.g. http://localhost:54321) that
  // is reachable. It either reuses an already-spawned server, returns
  // the user-configured external URL, or starts a new child process.
  async ensureRunning(runbookPath: string): Promise<string> {
    const cfg = vscode.workspace.getConfiguration('gert');
    const configuredURL = cfg.get<string>('serverUrl', DEFAULT_SERVER_URL).replace(/\/$/, '');
    const autoStart = cfg.get<boolean>('autoStartServer', true);

    // User pointed at an external server; use it as-is.
    if (!autoStart || (configuredURL && configuredURL !== DEFAULT_SERVER_URL)) {
      this.output.appendLine(`[gert] using external server at ${configuredURL}`);
      return configuredURL;
    }

    if (this.url && this.proc && this.proc.exitCode === null) {
      return this.url;
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.spawnServer(runbookPath).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async spawnServer(runbookPath: string): Promise<string> {
    const cfg = vscode.workspace.getConfiguration('gert');
    const configured = cfg.get<string>('binaryPath', 'gert');
    const bin = await resolveBinary(configured, this.output);
    const port = await pickFreePort();
    const addr = localServerAddress(port);
    // Scope the server to the active runbook's project. Scanning a broad
    // multi-root workspace allows duplicate tool names from another project to
    // shadow the binding declared by this runbook.
    const cwd = pickServerRoot(
      runbookPath,
      (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      path.dirname(bin),
    );
    // Package-map resolution chain: setting → convention → absent.
    // settingValue is resolved against cwd (the active project root), never
    // against workspaceFolders[0], which would reintroduce the multi-root bug.
    const packageMapSetting = cfg.get<string>('packageMap', '');
    const packageMapPath = resolvePackageMapPath(cwd, packageMapSetting);
    if (packageMapSetting && !packageMapPath) {
      this.output.appendLine(`[gert] WARNING: gert.packageMap "${packageMapSetting}" not found in ${cwd}; falling through to convention`);
    }
    const serveArgs = buildServeArgs(addr, packageMapPath);
    this.output.appendLine(`[gert] spawning ${bin} ${serveArgs.join(' ')} (cwd=${cwd})`);
    const proc = spawn(bin, serveArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...this.bridgeEnv ?? {} },
    });
    this.proc = proc;

    proc.stdout?.on('data', (b: Buffer) => this.output.append(b.toString()));
    proc.stderr?.on('data', (b: Buffer) => this.output.append(b.toString()));
    proc.on('exit', (code, signal) => {
      this.output.appendLine(`[gert] server exited code=${code} signal=${signal}`);
      this.proc = null;
      this.url = null;
    });
    proc.on('error', (err) => {
      this.output.appendLine(`[gert] server spawn error: ${err.message}`);
    });

    // Use the explicit loopback address for the health/probe URL. `localhost`
    // can resolve to ::1 on dual-stack hosts, which is a different socket than
    // our 127.0.0.1 bind and would cause every probe request to ECONNREFUSED.
    const url = `http://127.0.0.1:${port}`;
    await waitForReady(url, 10_000);
    this.output.appendLine(`[gert] server ready at ${url}`);
    this.url = url;
    return url;
  }

  dispose(): void {
    if (this.proc && this.proc.exitCode === null) {
      this.output.appendLine(`[gert] killing server pid=${this.proc.pid}`);
      this.proc.kill();
    }
    this.proc = null;
    this.url = null;
  }
}

// pickFreePort asks the OS for an ephemeral port and returns it. There
// is a small race window between us closing the listener and gert
// binding the port, but it is acceptable for a developer tool.
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr && typeof addr.port === 'number') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error('failed to pick free port'));
      }
    });
  });
}

// waitForReady polls GET <url>/preview/ until it responds 2xx/3xx or
// the timeout elapses.
function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<void>((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(`${url}/preview/`, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) {
          resolve();
          return;
        }
        scheduleRetry();
      });
      req.on('error', scheduleRetry);
      req.setTimeout(500, () => req.destroy());
    };
    const scheduleRetry = () => {
      if (Date.now() > deadline) {
        reject(new Error(`server at ${url} did not become ready within ${timeoutMs}ms`));
        return;
      }
      setTimeout(tryOnce, 150);
    };
    tryOnce();
  });
}

// resolveBinary tries a sequence of locations to find an executable
// `gert` binary on disk. We do NOT fall back to a bare 'gert' on PATH
// because VS Code's child process inherits a stripped PATH, not the
// user's shell PATH, and ENOENT is a confusing failure mode.
async function resolveBinary(configured: string, output: vscode.OutputChannel): Promise<string> {
  const candidates: string[] = [];

  if (path.isAbsolute(configured)) {
    candidates.push(configured);
  } else if (configured && configured !== 'gert') {
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      candidates.push(path.join(f.uri.fsPath, configured));
    }
  }

  // Workspace-local builds. Also walk up parent directories so that
  // opening a subfolder (e.g. examples/) still finds a sibling/parent
  // build of the binary.
  const seen = new Set<string>();
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    let dir = f.uri.fsPath;
    for (let i = 0; i < 6; i++) {
      if (seen.has(dir)) break;
      seen.add(dir);
      candidates.push(path.join(dir, 'gert'));
      candidates.push(path.join(dir, 'bin', 'gert'));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // Common Go install locations.
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) candidates.push(path.join(home, 'go', 'bin', 'gert'));
  if (process.env.GOPATH) candidates.push(path.join(process.env.GOPATH, 'bin', 'gert'));

  // Manual PATH walk (don't trust child_process to see the shell PATH).
  if (process.env.PATH) {
    for (const dir of process.env.PATH.split(path.delimiter)) {
      if (dir) candidates.push(path.join(dir, 'gert'));
    }
  }

  const executableCandidates = process.platform === 'win32'
    ? candidates.flatMap((candidate) => path.extname(candidate) ? [candidate] : [candidate, `${candidate}.exe`])
    : candidates;

  for (const c of executableCandidates) {
    try {
      const st = await fs.promises.stat(c);
      if (!st.isFile()) continue;
      await fs.promises.access(c, fs.constants.X_OK);
      output.appendLine(`[gert] resolved binary: ${c}`);
      return c;
    } catch {
      // not present / not executable; try next
    }
  }

  throw new Error(
    `cannot find gert binary on disk. Tried:\n  ${executableCandidates.join('\n  ')}\nSet "gert.binaryPath" in settings to an absolute path.`,
  );
}

