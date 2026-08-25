#!/usr/bin/env node
/**
 * Draws the LocalTunnel app icon and writes the platform bundles.
 *
 * The mark is a tunnel mouth seen head-on — two nested arches receding, with the
 * light at the far end — which is literally what the product does: your traffic
 * enters here and comes out on the public internet.
 *
 * It is drawn from signed distance fields rather than an SVG because nothing on
 * this machine can rasterise SVG (no rsvg, no ImageMagick, no Inkscape), and the
 * shape is simple enough that the maths is shorter than the dependency. Every
 * pixel is supersampled 4×4, so the curves are properly anti-aliased.
 *
 * Output lands in packages/desktop/assets/icons, which is checked in — build/
 * is ignored, and the icon is a source asset rather than a build product. The
 * macOS .icns, the Windows .ico and the per-size PNGs Linux needs all come from
 * the same drawing.
 *
 * Usage: node scripts/make-icon.mjs
 */

import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'packages', 'desktop', 'assets', 'icons');

/* ----------------------------------------------------------------- palette */

const BG_TOP = [0x14, 0x14, 0x16];
const BG_BOTTOM = [0x00, 0x00, 0x00];
const ACCENT = [0x5c, 0x93, 0xff];
const ACCENT_DEEP = [0x36, 0x5f, 0xc4];
const LIGHT = [0xfa, 0xfa, 0xfa];

/* -------------------------------------------------------- distance fields */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Distance from p to a line segment a→b. */
function segment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const t = clamp((wx * vx + wy * vy) / (vx * vx + vy * vy), 0, 1);
  return Math.hypot(wx - t * vx, wy - t * vy);
}

/** Rounded rectangle centred on the origin, half-extents hx/hy, corner r. */
function roundedRect(px, py, hx, hy, r) {
  const dx = Math.abs(px) - (hx - r);
  const dy = Math.abs(py) - (hy - r);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(ox, oy) - r;
}

/**
 * An arch: a semicircular top of radius r centred at (0, cy), carried down by
 * two straight legs to `baseY`. Returns the distance to that centreline, so a
 * stroke is just |d| - halfWidth.
 */
function arch(px, py, r, cy, baseY) {
  if (py <= cy) return Math.abs(Math.hypot(px, py - cy) - r);
  return Math.min(
    segment(px, py, -r, cy, -r, baseY),
    segment(px, py, r, cy, r, baseY),
  );
}

/* -------------------------------------------------------------- rendering */

/** Coverage of a shape at one sample, given its signed distance and a softness. */
const cover = (d, aa) => clamp(0.5 - d / aa, 0, 1);

function shade(x, y) {
  // Everything below is in a -1…1 square, independent of output size.
  const baseY = 0.62;
  const cy = -0.06;
  const aa = 0.006;

  // Backdrop: a rounded square with a soft vertical lift, so the icon has some
  // depth on both light and dark desktops.
  const bg = roundedRect(x, y, 0.94, 0.94, 0.42);
  const bgA = cover(bg, aa);
  if (bgA <= 0) return [0, 0, 0, 0];

  const t = clamp((y + 1) / 2, 0, 1);
  let r = BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t;
  let g = BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t;
  let b = BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t;

  const over = (colour, alpha) => {
    if (alpha <= 0) return;
    r += (colour[0] - r) * alpha;
    g += (colour[1] - g) * alpha;
    b += (colour[2] - b) * alpha;
  };

  // Outer arch — the mouth of the tunnel.
  over(ACCENT, cover(arch(x, y, 0.60, cy, baseY) - 0.075, aa));
  // The floor the mouth stands on. Without it the arches read as a rainbow;
  // with it the eye takes the whole thing as an opening you look into.
  over(ACCENT, cover(segment(x, y, -0.60, baseY, 0.60, baseY) - 0.075, aa));
  // Inner arch — the same shape further in. Dimmer, and stopping short of the
  // floor, so the two rings read as depth rather than as concentric stripes.
  over(ACCENT_DEEP, cover(arch(x, y, 0.33, cy + 0.09, baseY - 0.07) - 0.055, aa));
  // The light at the end.
  over(LIGHT, cover(Math.hypot(x, y - cy + 0.02) - 0.10, aa));

  return [r, g, b, bgA * 255];
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const samples = 4;
  for (let iy = 0; iy < size; iy++) {
    for (let ix = 0; ix < size; ix++) {
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let aa = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = ((ix + (sx + 0.5) / samples) / size) * 2 - 1;
          const y = ((iy + (sy + 0.5) / samples) / size) * 2 - 1;
          const [r, g, b, a] = shade(x, y);
          ar += r * a;
          ag += g * a;
          ab += b * a;
          aa += a;
        }
      }
      const n = samples * samples;
      const o = (iy * size + ix) * 4;
      // Un-premultiply so the edge pixels keep their colour at low alpha.
      px[o] = aa > 0 ? Math.round(clamp(ar / aa, 0, 255)) : 0;
      px[o + 1] = aa > 0 ? Math.round(clamp(ag / aa, 0, 255)) : 0;
      px[o + 2] = aa > 0 ? Math.round(clamp(ab / aa, 0, 255)) : 0;
      px[o + 3] = Math.round(clamp(aa / n, 0, 255));
    }
  }
  return px;
}

/* ------------------------------------------------------------- PNG writer */

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // Each scanline is prefixed with its filter type; 0 (none) keeps this simple
  // and still compresses well for flat artwork.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Windows .ico, with each size stored as a PNG (Vista and later). */
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const dir = [];
  for (const { size, data } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[4] = 1;
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    dir.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.data)]);
}

/* ----------------------------------------------------------------- output */

mkdirSync(outDir, { recursive: true });

const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];
const rendered = new Map();
for (const size of sizes) {
  process.stdout.write(`  drawing ${size}×${size}\n`);
  rendered.set(size, png(size, render(size)));
}

writeFileSync(join(outDir, 'icon.png'), rendered.get(1024));
writeFileSync(
  join(outDir, 'icon.ico'),
  ico([16, 32, 48, 64, 128, 256].map((size) => ({ size, data: rendered.get(size) }))),
);

// Linux has no single-file icon container: electron-builder wants a directory of
// `<size>x<size>.png`, and a .deb installs the same sizes under hicolor. Write
// them all out so both get a properly-drawn icon at every size rather than a
// downscale of the 1024.
const pngDir = join(outDir, 'png');
mkdirSync(pngDir, { recursive: true });
for (const size of sizes) writeFileSync(join(pngDir, `${size}x${size}.png`), rendered.get(size));

// macOS wants an .iconset directory, which iconutil turns into an .icns.
const iconset = join(outDir, 'icon.iconset');
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset);
const icns = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
];
for (const [size, name] of icns) writeFileSync(join(iconset, name), rendered.get(size));

if (process.platform === 'darwin') {
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(outDir, 'icon.icns')]);
  rmSync(iconset, { recursive: true, force: true });
  console.log('wrote icon.png, icon.ico, icon.icns and png/ (Linux)');
} else {
  console.log('wrote icon.png, icon.ico, png/ (Linux) and icon.iconset (run iconutil on macOS for .icns)');
}
