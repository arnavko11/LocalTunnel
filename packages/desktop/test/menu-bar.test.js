/**
 * The menu bar's rules, without a menu bar.
 *
 * Everything the status item decides — what it says, which icon it wears,
 * whether Start or Stop is offered, what "Copy Public URL" would copy — lives
 * in menu-bar-model.ts precisely so it can be checked here on any platform.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  summarize,
  serviceUrl,
  serviceTarget,
} = require('../dist/main/menu-bar-model.js');
const { menuBarSupported } = require('../dist/main/menu-bar.js');

/** A status the agent would plausibly report. */
function status(overrides = {}) {
  return {
    state: 'connected',
    machineId: 'm1',
    gatewayId: 'g1',
    gatewayHost: 'vps.example.com',
    latencyMs: 21,
    connectedSince: '2026-01-01T00:00:00.000Z',
    services: [],
    probes: {},
    lastError: null,
    retryInSeconds: null,
    attempts: 0,
    bytesIn: 0,
    bytesOut: 0,
    activeStreams: 0,
    ...overrides,
  };
}

const httpService = {
  id: 's1',
  name: 'Blog',
  type: 'http',
  localHost: '127.0.0.1',
  localPort: 3000,
  hostname: 'blog.example.com',
};

test('a missing agent reads as not running, and offers to start', () => {
  const s = summarize(null);
  assert.equal(s.running, false);
  assert.equal(s.connected, false);
  assert.equal(s.stateLabel, 'Not running');
  assert.equal(s.icon, 'idle');
  assert.equal(s.canStart, true);
  assert.equal(s.canStop, false);
  assert.equal(s.primaryUrl, null);
  assert.deepEqual(s.services, []);
});

test('a connected tunnel shows its gateway, latency and lit icon', () => {
  const s = summarize(status({ services: [httpService] }));
  assert.equal(s.connected, true);
  assert.equal(s.stateLabel, 'Connected · 21 ms');
  assert.equal(s.detail, 'Gateway vps.example.com');
  assert.equal(s.icon, 'connected');
  assert.equal(s.tooltip, 'LocalTunnel — Connected · 21 ms');
  assert.equal(s.canStop, true);
  assert.equal(s.canStart, false);
  assert.deepEqual(s.services, [
    {
      id: 's1',
      name: 'Blog',
      url: 'https://blog.example.com',
      target: '127.0.0.1:3000',
      reachable: null,
    },
  ]);
  assert.equal(s.primaryUrl, 'https://blog.example.com');
});

test('latency is left off until the tunnel has measured one', () => {
  assert.equal(summarize(status({ latencyMs: null })).stateLabel, 'Connected');
});

test('reconnecting counts down when the agent says how long', () => {
  assert.equal(
    summarize(status({ state: 'reconnecting', retryInSeconds: 4 })).stateLabel,
    'Reconnecting in 4s',
  );
  assert.equal(
    summarize(status({ state: 'reconnecting', retryInSeconds: 0 })).stateLabel,
    'Reconnecting…',
  );
  assert.equal(
    summarize(status({ state: 'reconnecting', retryInSeconds: null })).stateLabel,
    'Reconnecting…',
  );
  // Trying to connect is still "running", and offers Stop rather than Start.
  const s = summarize(status({ state: 'reconnecting', retryInSeconds: 4 }));
  assert.equal(s.running, true);
  assert.equal(s.canStop, true);
  assert.equal(s.canStart, false);
  assert.equal(s.icon, 'idle');
});

test('a failure shows the reason rather than the gateway', () => {
  const s = summarize(status({ state: 'error', lastError: 'connect ECONNREFUSED' }));
  assert.equal(s.stateLabel, 'Disconnected');
  assert.equal(s.detail, 'connect ECONNREFUSED');
  assert.equal(s.canStart, true);
});

test('a revoked machine cannot be started or stopped from the menu', () => {
  const s = summarize(status({ state: 'revoked', lastError: 'certificate revoked' }));
  assert.equal(s.stateLabel, 'This computer was revoked');
  assert.equal(s.detail, 'certificate revoked');
  assert.equal(s.canStart, false);
  assert.equal(s.canStop, false);
});

test('an idle agent offers Start', () => {
  const s = summarize(status({ state: 'idle', latencyMs: null }));
  assert.equal(s.running, false);
  assert.equal(s.canStart, true);
  assert.equal(s.canStop, false);
});

test('a service the gateway has not published has no URL to copy or open', () => {
  const s = summarize(status({ services: [{ ...httpService, hostname: null }] }));
  assert.equal(s.services[0].url, null);
  assert.equal(s.primaryUrl, null);
});

test('Copy Public URL takes the first service that actually has one', () => {
  const s = summarize(
    status({
      services: [
        { ...httpService, id: 's0', name: 'Pending', hostname: null },
        { ...httpService, id: 's1', hostname: 'blog.example.com' },
      ],
    }),
  );
  assert.equal(s.primaryUrl, 'https://blog.example.com');
});

test('a failed probe is carried through so the menu can say so', () => {
  const s = summarize(
    status({ services: [httpService], probes: { s1: { reachable: false, error: 'ECONNREFUSED' } } }),
  );
  assert.equal(s.services[0].reachable, false);
});

test('raw services are addressed by gateway host and public port', () => {
  assert.equal(
    serviceUrl({ type: 'tcp', publicPort: 25565 }, 'vps.example.com'),
    'tcp://vps.example.com:25565',
  );
  assert.equal(serviceUrl({ type: 'udp', publicPort: 51820 }, 'vps.example.com'), 'udp://vps.example.com:51820');
  // No port assigned yet, so there is nothing a visitor could connect to.
  assert.equal(serviceUrl({ type: 'tcp', publicPort: null }, 'vps.example.com'), null);
  // The host is unknown before enrolment; say so rather than printing "null".
  assert.equal(serviceUrl({ type: 'tcp', publicPort: 25565 }, null), 'tcp://your-gateway:25565');
  assert.equal(serviceUrl({ type: 'https', hostname: 'a.example.com' }, null), 'https://a.example.com');
});

test('the local target is host:port', () => {
  assert.equal(serviceTarget({ localHost: '192.168.1.50', localPort: 8080 }), '192.168.1.50:8080');
});

test('the menu bar is claimed only on macOS', () => {
  assert.equal(menuBarSupported(), process.platform === 'darwin');
});
