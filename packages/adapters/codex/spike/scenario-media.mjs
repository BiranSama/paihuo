import { randomInt } from "node:crypto";
import { deflateSync } from "node:zlib";

export function colorFixture() {
  const colors = { R: [255, 0, 0], G: [0, 200, 0], B: [0, 0, 255], Y: [255, 255, 0] };
  const order = Object.keys(colors);
  for (let i = order.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const width = 128,
    height = 64,
    row = width * 3 + 1,
    pixels = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      pixels.set(colors[order[Math.floor(x / 32)]], y * row + 1 + x * 3);
  const chunk = (name, bytes) => {
    const type = Buffer.from(name),
      head = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    head.writeUInt32BE(bytes.length);
    let value = 0xffffffff;
    for (const n of Buffer.concat([type, bytes])) {
      value ^= n;
      for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    crc.writeUInt32BE((value ^ 0xffffffff) >>> 0);
    return Buffer.concat([head, type, bytes, crc]);
  };
  const h = Buffer.alloc(13);
  h.writeUInt32BE(width);
  h.writeUInt32BE(height, 4);
  h[8] = 8;
  h[9] = 2;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", h),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return { order: order.join(""), url: `data:image/png;base64,${png.toString("base64")}` };
}
