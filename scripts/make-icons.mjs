// Generates the extension icons (a filled circle "score ring" with a check
// mark) as PNGs with no dependencies, so the repo stays tiny.
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "extension", "icons");
mkdirSync(out, { recursive: true });

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Distance from point to segment, for drawing the check mark.
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

for (const size of [16, 48, 128]) {
  const c = size / 2, R = size / 2 - 0.5, stroke = Math.max(1.2, size * 0.09);
  const buf = png(size, (x, y) => {
    const px = x + 0.5, py = y + 0.5;
    const d = Math.hypot(px - c, py - c);
    if (d > R) return [0, 0, 0, 0];
    const edge = Math.min(1, R - d); // anti-alias the circle edge
    const check = Math.min(
      segDist(px, py, size * 0.28, size * 0.52, size * 0.44, size * 0.68),
      segDist(px, py, size * 0.44, size * 0.68, size * 0.74, size * 0.34),
    );
    const onCheck = Math.max(0, Math.min(1, stroke / 2 + 0.5 - check));
    const base = [59, 91, 219];
    const rgb = base.map((v) => Math.round(v + (255 - v) * onCheck));
    return [...rgb, Math.round(255 * edge)];
  });
  writeFileSync(join(out, `icon${size}.png`), buf);
  console.log(`wrote icon${size}.png`);
}
