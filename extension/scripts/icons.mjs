/**
 * The extension's icons: a rounded #FF4D00 square with a white "A", drawn pixel by pixel and
 * encoded as PNG with node:zlib (no image libraries).
 */

import zlib from "node:zlib";

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

// Distance from point p to segment ab, all in unit coordinates.
const seg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

/** Coverage of the icon at a point: [r, g, b, a] in 0..255. */
function shade(x, y) {
  // Rounded square, corner radius 0.22.
  const r = 0.22;
  const qx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0), qy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  if (Math.hypot(qx, qy) > r) return [0, 0, 0, 0];
  // The "A": two legs and a crossbar.
  const w = 0.085;
  const inA = seg(x, y, 0.5, 0.2, 0.27, 0.8) < w || seg(x, y, 0.5, 0.2, 0.73, 0.8) < w || (seg(x, y, 0.37, 0.58, 0.63, 0.58) < w * 0.8);
  return inA ? [255, 255, 255, 255] : [0xff, 0x4d, 0x00, 255];
}

export function iconPng(size) {
  const ss = 4; // supersampling for smooth edges
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte 0
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          acc = acc.map((v, i) => v + (i < 3 ? c[i] * c[3] : c[3]));
        }
      const a = acc[3] / (ss * ss);
      const o = 1 + x * 4;
      row[o] = a ? Math.round(acc[0] / acc[3]) : 0;
      row[o + 1] = a ? Math.round(acc[1] / acc[3]) : 0;
      row[o + 2] = a ? Math.round(acc[2] / acc[3]) : 0;
      row[o + 3] = Math.round(a);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
