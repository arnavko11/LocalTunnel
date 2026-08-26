import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { CONTROL_HEADER, agentDataDir, controlSecret } from '@localtunnel/agent';
import type { TunnelStatus } from '@localtunnel/agent';

/**
 * Runs and talks to the background agent.
 *
 * The agent is a separate process on purpose: it must keep tunnelling when the
 * window is closed, and it must survive the UI crashing. The app supervises it while
 * open; the autostart entry keeps it running afterwards.
 */

export interface SupervisorOptions {
  /** Node executable to run the agent with. */
  execPath: string;
  /** Path to the agent's entrypoint. */
  scriptPath: string;
  socketPath: string;
}

export class AgentSupervisor extends EventEmitter {
  private child: ChildProcess | null = null;
  private polling: NodeJS.Timeout | null = null;
  private lastStatus: TunnelStatus | null = null;
  /** The start currently in flight, so concurrent callers share one attempt. */
  private starting: Promise<void> | null = null;

  constructor(private readonly options: SupervisorOptions) {
    super();
  }

  /**
   * Start the agent if it is not already running (possibly from autostart).
   *
   * Every entry point calls this — app startup, Connect, Start — and they overlap:
   * without a single in-flight attempt two of them each spawn an agent, the second
   * finds the first already holding the socket and exits 0, and the user is told
   * the agent "did not start" while it is running perfectly well.
   */
  ensureRunning(): Promise<void> {
    if (!this.starting) {
      this.starting = this.launch().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async launch(): Promise<void> {
    if (await this.ping()) {
      this.startPolling();
      return;
    }
    if (!existsSync(this.options.scriptPath)) {
      throw new Error('The LocalTunnel agent is missing from this installation.');
    }
    const child = spawn(this.options.execPath, [this.options.scriptPath], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    this.child = child;
    // Keep the tail of the agent's output: if it dies on startup this is the
    // only explanation anyone gets, and "connect ENOENT …/agent.sock" further
    // down the call is not one.
    let output = '';
    const record = (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-2000);
      this.emit('log', chunk.toString());
    };
    child.stdout?.on('data', record);
    child.stderr?.on('data', record);
    let exitCode: number | null = null;
    let exited = false;
    child.on('exit', (code) => {
      exitCode = code;
      exited = true;
      this.emit('log', `agent exited with code ${code}\n`);
      if (this.child === child) this.child = null;
    });
    child.unref();

    // The IPC socket appears a moment after the process starts. Poll hard at
    // first — it is usually listening within a few tens of milliseconds — then
    // ease off so a genuinely broken start is not a busy loop.
    const deadline = Date.now() + 4000;
    let wait = 5;
    for (;;) {
      if (await this.ping()) {
        this.startPolling();
        return;
      }
      // A process that stood aside because another agent already holds the
      // socket exits cleanly and says so. That is a running agent, not a failed
      // start, so give the survivor a moment to answer before giving up.
      if (exited) {
        if (await this.waitForAgent(1000)) {
          this.startPolling();
          return;
        }
        break;
      }
      if (Date.now() >= deadline) break;
      await delay(wait);
      wait = Math.min(wait * 2, 100);
    }
    const detail = output.trim().split('\n').slice(-3).join('\n');
    throw new Error(
      `The LocalTunnel agent did not start${exitCode === null ? '' : ` (exit code ${exitCode})`}.` +
        (detail ? `\n${detail}` : ''),
    );
  }

  /** Poll the socket for up to `ms` waiting for some agent to answer. */
  private async waitForAgent(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await this.ping()) return true;
      if (Date.now() >= deadline) return false;
      await delay(25);
    }
  }

  private startPolling(): void {
    if (this.polling) return;
    this.polling = setInterval(() => {
      void this.status().then((status) => {
        if (!status) return;
        if (JSON.stringify(status) !== JSON.stringify(this.lastStatus)) {
          this.lastStatus = status;
          this.emit('status', status);
        }
      });
    }, 1000);
  }

  stopPolling(): void {
    if (this.polling) clearInterval(this.polling);
    this.polling = null;
  }

  /**
   * Is an agent listening on the socket?
   *
   * `/alive` rather than `/status` on purpose: liveness is not authorisation. An
   * agent that answers 401 — a control secret rewritten under a running agent,
   * say — is still an agent, and spawning a second one on top of it only produces
   * a process that stands aside and an error that blames the wrong thing.
   */
  async ping(): Promise<boolean> {
    try {
      await this.request('GET', '/alive');
      return true;
    } catch {
      return false;
    }
  }

  async status(): Promise<TunnelStatus | null> {
    try {
      return await this.request<TunnelStatus>('GET', '/status');
    } catch {
      return null;
    }
  }

  connect(options: { host: string; port: number; token: string; fingerprint: string }) {
    return this.request<{ machineId: string; gatewayId: string }>('POST', '/enroll', options);
  }

  start() {
    return this.request<TunnelStatus>('POST', '/start');
  }

  stop() {
    return this.request<TunnelStatus>('POST', '/stop');
  }

  disconnect() {
    return this.request<{ ok: boolean }>('POST', '/disconnect');
  }

  /** Forget this machine's identity entirely, then stop the agent. */
  async reset(): Promise<void> {
    this.stopPolling();
    try {
      await this.request<{ ok: boolean }>('POST', '/reset');
    } catch {
      // Already gone, or too old to know this endpoint — fall through to the kill.
    }
    this.child?.kill();
    this.child = null;
    this.lastStatus = null;
  }

  /** Ask the agent process to exit, and stop supervising it. */
  async shutdown(): Promise<void> {
    this.stopPolling();
    try {
      await this.request<{ ok: boolean }>('POST', '/shutdown');
    } catch {
      // The agent may have already gone; fall back to the child we spawned.
    }
    this.child?.kill();
    this.child = null;
    this.lastStatus = null;
  }

  discover() {
    return this.request<{ services: { port: number; guess: string }[] }>('GET', '/discover');
  }

  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        {
          socketPath: this.options.socketPath,
          path,
          method,
          timeout: 30_000,
          // The agent refuses anything that cannot present the secret from its
          // own 0700 data directory, so another local process cannot drive it.
          headers: {
            [CONTROL_HEADER]: controlSecret(agentDataDir()),
            ...(payload
              ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = null;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              parsed = { error: text };
            }
            if ((res.statusCode ?? 500) >= 400) {
              const message =
                parsed && typeof parsed === 'object' && 'error' in parsed
                  ? String((parsed as { error: unknown }).error)
                  : `agent request failed (${res.statusCode})`;
              reject(new Error(message));
            } else {
              resolve(parsed as T);
            }
          });
        },
      );
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('The LocalTunnel agent did not respond.'));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}

export function defaultSocketPath(dataDir: string): string {
  if (platform() === 'win32') return '\\\\.\\pipe\\localtunnel-agent';
  // The agent honours this override, so the app has to as well: pointing only one
  // of them at a different socket makes each invisible to the other.
  return process.env.LOCALTUNNEL_AGENT_SOCKET ?? `${dataDir}/agent.sock`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
