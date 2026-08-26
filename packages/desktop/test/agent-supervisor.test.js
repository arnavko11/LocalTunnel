/**
 * Starting the agent has to survive the two ways a second agent process stands
 * aside: the app asking twice at once, and an agent already holding the socket.
 * Neither is a failed start, and neither may be reported as one.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AgentSupervisor, defaultSocketPath } = require('../dist/services/agent-supervisor.js');

/** A stand-in for the agent: claims the socket, or exits 0 if someone else has it. */
const FAKE_AGENT = `
const http = require('node:http');
const fs = require('node:fs');
const socketPath = process.env.FAKE_AGENT_SOCKET;
const alive = () => new Promise((resolve) => {
  const req = http.request({ socketPath, path: '/alive', method: 'GET', timeout: 1000 }, (res) => {
    res.resume();
    resolve((res.statusCode ?? 500) < 500);
  });
  req.on('error', () => resolve(false));
  req.on('timeout', () => { req.destroy(); resolve(false); });
  req.end();
});
(async () => {
  if (fs.existsSync(socketPath)) {
    if (await alive()) {
      process.stdout.write('localtunnel-agent is already running; this instance will exit\\n');
      process.exit(0);
    }
    fs.unlinkSync(socketPath);
  }
  const server = http.createServer((req, res) => {
    // Only /alive is unauthenticated — /status demands the control secret the
    // real agent checks, and this one has none to match.
    if (req.url === '/alive') { res.writeHead(200); res.end('{"ok":true}'); return; }
    res.writeHead(401); res.end('{"error":"no control secret"}');
  });
  server.listen(socketPath);
})();
`;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-supervisor-'));
  const scriptPath = path.join(dir, 'fake-agent.js');
  fs.writeFileSync(scriptPath, FAKE_AGENT);
  const socketPath = path.join(dir, 'agent.sock');
  process.env.FAKE_AGENT_SOCKET = socketPath;
  const supervisor = new AgentSupervisor({ execPath: process.execPath, scriptPath, socketPath });
  t.after(async () => {
    supervisor.stopPolling();
    await supervisor.shutdown().catch(() => undefined);
    delete process.env.FAKE_AGENT_SOCKET;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { supervisor, scriptPath, socketPath };
}

test('overlapping starts share one attempt instead of racing each other', async (t) => {
  const { supervisor } = fixture(t);
  // The app does exactly this: startup kicks off a start, and the user clicks
  // Connect before it has finished. Two spawns means the second exits 0 saying
  // another agent is running — which used to surface as "the agent did not start".
  await Promise.all([supervisor.ensureRunning(), supervisor.ensureRunning(), supervisor.ensureRunning()]);
  assert.equal(await supervisor.ping(), true);
});

test('an agent that refuses our secret is still a running agent', async (t) => {
  const { supervisor, scriptPath, socketPath } = fixture(t);
  await supervisor.ensureRunning();
  supervisor.stopPolling();

  // A second supervisor over the same socket, as after the app restarts: /status
  // comes back 401 here, and treating that as "no agent" is what used to make the
  // app spawn a duplicate, which stood aside with exit code 0 and was reported as
  // an agent that did not start.
  const second = new AgentSupervisor({ execPath: process.execPath, scriptPath, socketPath });
  const exits = [];
  second.on('log', (line) => exits.push(line));
  assert.equal(await second.status(), null);
  await second.ensureRunning();
  second.stopPolling();
  assert.equal(await second.ping(), true);
  assert.deepEqual(exits, [], 'no second agent should have been spawned at all');
});

test('a genuinely broken agent still reports the failure and its output', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-supervisor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scriptPath = path.join(dir, 'broken-agent.js');
  fs.writeFileSync(scriptPath, 'process.stderr.write("EACCES: cannot read agent.key\\n"); process.exit(3);');
  const supervisor = new AgentSupervisor({
    execPath: process.execPath,
    scriptPath,
    socketPath: path.join(dir, 'agent.sock'),
  });
  await assert.rejects(supervisor.ensureRunning(), (err) => {
    assert.match(err.message, /did not start \(exit code 3\)/);
    assert.match(err.message, /EACCES: cannot read agent.key/);
    return true;
  });
});

test('the socket override applies to the app as well as the agent', () => {
  if (os.platform() === 'win32') return;
  const previous = process.env.LOCALTUNNEL_AGENT_SOCKET;
  try {
    delete process.env.LOCALTUNNEL_AGENT_SOCKET;
    assert.equal(defaultSocketPath('/data'), '/data/agent.sock');
    process.env.LOCALTUNNEL_AGENT_SOCKET = '/tmp/elsewhere.sock';
    assert.equal(defaultSocketPath('/data'), '/tmp/elsewhere.sock');
  } finally {
    if (previous === undefined) delete process.env.LOCALTUNNEL_AGENT_SOCKET;
    else process.env.LOCALTUNNEL_AGENT_SOCKET = previous;
  }
});
