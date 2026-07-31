/**
 * LlamaAutoPlayBlock placeholder icon generator.
 *
 * PLACEHOLDER ART. The shipped icon is a commissioned 3D cement block (spec §10);
 * this exists so the extension is installable and visually coherent before that lands.
 *
 * The mark is a cinder block seen head-on: two rectangular voids in a solid block.
 * Read another way, the two voids are a pause glyph — block and "paused" in one shape.
 *
 * Writes RGBA PNGs with no image dependency: a hand-rolled PNG container around
 * Node's zlib, fed by a supersampled signed-distance rasteriser.
 *
 * Usage: npm run icons
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ICON_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'icons');
const SIZES = [16, 32, 48, 128];
const SAMPLES = 4; // per axis, so 16 subsamples per pixel

/** @typedef {{ r: number, g: number, b: number }} Rgb */
/** @typedef {{ block: Rgb, void: Rgb }} Palette */

/** @type {Record<'color' | 'gray', Palette>} */
const PALETTES = {
  // Amber concrete. Distinct at 16px against both light and dark Chrome toolbars.
  color: { block: { r: 0xed, g: 0xa1, b: 0x3c }, void: { r: 0x24, g: 0x1b, b: 0x12 } },
  // Master-toggle-off state.
  gray: { block: { r: 0xa0, g: 0xa0, b: 0xa0 }, void: { r: 0x30, g: 0x30, b: 0x30 } },
};

// Geometry in unit space (0..1), so every size renders the same mark.
const BLOCK = { cx: 0.5, cy: 0.5, hw: 0.445, hh: 0.445, r: 0.16 };
const VOID_HALF_WIDTH = 0.115;
const VOID_HALF_HEIGHT = 0.245;
const VOID_OFFSET = 0.185; // from centre, left and right
const VOID_RADIUS = 0.045;

/**
 * Signed distance to a rounded rectangle. Negative inside, positive outside.
 *
 * @param {number} px
 * @param {number} py
 * @param {number} cx centre x
 * @param {number} cy centre y
 * @param {number} hw half width
 * @param {number} hh half height
 * @param {number} r corner radius
 * @returns {number}
 */
function roundedRectDistance(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

/**
 * Fraction of a pixel covered by the block body and by the two voids.
 *
 * @param {number} x pixel column
 * @param {number} y pixel row
 * @param {number} size icon edge length in pixels
 * @returns {{ block: number, void: number }}
 */
function coverageAt(x, y, size) {
  let blockHits = 0;
  let voidHits = 0;

  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      // Sample at subpixel centres so coverage is symmetric.
      const px = (x + (sx + 0.5) / SAMPLES) / size;
      const py = (y + (sy + 0.5) / SAMPLES) / size;

      if (roundedRectDistance(px, py, BLOCK.cx, BLOCK.cy, BLOCK.hw, BLOCK.hh, BLOCK.r) <= 0) {
        blockHits++;
      }

      const left = roundedRectDistance(
        px, py, BLOCK.cx - VOID_OFFSET, BLOCK.cy,
        VOID_HALF_WIDTH, VOID_HALF_HEIGHT, VOID_RADIUS,
      );
      const right = roundedRectDistance(
        px, py, BLOCK.cx + VOID_OFFSET, BLOCK.cy,
        VOID_HALF_WIDTH, VOID_HALF_HEIGHT, VOID_RADIUS,
      );
      if (left <= 0 || right <= 0) voidHits++;
    }
  }

  const total = SAMPLES * SAMPLES;
  return { block: blockHits / total, void: voidHits / total };
}

/**
 * Rasterise the mark into a raw RGBA buffer (non-premultiplied, as PNG expects).
 *
 * @param {number} size
 * @param {Palette} palette
 * @returns {Buffer}
 */
function rasterise(size, palette) {
  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cov = coverageAt(x, y, size);
      // Voids sit wholly inside the block, so alpha comes from the block alone and
      // the void only shifts colour.
      const t = cov.void;
      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(palette.block.r * (1 - t) + palette.void.r * t);
      pixels[offset + 1] = Math.round(palette.block.g * (1 - t) + palette.void.g * t);
      pixels[offset + 2] = Math.round(palette.block.b * (1 - t) + palette.void.b * t);
      pixels[offset + 3] = Math.round(cov.block * 255);
    }
  }

  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * @param {Buffer} buf
 * @returns {number}
 */
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = /** @type {number} */ (CRC_TABLE[(c ^ byte) & 0xff]) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} type four-character chunk name
 * @param {Buffer} data
 * @returns {Buffer}
 */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * Wrap a raw RGBA buffer as a PNG.
 *
 * @param {Buffer} pixels
 * @param {number} size
 * @returns {Buffer}
 */
function encodePng(pixels, size) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // colour type: RGBA
  ihdr.writeUInt8(0, 10); // compression: deflate
  ihdr.writeUInt8(0, 11); // filter: adaptive
  ihdr.writeUInt8(0, 12); // interlace: none

  // Each scanline is prefixed with its filter type. Filter 0 (none) is plenty
  // for images this small.
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(ICON_DIR, { recursive: true });

for (const [variant, palette] of Object.entries(PALETTES)) {
  for (const size of SIZES) {
    const name = variant === 'color' ? `icon${size}.png` : `icon${size}-gray.png`;
    const png = encodePng(rasterise(size, palette), size);
    writeFileSync(join(ICON_DIR, name), png);
    console.log(`wrote icons/${name} (${png.length} bytes)`);
  }
}
