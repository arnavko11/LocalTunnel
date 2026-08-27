# LocalTunnel Architecture

LocalTunnel makes a service running on a home computer reachable from the public
internet, even when the home connection is behind CGNAT and cannot accept inbound
connections.

It does this with one deliberately boring idea: **the user rents a small public VPS,
and the home computer dials out to it.** All public traffic flows through the VPS.

## 1. Traffic path

```
Visitor                     mysite.example.com
   │ HTTPS
   ▼
┌──────────────────────────────────────────┐
│ PUBLIC VPS — LocalTunnel Gateway         │
│  :443  TLS ingress (ACME certificates)   │
│  :80   ACME http-01 + redirect to HTTPS  │
│  :N    optional raw TCP service ports    │
└───────────────────┬──────────────────────┘
                    │  one persistent, multiplexed,
                    │  mutually-authenticated TLS
                    │  connection, dialled OUTBOUND
                    │  by the home machine
                    ▼
┌──────────────────────────────────────────┐
│ HOME COMPUTER — LocalTunnel Agent        │
└───────────────────┬──────────────────────┘
                    ▼
        localhost:3000 / 192.168.1.50:8080
```

There is no return path into the home network. The gateway can only ever send bytes
down a connection the agent already opened, into a `host:port` the user explicitly
configured.

## 2. Things this design deliberately does not do

| Not used | Why |
| --- | --- |
| P2P / hole punching | Fails unpredictably behind CGNAT; makes debugging a lottery. |
| Mesh VPN, WireGuard mesh, Tailscale, Headscale | LocalTunnel is public ingress, not a private overlay network. |
| Cloudflare Tunnel / Workers / proxying | The user's own VPS is the ingress. Cloudflare may be used *only* as an optional DNS provider. |
| Direct peer optimisation | One path means one thing to troubleshoot. |

Every byte of public traffic follows `Internet → VPS → tunnel → agent → local service`.

## 3. Components

```
/
├── packages/protocol/   shared wire protocol: framing, stream multiplexer, control messages
├── packages/gateway/    runs on the VPS
│   ├── ingress/         TLS listener, ALPN demux, HTTP reverse proxy, TCP forwarder
│   ├── tunnels/         agent connection registry, stream dialling, health
│   ├── routing/         hostname → service, public port → service
│   ├── tls/             ACME (Let's Encrypt) + gateway identity certificate
│   ├── auth/            internal CA, machine enrolment, mTLS verification, revocation
│   ├── admin/           token-authenticated JSON API used by the desktop app
│   └── main/            process entrypoint, config, state store
├── packages/agent/      runs on the user's computer
│   ├── tunnel/          outbound connection, reconnect backoff, keepalive
│   ├── service_proxy/   dials the local service, pipes bytes
│   ├── auth/            keypair, CSR, enrolment, credential storage
│   └── main/            supervisor + local IPC for the desktop app
├── packages/desktop/    Electron app (macOS / Windows / Linux)
│   ├── ui/              React renderer — Home, Services, Machines, Gateways, Domains, Diagnostics, Settings
│   ├── main/            Electron main process, and the macOS menu bar status item
│   ├── services/        gateway admin client, agent supervisor, config store
│   ├── setup/           first-run flow, SSH-based gateway installer
│   ├── providers/       Oracle Cloud 12-step wizard, other provider guides, DNS guides
│   └── diagnostics/     the diagnostics engine
├── installer/           install.sh + systemd unit deployed to the VPS
└── docs/
```

## 4. One public port

The gateway needs as few open ports as possible. Everything the *product* needs runs
on **TCP 443**, demultiplexed by TLS ALPN:

| ALPN | Meaning |
| --- | --- |
| `lt-enroll/1` | A new machine presenting an enrolment token and a CSR. |
| `lt-tunnel/1` | An enrolled agent's persistent multiplexed tunnel (mutual TLS). |
| `lt-admin/1` | The desktop app's management API (bearer token, pinned certificate). |
| `h2`, `http/1.1`, anything else | Ordinary public web traffic, routed by SNI/Host. |

`TCP 80` is additionally opened because ACME's http-01 challenge requires it and
because visitors type bare `http://`.

Raw TCP services (a Minecraft server on 25565, say) need their own public port by
definition — the client speaks Minecraft, not TLS-with-our-ALPN. The gateway opens
and closes those ports itself, including the host firewall rule, when a service is
published or removed. The user never edits a firewall by hand after install.

## 5. How a request is served

1. Visitor opens `https://mysite.example.com`.
2. TLS handshake terminates on the gateway. `SNICallback` looks up the ACME
   certificate for that hostname; ALPN is `h2`/`http/1.1`, so the connection is handed
   to the HTTP reverse proxy.
3. The router maps the `Host` header to a service, and the service to the machine that
   owns it.
4. The tunnel registry finds that machine's live connection and opens a **new
   multiplexed stream** on it.
5. The proxy issues the request over that stream as if it were an ordinary socket
   (`http.request` with a custom agent whose `createConnection` returns the stream),
   adding `X-Forwarded-For`/`-Proto`/`-Host`. WebSocket upgrades are passed through
   as raw bytes.
6. The agent receives the stream open, dials `127.0.0.1:3000`, and pipes both ways.
7. Bytes flow back up the same stream to the visitor.

If the machine is offline the gateway answers `502` with a human-readable page
explaining which machine is disconnected — not a bare nginx error.

## 6. State

The gateway owns its state in `/var/lib/localtunnel/state.json` (machines, services,
domains, counters). This is deliberate: **the gateway keeps working with no contact
to any LocalTunnel cloud account.** The desktop app is a client of the gateway's admin
API, not a source of truth, so a laptop that is wiped or replaced never takes the
user's public website down with it. Accounts (`packages/desktop/src/services/account`)
are a local profile that groups gateways, machines and services for display, and can
optionally be synced later; nothing on the traffic path consults it.

## 7. Failure behaviour

| Failure | Behaviour |
| --- | --- |
| Home internet drops | Agent reconnects with exponential backoff (1s → 2s → 4s … capped at 30s, jittered). Gateway serves 502 with the reason meanwhile. |
| Laptop sleeps | Keepalive misses are detected in ≤45s; on wake the agent notices its socket is dead and reconnects immediately. |
| Gateway restarts | State is reloaded from disk; agents reconnect; certificates are read from the ACME cache, not re-issued. |
| Local service crashes | The stream is refused; the gateway returns 502 and diagnostics reports "local service not listening". |
| Machine revoked | Its certificate serial goes on the revocation list; the live tunnel is closed immediately and re-handshakes are rejected. |

## 8. Related documents

- [PROTOCOL.md](PROTOCOL.md) — the wire format and control messages.
- [SECURITY.md](SECURITY.md) — identity, trust boundaries, hardening.
- [SETUP.md](SETUP.md) — how a user actually gets from zero to a public HTTPS site.
