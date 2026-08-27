# LocalTunnel

Put a website running on your home computer onto the public internet — even when your
ISP uses CGNAT and you cannot forward ports.

```
Visitor  ──https──▶  Your VPS  ──encrypted tunnel──▶  Your computer  ──▶  localhost:3000
                     (public IP)      dialled outward       (behind CGNAT)
```

You rent one small VPS. LocalTunnel installs a gateway on it over SSH, your computer
dials out to that gateway and keeps the connection open, and your domain points at the
VPS. No port forwarding, no reverse proxy to configure, no certificates to manage.



## What works today

- **Guided Oracle Cloud setup** — twelve steps, each with instructions, "why do I need
  this?", "what should I see?" and troubleshooting.
- **Any other VPS** — DigitalOcean, Vultr, Hetzner, Linode, AWS, GCP, Azure, or a box
  you already own.
- **One-click gateway install over SSH** — fourteen verified steps, live output, no
  terminal.
- **Automatic HTTPS** via Let's Encrypt, renewed automatically.
- **HTTP reverse proxy** with WebSocket support, and **raw TCP/UDP forwarding** for
  things like Minecraft or SSH.
- **Multiple machines and multiple gateways**, each machine with its own revocable
  certificate.
- **Temporary public links** for dev servers and webhooks.
- **A diagnostics engine** that names the broken link and the fix, rather than saying
  "something went wrong".

## Repository layout

```
packages/protocol/   wire format + stream multiplexer (shared)
packages/gateway/    runs on the VPS — ingress, tunnels, routing, TLS, auth, admin API
packages/agent/      runs on your computer — outbound tunnel, local service proxy
packages/desktop/    Electron + React app for macOS, Windows and Linux
packages/cli/        `localtunnel` — the terminal client, for headless Linux boxes
installer/           install.sh + a sandboxed systemd unit
scripts/             build tooling + install-cli.sh, the one-line Linux installer
```

## Build and run from source

```bash
npm install
npm run build          # protocol, gateway, agent
npm run desktop        # build and launch the desktop app
```

Package the gateway payload the desktop app uploads to a VPS:

```bash
./scripts/bundle-gateway.sh
```

## The macOS menu bar

On macOS the app also puts a status item in the menu bar. Clicking it opens a native
menu showing whether a tunnel is up, the gateway it is connected to, and for each
published service its public URL and the local address it points at — with Copy
Public URL, Start/Stop Tunnel, and Quit.

Run it as a menu bar accessory, with no Dock tile and no window:

```bash
npm run desktop:menubar
# or, equivalently, once built:
LOCALTUNNEL_MENU_BAR=1 npm run desktop
```

`npm run desktop` still opens the normal window; on macOS it gains the same status
item alongside it, so nothing about the existing app changes. The flag is ignored on
Linux and Windows, which have no menu bar to live in, and the whole component is
compiled out of their code path by a `process.platform` check.

The icon is a *template* image — black artwork plus an alpha channel — so macOS tints
it for a light or dark menu bar and inverts it again while the menu is open. Redraw
the two states (idle and connected) with:

```bash
npm run icons:tray
```

## The terminal client

For a headless Linux box — a home server, a Pi, anything you only reach over SSH —
`localtunnel` does everything the desktop app does, gateway installation included.
It is a full-screen menu driven with the arrow keys: no flags to memorise, no config
file to write by hand.

