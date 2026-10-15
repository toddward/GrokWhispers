#!/usr/bin/env node
'use strict';

// Renders the tray and app icons (a rounded "voice wave" glyph) into PNGs
// without any image dependencies. Run: npm run icons

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, '..', 'assets');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Signed distance to a vertical capsule centred at (cx, cy).
function capsule(px, py, cx, cy, halfH, r) {
  const dy = Math.max(Math.abs(py - cy) - halfH, 0);
  return Math.hypot(px - cx, dy) - r;
}

function render(size, { fg, bg, bars, dot = false }) {
  const S = 4; // supersampling
  const buf = Buffer.alloc(size * size * 4);
  const heights = bars;
  const n = heights.length;
  const pad = bg ? 0.24 : 0.08;
  const span = 1 - 2 * pad;
  const step = span / n;
  const r = step * 0.3;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let cover = 0;
      let bgCover = 0;
      for (let sy = 0; sy < S; sy += 1) {
        for (let sx = 0; sx < S; sx += 1) {
          const u = (x + (sx + 0.5) / S) / size;
          const v = (y + (sy + 0.5) / S) / size;
          if (bg) {
            const d = Math.hypot(Math.max(Math.abs(u - 0.5) - 0.28, 0), Math.max(Math.abs(v - 0.5) - 0.28, 0)) - 0.2;
            if (d <= 0) bgCover += 1;
          }
          let inside = false;
          for (let i = 0; i < n; i += 1) {
            const cx = pad + step * (i + 0.5);
            if (capsule(u, v, cx, 0.5, (heights[i] * span) / 2 - r, r) <= 0) { inside = true; break; }
          }
          if (dot && Math.hypot(u - 0.86, v - 0.16) <= 0.12) inside = true;
          if (inside) cover += 1;
        }
      }
      const a = cover / (S * S);
      const ba = bgCover / (S * S);
      const o = (y * size + x) * 4;
      if (bg) {
        // composite fg over gradient background
        const t = y / size;
        const bgc = [bg[0][0] * (1 - t) + bg[1][0] * t, bg[0][1] * (1 - t) + bg[1][1] * t, bg[0][2] * (1 - t) + bg[1][2] * t];
        for (let c = 0; c < 3; c += 1) buf[o + c] = Math.round(fg[c] * a + bgc[c] * (1 - a));
        buf[o + 3] = Math.round(255 * Math.max(ba, 0));
      } else {
        buf[o] = fg[0]; buf[o + 1] = fg[1]; buf[o + 2] = fg[2];
        buf[o + 3] = Math.round(255 * a);
      }
    }
  }
  return png(size, buf);
}

const IDLE = [0.3, 0.6, 0.95, 0.6, 0.3];
const ACTIVE = [0.55, 0.9, 0.45, 0.85, 0.5];
const write = (name, data) => fs.writeFileSync(path.join(OUT, name), data);

fs.mkdirSync(OUT, { recursive: true });
// macOS menu bar: black template images (the system tints them).
write('trayTemplate.png', render(16, { fg: [0, 0, 0], bars: IDLE }));
write('trayTemplate@2x.png', render(32, { fg: [0, 0, 0], bars: IDLE }));
write('trayActiveTemplate.png', render(16, { fg: [0, 0, 0], bars: ACTIVE, dot: true }));
write('trayActiveTemplate@2x.png', render(32, { fg: [0, 0, 0], bars: ACTIVE, dot: true }));
// Linux trays: light glyph, red dot when live.
write('tray.png', render(32, { fg: [235, 235, 240], bars: IDLE }));
write('tray-active.png', render(32, { fg: [255, 93, 93], bars: ACTIVE, dot: true }));
// App icon.
write('icon.png', render(512, { fg: [255, 255, 255], bg: [[124, 140, 255], [58, 46, 160]], bars: IDLE }));
console.log('icons written to', OUT);
