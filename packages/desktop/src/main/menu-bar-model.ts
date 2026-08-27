import type { TunnelStatus } from '@localtunnel/agent';

/**
 * What the macOS menu bar item should say, derived from the agent's status.
 *
 * Kept free of Electron on purpose: this is the part with rules in it — which
 * label, which icon, whether Start or Stop is offered, what "Copy URL" copies —
 * and it is testable in plain Node. menu-bar.ts turns the result into an
 * NSStatusItem and a menu, and holds no decisions of its own.
 */

export interface MenuBarService {
  id: string;
  name: string;
  /** The address a visitor uses, or null for a service the gateway has not published. */
  url: string | null;
  /** What the tunnel points at on this computer. */
  target: string;
  /** From the agent's last probe: is the local service actually listening? */
  reachable: boolean | null;
}

export interface MenuBarSummary {
  /** True when a tunnel is up or trying to be — i.e. the agent is not idle. */
  running: boolean;
  connected: boolean;
  /** Headline line, e.g. "Connected" or "Reconnecting in 4s". */
  stateLabel: string;
  /** Second line: the gateway, or why there is no tunnel. Null when there is nothing to add. */
  detail: string | null;
  /** Menu bar hover text. */
  tooltip: string;
  services: MenuBarService[];
  /** What "Copy Public URL" puts on the pasteboard, or null when it is disabled. */
  primaryUrl: string | null;
  canStart: boolean;
  canStop: boolean;
  /** Which template image to show; see scripts/make-tray-icon.mjs. */
  icon: 'idle' | 'connected';
}

/** The public address of a service, as a visitor would type it. */
export function serviceUrl(service: {
  type: string;
  hostname?: string | null;
  publicPort?: number | null;
}, gatewayHost: string | null): string | null {
  if (service.type === 'http' || service.type === 'https') {
    return service.hostname ? `https://${service.hostname}` : null;
  }
  if (!service.publicPort) return null;
  const host = gatewayHost ?? 'your-gateway';
  return `${service.type === 'udp' ? 'udp' : 'tcp'}://${host}:${service.publicPort}`;
}

/** Where the tunnel delivers on this computer. */
export function serviceTarget(service: { localHost: string; localPort: number }): string {
  return `${service.localHost}:${service.localPort}`;
}

function stateLabel(status: TunnelStatus): string {
  switch (status.state) {
    case 'connected':
      return status.latencyMs === null ? 'Connected' : `Connected · ${status.latencyMs} ms`;
    case 'connecting':
      return 'Connecting…';
    case 'reconnecting':
      return status.retryInSeconds === null || status.retryInSeconds <= 0
        ? 'Reconnecting…'
        : `Reconnecting in ${status.retryInSeconds}s`;
    case 'revoked':
      return 'This computer was revoked';
    case 'error':
      return 'Disconnected';
    default:
      return 'Not running';
  }
}

/**
 * Fold the agent's status into the menu bar's view of the world.
 *
 * `null` means the agent is not answering at all — not installed, not started,
 * or gone. That is a different thing from an agent reporting `idle`, but from
 * the menu bar both read as "no tunnel", so they share a shape.
 */
export function summarize(status: TunnelStatus | null): MenuBarSummary {
  if (!status) {
    return {
      running: false,
      connected: false,
      stateLabel: 'Not running',
      detail: null,
      tooltip: 'LocalTunnel — not running',
      services: [],
      primaryUrl: null,
      canStart: true,
      canStop: false,
      icon: 'idle',
    };
  }

  const connected = status.state === 'connected';
  const running = status.state !== 'idle';
  const services: MenuBarService[] = status.services.map((service) => ({
    id: service.id,
    name: service.name,
    url: serviceUrl(service, status.gatewayHost),
    target: serviceTarget(service),
    reachable: status.probes[service.id]?.reachable ?? null,
  }));

  const label = stateLabel(status);
  const detail =
    status.state === 'error' || status.state === 'revoked'
      ? status.lastError ?? null
      : status.gatewayHost
        ? `Gateway ${status.gatewayHost}`
        : null;

  return {
    running,
    connected,
    stateLabel: label,
    detail,
    tooltip: `LocalTunnel — ${label}`,
    services,
    primaryUrl: services.find((s) => s.url)?.url ?? null,
    // 'revoked' is terminal: this computer's certificate is gone, and starting
    // the tunnel again cannot succeed until it is enrolled afresh in the app.
    canStart: status.state === 'idle' || status.state === 'error',
    canStop: running && status.state !== 'revoked',
    icon: connected ? 'connected' : 'idle',
  };
}
