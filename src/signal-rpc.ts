/**
 * Line-delimited JSON-RPC client for signal-cli.
 *
 * Two transports, one wire format (signal-cli-jsonrpc(5)):
 *   - spawn  `signal-cli -a ACCOUNT jsonRpc --receive-mode=manual` as a child
 *     and talk over its stdin/stdout (default; the child lives and dies with
 *     this server);
 *   - connect to a long-running `signal-cli daemon --socket PATH` (set
 *     SIGNAL_CLI_SOCKET), so an MCPL restart does not restart signal-cli.
 *
 * `--receive-mode=manual` matters: signal-cli acknowledges a message to the
 * Signal service as soon as it receives it, so anything received before the
 * host is ready to take it would exist only in our log. With manual mode the
 * service keeps holding messages until the server calls `subscribeReceive`
 * (see SignalMcplServer.ensureSubscribed), which it does only once the host
 * has granted push delivery.
 *
 * The transport restarts with capped exponential backoff when signal-cli
 * exits or the socket drops; in-flight requests are rejected, and an `up`
 * event fires on each reconnect so the caller can re-subscribe.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

export interface SignalRpcOptions {
  /** Path to a `signal-cli daemon --socket` UNIX socket. Unset ⇒ spawn. */
  socketPath?: string;
  /** signal-cli executable (spawn mode). */
  bin: string;
  /** Account (phone number or ACI) the child is started for (spawn mode). */
  account: string;
  /** signal-cli --config data directory (spawn mode). */
  dataDir?: string;
  /** Per-request timeout. Sends can be slow on a cold connection. */
  requestTimeoutMs?: number;
  log: (...a: unknown[]) => void;
}

export class SignalRpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
    this.name = 'SignalRpcError';
  }
}

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Events:
 *   - `receive` (params: unknown) — a `receive` notification, either the plain
 *     `{envelope, account}` shape or the subscription `{subscription, result}`
 *     shape; envelope.ts normalizes both.
 *   - `up` — a transport is attached (fires again after every reconnect).
 *   - `down` — the transport dropped; a reconnect is scheduled.
 */
export class SignalRpc extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private write: ((line: string) => void) | null = null;
  private closeTransport: (() => void) | null = null;
  /** Incremented per connection attempt so a late exit/close from an old
   *  transport can never tear down its successor. */
  private generation = 0;
  /** Last generation whose teardown already ran. */
  private downGeneration = -1;
  private stopped = false;
  private backoffMs = MIN_BACKOFF_MS;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: SignalRpcOptions) {
    super();
  }

  get isUp(): boolean {
    return this.write !== null;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.closeTransport?.();
    this.down(this.generation, 'stopped');
  }

  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const write = this.write;
    if (!write) return Promise.reject(new SignalRpcError('signal-cli is not connected'));
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SignalRpcError(`signal-cli ${method} timed out`));
      }, this.opts.requestTimeoutMs ?? 60_000);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }));
    });
  }

  private connect(): void {
    if (this.stopped) return;
    const gen = ++this.generation;
    if (this.opts.socketPath) this.connectSocket(gen, this.opts.socketPath);
    else this.spawnChild(gen);
  }

  private spawnChild(gen: number): void {
    const { bin, account, dataDir, log } = this.opts;
    const args = [
      ...(dataDir ? ['--config', dataDir] : []),
      '-a', account,
      'jsonRpc',
      '--receive-mode=manual',
    ];
    log(`spawning ${bin} ${args.join(' ')}`);
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    // 'error' (e.g. ENOENT) and 'exit' can both fire; down() is idempotent
    // per generation.
    child.on('error', (e) => this.down(gen, `spawn error: ${e.message}`));
    child.on('exit', (code, signal) => this.down(gen, `signal-cli exited (code=${code} signal=${signal})`));
    child.stdin.on('error', () => { /* surfaced via exit */ });
    createInterface({ input: child.stderr }).on('line', (line) => log(`[signal-cli] ${line}`));
    this.attach(gen, child.stdout, (line) => child.stdin.write(line + '\n'), () => child.kill('SIGTERM'));
  }

  private connectSocket(gen: number, path: string): void {
    const sock = net.createConnection(path);
    sock.on('connect', () => {
      this.opts.log(`connected to signal-cli daemon at ${path}`);
      this.attach(gen, sock, (line) => sock.write(line + '\n'), () => sock.destroy());
    });
    sock.on('error', (e) => this.opts.log(`socket error: ${e.message}`));
    sock.on('close', () => this.down(gen, 'daemon socket closed'));
  }

  private attach(gen: number, readable: Readable, write: (line: string) => void, close: () => void): void {
    if (gen !== this.generation) { close(); return; }
    this.write = write;
    this.closeTransport = close;
    createInterface({ input: readable }).on('line', (line) => this.onLine(line));
    this.emit('up');
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.opts.log(`unparseable line from signal-cli: ${line.slice(0, 200)}`);
      return;
    }
    if (msg.id !== undefined && msg.id !== null && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(String(msg.id));
      if (!p) return;
      this.pending.delete(String(msg.id));
      clearTimeout(p.timer);
      if (msg.error) {
        const err = msg.error as { code?: number; message?: string; data?: unknown };
        p.reject(new SignalRpcError(`${p.method}: ${err.message ?? 'error'}`, err.code, err.data));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === 'receive') this.emit('receive', msg.params);
  }

  private down(gen: number, reason: string): void {
    if (gen !== this.generation || gen === this.downGeneration) return;
    this.downGeneration = gen;
    const wasUp = this.write !== null;
    this.write = null;
    this.closeTransport = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new SignalRpcError(`signal-cli connection lost (${reason})`));
      this.pending.delete(id);
    }
    if (wasUp) this.emit('down');
    if (this.stopped) return;
    if (this.restartTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
    this.opts.log(`${reason}; reconnecting in ${Math.round(delay / 1000)}s`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.connect();
    }, delay);
  }

  /** Reset the backoff once a connection has proven itself (a request
   *  succeeded), so one bad hour doesn't leave every later restart slow. */
  markHealthy(): void {
    this.backoffMs = MIN_BACKOFF_MS;
  }
}