Install it on that machine with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/arnavko11/LocalTunnel/main/scripts/install-cli.sh | sh
```

[`scripts/install-cli.sh`](scripts/install-cli.sh) clones the repository, builds it,
packs the gateway bundle the SSH flow uploads, and puts `localtunnel` on your PATH —
`~/.local/bin` for a normal user, `/usr/local/bin` under `sudo`. Node 20+ is needed;
where the machine has an older one or none, it downloads a private copy into the
install directory and checks it against nodejs.org's `SHASUMS256.txt`, rather than
changing what the rest of the system uses. The desktop app's Electron is skipped, so
a bare server does not pull down a GUI toolkit it has no display for.

Run it again to update, and `--uninstall` to remove it; `--help` lists the rest
(`--dir`, `--bin-dir`, `--ref`, `--repo`, `--no-bundle`).

From a checkout you already have:

```bash
npm install && npm run build
npm link -w @localtunnel/cli   # puts `localtunnel` on your PATH
localtunnel                    # opens the menu
```

Or without linking: `npm run cli`.

```
↑↓ move   enter select   esc back   q quit
```

**Gateways → Add a gateway → Sign in over SSH** is the same flow as the desktop app:
you give it the server address, SSH username and port, and pick a key — the private
keys in `~/.ssh` are listed by name with their type, comment and whether they need a
passphrase, and a key anywhere else can be given by path. The default is to let
`ssh` decide, since an agent or a `Host` entry usually has it covered. Everything
runs through your own `ssh`, so `~/.ssh/config` and `known_hosts` apply as usual.

- **No gateway on that server yet:** it uploads the gateway and runs the installer,
  the same fourteen steps the desktop app runs, then keeps the admin token and
  certificate fingerprint it produced.
- **A gateway is already there:** it takes it over. The server stores only a hash of
  the admin token, so an existing one cannot be read back — a new one is generated on
  the server instead. That invalidates the old token, so the desktop app would need
  the new one; it is shown once at the end.

Nothing has to be copied by hand. Entering the four details manually is still there
as a fallback, along with importing a gateway from the desktop app on the same Linux
machine.

To copy the details instead — to set up a second computer, or to keep the admin token
in a password manager — the desktop app has them under **Gateways → Connection
details**, with the token behind a **Reveal** button. That is the only way to see an
existing token again: the gateway itself stores nothing but a SHA-256 hash of it, and
on macOS and Windows the app's copy is sealed in the OS keychain.

From then on the menu covers connecting this computer, publishing services, machines,
certificates and diagnostics.

A handful of subcommands exist for scripts and service units, where a menu would be
in the way:

```bash
localtunnel status      # what is up right now (add --json for machine-readable)
localtunnel services    # list published services
localtunnel up          # start the agent in the background and connect
localtunnel down        # pause the tunnel, leave the agent running
localtunnel stop        # stop the agent entirely
localtunnel agent       # run the agent in the foreground, for systemd
```

"Start the agent at login" in the menu installs a systemd **user** service — no root,
and the agent can only reach what your own user can. On a box you never log into
graphically, keep it running between sessions with
`sudo loginctl enable-linger $USER`.

## Installers

```bash
npm run dist:mac -w @localtunnel/desktop -- --universal   # LocalTunnel-1.0.0-universal.dmg
npm run dist:linux -w @localtunnel/desktop -- --x64 --arm64  # AppImages + .deb
npm run dist:win -w @localtunnel/desktop
```

They land in `packages/desktop/release/`. Each one carries the gateway payload and
`install.sh`, which is what lets the app install a gateway over SSH.

| File | For |
| --- | --- |
| `LocalTunnel-<version>-universal.dmg` | macOS, Intel and Apple Silicon in one |
| `LocalTunnel-<version>-x86_64.AppImage` | Any Linux desktop — `chmod +x` and run |
| `LocalTunnel-<version>-arm64.AppImage` | Linux on arm64, e.g. a Pi desktop |
| `localtunnel-desktop_<version>_amd64.deb` | Debian, Ubuntu, Lubuntu, Mint — installs to `/opt` with a menu entry |
| `localtunnel-desktop_<version>_arm64.deb` | The same, on arm64 |

`dist:linux` builds the AppImages with electron-builder, then the `.deb`s with
[`scripts/make-deb.mjs`](scripts/make-deb.mjs) — this repo packages those itself
because electron-builder shells out to `fpm`, which on macOS emits a corrupt archive
(macOS `ar` writes a BSD symbol table where a Debian package wants plain members).
Doing it here means a release can be cut from any machine. `npm run deb` repackages
them alone from whatever is already unpacked in `release/`.

**AppImages need the executable bit.** Every download drops it, as does any copy via
macOS or a FAT drive, and a file manager then refuses to open the file — Lubuntu says
"file type not supported". `chmod +x` fixes that, and Ubuntu 22.04 and newer also
need `sudo apt install libfuse2`. The `.deb` avoids both.

**macOS builds here are unsigned.** Shipping a dmg that opens without a Gatekeeper
warning needs a *Developer ID Application* certificate from the Apple Developer
Program — an "Apple Development" certificate is not enough. Until then, opening it
takes a right-click → Open the first time. Add the certificate to the login keychain
and drop `CSC_IDENTITY_AUTO_DISCOVERY=false` to sign.

## Tests

```bash
npm test
```

This runs the protocol unit tests and the integration suite. The integration tests
start a **real gateway and a real agent** over real TLS, enrol the agent with a real
certificate, publish a local web server, and fetch it back over public HTTPS — plus
reconnection, revocation, TCP forwarding, oversized payloads, and the failure cases
(local service down, wrong hostname, spent enrolment token, wrong fingerprint).

## Documentation

| Document | Contents |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the pieces fit together and why the VPS is mandatory. |
| [PROTOCOL.md](PROTOCOL.md) | The wire format, control messages and enrolment exchange. |
| [SECURITY.md](SECURITY.md) | Identity, trust boundaries, hardening, limits. |
| [SETUP.md](SETUP.md) | The user-facing walkthrough, from zero to a public HTTPS site. |
| [packages/gateway/src/admin/README.md](packages/gateway/src/admin/README.md) | The gateway's management API. |

## Requirements

- **Desktop:** macOS 11+, Windows 10+, or a Linux desktop. Node 20+ to build.
- **VPS:** Ubuntu, Debian, Rocky, Alma or Fedora, a public IPv4, SSH access, and
  inbound TCP 443 and 80 allowed by your provider's firewall.
- **A domain name** if you want a permanent custom address. Temporary links do not
  need one.

## Licence

MIT.
