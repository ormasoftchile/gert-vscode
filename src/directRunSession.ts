export const STDIO_PROTOCOL_VERSION = 'gert-stdio/v1' as const;
const MAX_PROTOCOL_LINE_BYTES = 1024 * 1024;

export interface StdioProtocolFrame {
  type: string;
  version: typeof STDIO_PROTOCOL_VERSION;
  runID?: string;
  [key: string]: unknown;
}

export interface DirectRunCallbacks {
  onFrame(frame: StdioProtocolFrame): void;
  onError(message: string): void;
  onExit(code: number | null, signal: NodeJS.Signals | null): void;
  onStderr?(text: string): void;
}

export interface RunChildProcess {
  stdin: {
    write(data: string): unknown;
    on?(event: 'error', listener: (error: Error) => void): unknown;
  };
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  killed: boolean;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export function buildStdioRunArgs(
  runbookPath: string,
  inputs: Readonly<Record<string, string>>,
  packageMapPath?: string,
  debug = false,
  privateInputNames: ReadonlySet<string> = new Set(),
  routeTestPath?: string,
): string[] {
  const args = ['run', '--stdio'];
  if (routeTestPath) {
    // The reviewed artifact is authoritative; never mix live input or debug
    // configuration into a zero-dispatch route test.
  } else if (debug) {
    args.push('--debug');
  } else if (privateInputNames.size > 0) {
    args.push('--configure');
  }
  if (packageMapPath) {
    args.push('--package-map', packageMapPath);
  }
  if (routeTestPath) {
    args.push('--route-test', routeTestPath);
  } else {
    for (const name of Object.keys(inputs).sort()) {
      if (privateInputNames.has(name)) continue;
      args.push('--var', `${name}=${inputs[name]}`);
    }
  }
  args.push(runbookPath);
  return args;
}

export class DirectRunSession {
  private buffer = '';
  private runID: string | undefined;
  private terminal = false;
  private disposed = false;
  private finalized = false;

  constructor(
    private readonly child: RunChildProcess,
    private readonly callbacks: DirectRunCallbacks,
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string | Buffer) => this.receive(String(chunk)));
    child.stdout.on('end', () => {
      if (!this.terminal && this.buffer.trim()) this.parseLine(this.buffer);
      this.buffer = '';
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string | Buffer) => callbacks.onStderr?.(String(chunk)));
    child.stdin.on?.('error', (error) => {
      if (!this.disposed) this.protocolFailure(error.message);
    });
    child.on('error', (error) => {
      if (!this.disposed) callbacks.onError(error.message);
      this.finalize(null, null);
    });
    child.on('close', (code, signal) => this.finalize(code, signal));
  }

  setRunID(runID: string): void {
    this.runID = runID;
  }

  send(command: Readonly<Record<string, unknown>>): void {
    if (this.disposed || this.terminal) return;
    let encoded: string;
    try {
      encoded = `${JSON.stringify(command)}\n`;
    } catch {
      this.protocolFailure('stdio command must be JSON serializable');
      return;
    }
    if (Buffer.byteLength(encoded, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
      this.protocolFailure(`stdio command exceeds ${MAX_PROTOCOL_LINE_BYTES} bytes`);
      return;
    }
    try {
      this.child.stdin.write(encoded);
    } catch (error) {
      this.protocolFailure(error instanceof Error ? error.message : String(error));
    }
  }

  dispose(): void {
    if (this.disposed) return;
    const shouldCancel = !this.terminal && this.runID && this.child.exitCode === null && !this.child.killed;
    this.disposed = true;
    if (shouldCancel) {
      const cancellation = `${JSON.stringify({
        type: 'run.cancel',
        runID: this.runID,
        reason: 'panel disposed',
      })}\n`;
      try {
        this.child.stdin.write(cancellation);
      } catch {
        // The child may have closed stdin before emitting close.
      }
    }
    if (this.child.exitCode === null && !this.child.killed) {
      this.child.kill();
    }
  }

  private receive(chunk: string): void {
    if (this.disposed || this.terminal) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
      this.buffer = '';
      this.protocolFailure(`stdio protocol line exceeds ${MAX_PROTOCOL_LINE_BYTES} bytes`);
      return;
    }
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trimEnd();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.parseLine(line);
      if (this.disposed || this.terminal) return;
      newline = this.buffer.indexOf('\n');
    }
  }

  private parseLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.protocolFailure('stdio protocol emitted invalid JSON');
      return;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.protocolFailure('stdio protocol frame must be an object');
      return;
    }
    const frame = value as Record<string, unknown>;
    if (frame.version !== STDIO_PROTOCOL_VERSION) {
      this.protocolFailure(`unsupported protocol version ${JSON.stringify(frame.version)}`);
      return;
    }
    if (typeof frame.type !== 'string' || frame.type.length === 0) {
      this.protocolFailure('stdio protocol frame type must be a non-empty string');
      return;
    }
    if (frame.type !== 'protocol.error') {
      if (typeof frame.runID !== 'string' || frame.runID.length === 0) {
        this.protocolFailure(`${frame.type} frame requires runID`);
        return;
      }
      if (frame.type === 'run.started') {
        if (this.runID && frame.runID !== this.runID) {
          this.protocolFailure(`runID ${JSON.stringify(frame.runID)} does not match active run ${JSON.stringify(this.runID)}`);
          return;
        }
        this.runID = frame.runID;
      } else if (!this.runID || frame.runID !== this.runID) {
        this.protocolFailure(`runID ${JSON.stringify(frame.runID)} does not match active run ${JSON.stringify(this.runID)}`);
        return;
      }
    }
    if (frame.type === 'run.finished') {
      this.terminal = true;
      this.buffer = '';
    }
    this.callbacks.onFrame(frame as StdioProtocolFrame);
  }

  private protocolFailure(message: string): void {
    if (this.disposed) return;
    this.callbacks.onError(message);
    this.dispose();
  }

  private finalize(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.finalized) return;
    this.finalized = true;
    this.disposed = true;
    this.callbacks.onExit(code, signal);
  }
}