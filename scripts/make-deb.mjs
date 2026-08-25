#!/usr/bin/env node
/**
 * Builds the Debian packages from an electron-builder unpacked directory.
 *
 * electron-builder shells out to fpm for this, and fpm on macOS produces a
 * corrupt archive — macOS `ar` writes a BSD symbol table where a Debian package
 * wants plain members — so a .deb could only be built on Linux. A .deb is an ar
 * archive of three members holding two tarballs, which is little enough that
 * writing it here is cheaper than requiring a Linux box or a container.
 *
 * Usage: node scripts/make-deb.mjs            # every arch that has been packed
 *        node scripts/make-deb.mjs amd64      # just one
 */

import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'packages', 'desktop');
const releaseDir = join(desktop, 'release');
const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));

const PACKAGE = 'localtunnel-desktop';
const INSTALL_DIR = `/opt/${pkg.build.productName}`;
const LAUNCHER = pkg.build.linux.executableName;

/*
 * Icon sizes installed under hicolor. These are the sizes the icon theme spec
 * lists, and the ones desktops actually look in — a lone 1024x1024 is outside
 * that set, so a menu asking for 48px would find nothing and fall back to a
 * generic icon. scripts/make-icon.mjs draws each one; they are not downscales.
 */
const ICON_SIZES = [16, 32, 48, 64, 128, 256, 512];

/** Everything Electron needs at runtime on a Debian-family system. */
const DEPENDS = [
  'libgtk-3-0',
  'libnotify4',
  'libnss3',
  'libxss1',
  'libxtst6',
  'xdg-utils',
  'libatspi2.0-0',
  'libuuid1',
  'libsecret-1-0',
];

const ARCHES = [
  { deb: 'amd64', dir: join(releaseDir, 'linux-unpacked') },
  { deb: 'arm64', dir: join(releaseDir, 'linux-arm64-unpacked') },
];

/* --------------------------------------------------------------------- tar */

/**
 * A ustar writer.
 *
 * Paths longer than 100 characters go in the header's prefix field, which is
 * what ustar is for — Electron's locale and resource paths get close enough to
 * that limit to matter.
 */
class Tar {
  constructor() {
    this.chunks = [];
  }

  #header({ path, mode, size, type, linkname = '', mtime }) {
    let name = path;
    let prefix = '';
    if (Buffer.byteLength(name) > 100) {
      // ustar splits a long path at a slash: up to 155 bytes of leading
      // directories in `prefix`, up to 100 in `name`. Take the last slash that
      // leaves a short enough tail.
      let cut = -1;
      for (let i = 0; i < name.length; i += 1) {
        if (name[i] !== '/') continue;
        if (Buffer.byteLength(name.slice(0, i)) > 155) break;
        if (Buffer.byteLength(name.slice(i + 1)) <= 100) {
          cut = i;
          break;
        }
      }
      if (cut === -1) throw new Error(`path too long for ustar: ${path}`);
      prefix = name.slice(0, cut);
      name = name.slice(cut + 1);
    }

