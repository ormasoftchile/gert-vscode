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

const DEFAULT_SERVER_URL = 'http://localhost:7778';

export class ServerManager {
  private proc: ChildProcess | null = null;
  private url: string | null = null;
  private starting: Promise<string> | null = null;
  private readonly output: vscode.OutputChannel;

  constructor(output: vscode.OutputChannel) {
    this.output = output;
  }

  // ensureRunning returns a base URL (e.g. http://localhost:54321) that
  // is reachable. It either reuses an already-spawned server, returns
  // the user-configured external URL, or starts a new child process.
  async ensureRunning(): Promise<string> {
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
    this.starting = this.spawnServer().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async spawnServer(): Promise<string> {
    const cfg = vscode.workspace.getConfiguration('gert');
    const configured = cfg.get<string>('binaryPath', 'gert');
    const bin = await resolveBinary(configured, this.output);
    const port = await pickFreePort();
    const addr = `:${port}`;
    // Pick a sane cwd: walk up from each workspace folder looking for a
    // directory that contains a `tools/` subdir (the gert project root).
    // 'gert serve' scans cwd recursively for tool defs at startup, so the
    // cwd needs to be the project root, not a sub-folder. Falls back to the
    // first workspace folder, then the dir containing the binary.
    const cwd = pickServerCwd(bin);
    this.output.appendLine(`[gert] spawning ${bin} serve --addr ${addr} (cwd=${cwd})`);
    const proc = spawn(bin, ['serve', '--addr', addr], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
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

    const url = `http://localhost:${port}`;
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

  for (const c of candidates) {
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
    `cannot find gert binary on disk. Tried:\n  ${candidates.join('\n  ')}\nSet "gert.binaryPath" in settings to an absolute path.`,
  );
}

// pickServerCwd finds a directory to run `gert serve` from. The server
// scans cwd recursively for *.tool.yaml at startup, so we want the
// project root. We walk up from each workspace folder looking for a
// directory that contains a `tools/` subdirectory; failing that we use
// the first workspace folder, then the directory containing the binary.
function pickServerCwd(bin: string): string {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const f of folders) {
    let dir = f.uri.fsPath;
    for (let i = 0; i < 6; i++) {
      try {
        const st = fs.statSync(path.join(dir, 'tools'));
        if (st.isDirectory()) return dir;
      } catch {
        // not here, walk up
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  if (folders[0]) return folders[0].uri.fsPath;
  return path.dirname(bin);
}

