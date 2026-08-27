#!/usr/bin/env node
/**
 * Draws the macOS menu bar (status item) icons.
 *
 * A status item icon is not the app icon shrunk down. macOS wants a *template*
 * image: pure black artwork whose alpha channel is the shape, which the system
 * then tints itself — dark on a light menu bar, light on a dark one, inverted
 * again while the menu is open. That is the whole of "supporting light and dark
 * mode" here, and it is why nothing below writes a colour.
 *
 * Two states are drawn from the same tunnel-mouth mark used by the app icon:
 *
 *   trayTemplate      outline only — no tunnel is up
 *   trayConnectedTemplate  the mouth lit — a tunnel is connected
 *
 * Each is written at 16px and at 32px (`@2x`) so Retina menu bars get the sharp
 * one; Electron pairs them by filename.
 *
 * Drawn from signed distance fields for the same reason as scripts/make-icon.mjs:
 * nothing here can rasterise an SVG, and the maths is shorter than a dependency.
 *
 * Usage: node scripts/make-tray-icon.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'packages', 'desktop', 'assets', 'icons', 'tray');

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function segment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const t = clamp((wx * vx + wy * vy) / (vx * vx + vy * vy), 0, 1);
  return Math.hypot(wx - t * vx, wy - t * vy);
}

/** Distance to the centreline of an arch: semicircle of radius r, legs to baseY. */
function arch(px, py, r, cy, baseY) {
  if (py <= cy) return Math.abs(Math.hypot(px, py - cy) - r);
  return Math.min(segment(px, py, -r, cy, -r, baseY), segment(px, py, r, cy, r, baseY));
}

/**
 * Signed distance to the *inside* of that arch, as a filled solid: the dome
 * above cy, the box below it. Taking the box everywhere would fill the corners
 * either side of the dome, which is why the two halves are kept apart.
 */
function archSolid(px, py, r, cy, baseY) {
  if (py <= cy) return Math.hypot(px, py - cy) - r;
  return Math.max(Math.abs(px) - r, py - baseY);
}

const cover = (d, aa) => clamp(0.5 - d / aa, 0, 1);

/**
 * Alpha of the mark at one sample point in a -1…1 square.
 *
 * The artwork is inset well inside that square: macOS menu bar icons are drawn
 * into an 18pt-tall slot with their own padding, and a mark that reaches the
 * edges reads as oversized next to the system's own items.
 */
function shade(x, y, { connected }) {
  const baseY = 0.52;
  const cy = -0.10;
  const aa = 0.09;
  let a = 0;
  const add = (v) => {
    a = a + v - a * v;
  };

  // The mouth of the tunnel, and the floor it stands on.
  add(cover(arch(x, y, 0.52, cy, baseY) - 0.105, aa));
  add(cover(segment(x, y, -0.52, baseY, 0.52, baseY) - 0.105, aa));

  if (connected) {
    // Lit: the opening filled in, so the difference is legible at 16px without
    // relying on a colour the menu bar is not going to honour anyway.
    add(cover(archSolid(x, y, 0.26, cy + 0.10, baseY - 0.115), aa));
  }
  return a;
}

/** Grey+alpha PNG (colour type 4): black everywhere, shape in the alpha. */
function png(size, alpha) {
  const stride = size * 2 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      raw[y * stride + 1 + x * 2] = 0; // luminance — template images are black
      raw[y * stride + 2 + x * 2] = alpha[y * size + x];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 4;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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

function render(size, options) {
  const out = Buffer.alloc(size * size);
  const samples = 4;
  for (let iy = 0; iy < size; iy++) {
    for (let ix = 0; ix < size; ix++) {
      let sum = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = ((ix + (sx + 0.5) / samples) / size) * 2 - 1;
          const y = ((iy + (sy + 0.5) / samples) / size) * 2 - 1;
          sum += shade(x, y, options);
        }
      }
      out[iy * size + ix] = Math.round(clamp((sum / (samples * samples)) * 255, 0, 255));
    }
  }
  return out;
}

mkdirSync(outDir, { recursive: true });
for (const [name, options] of [
  ['trayTemplate', { connected: false }],
  ['trayConnectedTemplate', { connected: true }],
]) {
  for (const [size, suffix] of [[16, ''], [32, '@2x']]) {
    const file = join(outDir, `${name}${suffix}.png`);
    writeFileSync(file, png(size, render(size, options)));
    process.stdout.write(`  wrote ${file}\n`);
  }
}