    const block = Buffer.alloc(512);
    const put = (value, offset, length) => block.write(value, offset, length, 'utf8');
    const octal = (value, offset, length) =>
      block.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'utf8');

    put(name, 0, 100);
    octal(mode, 100, 8);
    octal(0, 108, 8); // uid — root owns everything in the package
    octal(0, 116, 8); // gid
    octal(size, 124, 12);
    octal(mtime, 136, 12);
    block.write('        ', 148, 8, 'utf8'); // checksum placeholder
    put(type, 156, 1);
    put(linkname, 157, 100);
    put('ustar\0', 257, 6);
    put('00', 263, 2);
    put('root', 265, 32);
    put('root', 297, 32);
    put(prefix, 345, 155);

    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
    return block;
  }

  add(path, body, { mode = 0o644, mtime = 0 } = {}) {
    this.chunks.push(this.#header({ path, mode, size: body.length, type: '0', mtime }));
    this.chunks.push(body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding) this.chunks.push(Buffer.alloc(padding));
  }

  addDirectory(path, { mode = 0o755, mtime = 0 } = {}) {
    this.chunks.push(this.#header({ path: path.endsWith('/') ? path : `${path}/`, mode, size: 0, type: '5', mtime }));
  }

  addSymlink(path, target, { mtime = 0 } = {}) {
    this.chunks.push(this.#header({ path, mode: 0o777, size: 0, type: '2', linkname: target, mtime }));
  }

  end() {
    // Two zero blocks close the archive, then it is padded to a 10 KiB boundary.
    const body = Buffer.concat([...this.chunks, Buffer.alloc(1024)]);
    const padding = (10240 - (body.length % 10240)) % 10240;
    return Buffer.concat([body, Buffer.alloc(padding)]);
  }
}

/* ---------------------------------------------------------------------- ar */

/** The archive format a .deb actually is — plain members, no symbol table. */
function ar(members) {
  const out = [Buffer.from('!<arch>\n', 'ascii')];
  for (const { name, body } of members) {
    const header = Buffer.alloc(60, 0x20);
    header.write(name, 0, 16, 'ascii');
    header.write('0', 16, 12, 'ascii'); // mtime
    header.write('0', 28, 6, 'ascii'); // uid
    header.write('0', 34, 6, 'ascii'); // gid
    header.write('100644', 40, 8, 'ascii');
    header.write(String(body.length), 48, 10, 'ascii');
    header.write('`\n', 58, 2, 'ascii');
    out.push(header, body);
    if (body.length % 2 === 1) out.push(Buffer.from('\n', 'ascii'));
  }
  return Buffer.concat(out);
}

/* ------------------------------------------------------------------ pieces */

function walk(dir, base = dir) {
  const entries = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    const rel = relative(base, path);
    if (stat.isDirectory()) {
      entries.push({ rel, kind: 'dir', mode: stat.mode & 0o7777 });
      entries.push(...walk(path, base));
    } else if (stat.isSymbolicLink()) {
      entries.push({ rel, kind: 'link', target: readlinkSync(path) });
    } else {
      entries.push({ rel, kind: 'file', mode: stat.mode & 0o7777, path, size: stat.size });
    }
  }
  return entries;
}

/*
 * `--class` is passed rather than left to Chromium, which would derive the
 * window's WM_CLASS from the executable name — `Localtunnel-desktop`, not the
 * product name. Naming it here makes StartupWMClass below match for certain,
 * which is what lets a shell put this icon on the running window instead of a
 * generic one.
 */
const DESKTOP_ENTRY = `[Desktop Entry]
Name=${pkg.build.productName}
Comment=${pkg.description}
Exec=${LAUNCHER} --class=${pkg.build.productName} %U
Terminal=false
Type=Application
Icon=${PACKAGE}
StartupWMClass=${pkg.build.productName}
Categories=${pkg.build.linux.category};
`;

// chrome-sandbox must be setuid root or Electron refuses to start on a stock
// kernel; dpkg cannot express that, so it is done here as fpm would.
const POSTINST = `#!/bin/sh
set -e
chmod 4755 '${INSTALL_DIR}/chrome-sandbox' || true
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q /usr/share/icons/hicolor || true
fi
exit 0
`;

const POSTRM = `#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q || true
fi
exit 0
`;

function build({ deb, dir }) {
  if (!existsSync(dir)) return null;

  const entries = walk(dir);
  const data = new Tar();
  const md5s = [];
  let installedBytes = 0;

  for (const parent of ['./opt', `.${INSTALL_DIR}`, './usr', './usr/bin', './usr/share', './usr/share/applications']) {
    data.addDirectory(parent);
  }
  data.addDirectory('./usr/share/icons');
  data.addDirectory('./usr/share/icons/hicolor');
  for (const size of ICON_SIZES) {
    data.addDirectory(`./usr/share/icons/hicolor/${size}x${size}`);
    data.addDirectory(`./usr/share/icons/hicolor/${size}x${size}/apps`);
  }

  for (const entry of entries) {
    const path = `.${INSTALL_DIR}/${entry.rel}`;
    if (entry.kind === 'dir') {
      data.addDirectory(path, { mode: entry.mode });
    } else if (entry.kind === 'link') {
      data.addSymlink(path, entry.target);
    } else {
      const body = readFileSync(entry.path);
      data.add(path, body, { mode: entry.mode });
      md5s.push(`${createHash('md5').update(body).digest('hex')}  ${path.slice(2)}`);
      installedBytes += body.length;
    }
  }

  // The launcher on PATH, plus the menu entry and its icon.
  data.addSymlink(`./usr/bin/${LAUNCHER}`, `${INSTALL_DIR}/${LAUNCHER}`);
  const desktopEntry = Buffer.from(DESKTOP_ENTRY, 'utf8');
  data.add(`./usr/share/applications/${PACKAGE}.desktop`, desktopEntry);
  md5s.push(`${createHash('md5').update(desktopEntry).digest('hex')}  usr/share/applications/${PACKAGE}.desktop`);
  for (const size of ICON_SIZES) {
    const icon = readFileSync(join(desktop, 'assets', 'icons', 'png', `${size}x${size}.png`));
    const path = `usr/share/icons/hicolor/${size}x${size}/apps/${PACKAGE}.png`;
    data.add(`./${path}`, icon);
    md5s.push(`${createHash('md5').update(icon).digest('hex')}  ${path}`);
    installedBytes += icon.length;
  }

  const control = [
    `Package: ${PACKAGE}`,
    `Version: ${pkg.version}`,
    `Architecture: ${deb}`,
    `Maintainer: ${pkg.author.name} <${pkg.author.email}>`,
    `Installed-Size: ${Math.ceil(installedBytes / 1024)}`,
    `Depends: ${DEPENDS.join(', ')}`,
    'Section: net',
    'Priority: optional',
    `Homepage: ${pkg.homepage}`,
    `Description: ${pkg.build.productName} — public HTTPS for services on your own computer`,
    ...pkg.description.match(/.{1,72}(\s|$)/g).map((line) => ` ${line.trim()}`),
    '',
  ].join('\n');

  const controlTar = new Tar();
  controlTar.add('./control', Buffer.from(control, 'utf8'));
  controlTar.add('./md5sums', Buffer.from(`${md5s.join('\n')}\n`, 'utf8'));
  controlTar.add('./postinst', Buffer.from(POSTINST, 'utf8'), { mode: 0o755 });
  controlTar.add('./postrm', Buffer.from(POSTRM, 'utf8'), { mode: 0o755 });

  const archive = ar([
    { name: 'debian-binary', body: Buffer.from('2.0\n', 'ascii') },
    { name: 'control.tar.gz', body: gzipSync(controlTar.end(), { level: 9 }) },
    { name: 'data.tar.gz', body: gzipSync(data.end(), { level: 9 }) },
  ]);

  mkdirSync(releaseDir, { recursive: true });
  // Debian's own convention, `<package>_<version>_<arch>.deb`: lowercase, and the
  // shape every Debian tool and every user expects to see.
  const out = join(releaseDir, `${PACKAGE}_${pkg.version}_${deb}.deb`);
  writeFileSync(out, archive);
  return { out, size: archive.length, files: md5s.length };
}

// Only a bare arch name selects; stray flags from an npm invocation are ignored
// rather than silently producing nothing.
const asked = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const wanted = asked.length ? ARCHES.filter((a) => asked.includes(a.deb)) : ARCHES;
let built = 0;
for (const arch of wanted) {
  const result = build(arch);
  if (!result) {
    process.stdout.write(`==> skipping ${arch.deb}: ${arch.dir} has not been packed\n`);
    continue;
  }
  built += 1;
  process.stdout.write(
    `==> ${relative(root, result.out)} (${(result.size / 1024 / 1024).toFixed(1)} MB, ${result.files} files)\n`,
  );
}
if (built === 0) {
  process.stderr.write('Nothing to package. Run `npm run dist:linux -w @localtunnel/desktop` first.\n');
  process.exit(1);
}
