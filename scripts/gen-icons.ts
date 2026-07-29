/**
 * Generates every raster asset the PWA needs, straight from code.
 *
 * Why hand-rolled: the repo has no image toolchain, and this is a live agent —
 * adding `sharp` (a native binary) to the deploy for a build-time-only concern
 * is a bad trade. A PNG is a zlib stream plus four CRC'd chunks, so the encoder
 * below is ~70 lines and the mark stays reproducible: change the constants,
 * re-run `npm run icons`, and every icon, favicon and splash re-emits in sync.
 *
 *   npm run icons
 *
 * Output lands in src/web/icons/ and is served publicly by src/web/server.ts.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const OUT_DIR = fileURLToPath(new URL('../src/web/icons/', import.meta.url));

// ── the mark ────────────────────────────────────────────────────────────────
// Nebula: the default theme. Icons are baked at install time and can't follow a
// user's chosen accent, so they always wear the default identity.
const GRAD_FROM: RGB = [0x6d, 0x3b, 0xf5]; // violet
const GRAD_TO: RGB = [0xc3, 0x4a, 0xe8]; // magenta
const HIGHLIGHT: RGB = [0xf0, 0xe2, 0xff];
const INK: RGB = [0x0b, 0x07, 0x14]; // the app's base background

type RGB = [number, number, number];
type RGBA = [number, number, number, number];

// ── PNG encoding ────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * Per-row adaptive filtering (the standard minimum-sum-of-absolute-differences
 * heuristic). Matters a lot here: the splash screens are mostly smooth radial
 * bloom, which deflates badly unfiltered but almost vanishes under Up/Paeth.
 */
function filterRows(rgba: Buffer, w: number, h: number): Buffer {
  const stride = w * 4;
  const out = Buffer.alloc((stride + 1) * h);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];

  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  for (let y = 0; y < h; y++) {
    rgba.copy(cur, 0, y * stride, (y + 1) * stride);
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const dst = cand[f];
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? cur[i - 4] : 0;
        const b = prev[i];
        const c = i >= 4 ? prev[i - 4] : 0;
        let v: number;
        switch (f) {
          case 0: v = cur[i]; break;
          case 1: v = cur[i] - a; break;
          case 2: v = cur[i] - b; break;
          case 3: v = cur[i] - ((a + b) >> 1); break;
          default: v = cur[i] - paeth(a, b, c);
        }
        v &= 0xff;
        dst[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; best = f; }
    }
    out[y * (stride + 1)] = best;
    cand[best].copy(out, y * (stride + 1) + 1);
    cur.copy(prev);
  }
  return out;
}

function encodePng(w: number, h: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(filterRows(rgba, w, h), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── drawing ─────────────────────────────────────────────────────────────────
const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);
const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
/** src over dst, both straight alpha. */
function over(dst: RGBA, src: RGBA): RGBA {
  const a = src[3] + dst[3] * (1 - src[3]);
  if (a <= 0) return [0, 0, 0, 0];
  return [
    (src[0] * src[3] + dst[0] * dst[3] * (1 - src[3])) / a,
    (src[1] * src[3] + dst[1] * dst[3] * (1 - src[3])) / a,
    (src[2] * src[3] + dst[2] * dst[3] * (1 - src[3])) / a,
    a,
  ];
}

interface OrbOpts {
  cx: number;
  cy: number;
  r: number;
  /** Draw the sparkle glyph inside the orb. */
  sparkle: boolean;
  /** Outer glow radius as a multiple of r. 0 disables it. */
  glow: number;
  /** Draw the sphere itself. False leaves just the sparkle. */
  disc?: boolean;
}

/**
 * The sparkle is an astroid — |x|^(2/3) + |y|^(2/3) <= a^(2/3) — which gives the
 * four concave cusps of the four-point star in the concept art, with no path
 * rasteriser needed.
 */
function inSparkle(dx: number, dy: number, a: number): boolean {
  if (a <= 0) return false;
  const nx = Math.abs(dx) / a;
  const ny = Math.abs(dy) / a;
  return Math.cbrt(nx * nx) + Math.cbrt(ny * ny) <= 1;
}

/** Colour of the mark at one sample point, composited over `base`. */
function sampleOrb(x: number, y: number, o: OrbOpts, base: RGBA): RGBA {
  const dx = x - o.cx;
  const dy = y - o.cy;
  const dist = Math.hypot(dx, dy);
  let px = base;

  if (o.glow > 0 && dist < o.r * o.glow) {
    const t = clamp01(1 - (dist - o.r) / (o.r * (o.glow - 1)));
    const falloff = Math.pow(Math.max(0, t), 2.4);
    px = over(px, [...mix(GRAD_FROM, GRAD_TO, 0.5), falloff * 0.5] as RGBA);
  }

  if (o.disc !== false && dist <= o.r) {
    // 135° diagonal ramp across the orb, brighter at the top-left.
    const t = clamp01((dx / o.r + dy / o.r) * 0.5 + 0.5);
    let c = mix(GRAD_FROM, GRAD_TO, t);
    // Specular highlight, same placement as the CSS orb (32% 30%).
    const hl = Math.hypot(dx + o.r * 0.36, dy + o.r * 0.4) / (o.r * 0.95);
    c = mix(c, HIGHLIGHT, Math.pow(clamp01(1 - hl), 2.2) * 0.75);
    // Darken the far edge so the sphere reads as lit, not as a flat disc.
    const edge = Math.pow(clamp01((dist / o.r - 0.55) / 0.45), 2);
    c = mix(c, [c[0] * 0.35, c[1] * 0.25, c[2] * 0.55], edge * 0.55);
    px = over(px, [...c, 1] as RGBA);
  }

  if (o.sparkle) {
    const a = o.r * 0.62;
    if (inSparkle(dx, dy, a)) px = over(px, [255, 255, 255, 0.96]);
    // The small companion sparkle from the concept's avatar.
    const sx = dx - o.r * 0.44;
    const sy = dy + o.r * 0.44;
    if (inSparkle(sx, sy, o.r * 0.2)) px = over(px, [255, 255, 255, 0.92]);
  }

  return px;
}

interface RenderOpts {
  w: number;
  h: number;
  /** Flat background. null = transparent. */
  bg: RGB | null;
  /** Full-bleed diagonal accent gradient instead of a flat background. */
  bleedGradient?: boolean;
  orb?: OrbOpts;
}

function render(opts: RenderOpts): Buffer {
  const { w, h, orb } = opts;
  const buf = Buffer.alloc(w * 4 * h);
  // Anti-alias only around the mark; the background is smooth by construction,
  // so supersampling it would just cost time.
  const aaBox = orb
    ? {
        x0: Math.max(0, Math.floor(orb.cx - orb.r - 2)),
        x1: Math.min(w, Math.ceil(orb.cx + orb.r + 2)),
        y0: Math.max(0, Math.floor(orb.cy - orb.r - 2)),
        y1: Math.min(h, Math.ceil(orb.cy + orb.r + 2)),
      }
    : null;

  const background = (x: number, y: number): RGBA => {
    if (opts.bleedGradient) {
      const t = clamp01((x / w + y / h) * 0.5);
      return [...mix(GRAD_FROM, GRAD_TO, t), 1] as RGBA;
    }
    if (opts.bg) return [...opts.bg, 1] as RGBA;
    return [0, 0, 0, 0];
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let px: RGBA;
      const needsAa =
        aaBox && x >= aaBox.x0 && x < aaBox.x1 && y >= aaBox.y0 && y < aaBox.y1;
      if (needsAa && orb) {
        let r = 0, g = 0, b = 0, a = 0;
        const N = 4;
        for (let sy = 0; sy < N; sy++) {
          for (let sx = 0; sx < N; sx++) {
            const px2 = x + (sx + 0.5) / N;
            const py2 = y + (sy + 0.5) / N;
            const s = sampleOrb(px2, py2, orb, background(px2, py2));
            r += s[0] * s[3]; g += s[1] * s[3]; b += s[2] * s[3]; a += s[3];
          }
        }
        const n = N * N;
        px = a > 0 ? [r / a, g / a, b / a, a / n] : [0, 0, 0, 0];
      } else if (orb) {
        px = sampleOrb(x + 0.5, y + 0.5, orb, background(x + 0.5, y + 0.5));
      } else {
        px = background(x + 0.5, y + 0.5);
      }
      const i = (y * w + x) * 4;
      buf[i] = Math.round(clamp01(px[0] / 255) * 255);
      buf[i + 1] = Math.round(clamp01(px[1] / 255) * 255);
      buf[i + 2] = Math.round(clamp01(px[2] / 255) * 255);
      buf[i + 3] = Math.round(clamp01(px[3]) * 255);
    }
  }
  return encodePng(w, h, buf);
}

// ── assets ──────────────────────────────────────────────────────────────────
/** Transparent background, glowing orb — browser tabs, desktop title bars. */
function iconAny(size: number): Buffer {
  const r = size * 0.36;
  return render({
    w: size,
    h: size,
    bg: null,
    orb: { cx: size / 2, cy: size / 2, r, sparkle: true, glow: 1.32 },
  });
}

/**
 * Full-bleed gradient with the sparkle inside the 80% safe circle — Android
 * adaptive icons and iOS, both of which apply their own mask and composite
 * transparency onto something unpredictable. The sphere is dropped here: an
 * accent orb on an accent field has almost no contrast, so the glyph carries it.
 */
function iconMaskable(size: number): Buffer {
  return render({
    w: size,
    h: size,
    bg: null,
    bleedGradient: true,
    orb: { cx: size / 2, cy: size / 2, r: size * 0.355, sparkle: true, glow: 0, disc: false },
  });
}

/**
 * The Android notification badge — the tiny mark in the status bar.
 *
 * Android throws away every colour here and keeps only the alpha channel,
 * tinting the silhouette to match the system theme. So this is the sparkle
 * alone: no sphere (it would flatten to a solid blob) and no glow (a soft
 * falloff becomes a smear once it's a stencil).
 */
function badge(size: number): Buffer {
  return render({
    w: size,
    h: size,
    bg: null,
    orb: { cx: size / 2, cy: size / 2, r: size * 0.48, sparkle: true, glow: 0, disc: false },
  });
}

/**
 * Deliberately flat behind the mark. A full-canvas bloom looks great in the
 * running app, but on a launch image it is on screen for a few hundred
 * milliseconds and costs ~100 KB per device in gradient noise that deflate
 * can't compress. A flat field plus the orb's own glow reads the same and
 * collapses to a few KB.
 */
function splash(w: number, h: number): Buffer {
  const r = Math.min(w, h) * 0.085;
  return render({
    w,
    h,
    bg: INK,
    orb: { cx: w / 2, cy: h * 0.42, r, sparkle: true, glow: 1.55 },
  });
}

/**
 * iOS picks a startup image by exact media query, so each entry needs its CSS
 * size and DPR. Landscape is only emitted for iPads: phones are launched in
 * portrait in practice, and an unmatched query just falls back to the
 * manifest's background colour — not worth doubling the committed bytes.
 */
export const APPLE_DEVICES = [
  { name: 'iphone-16-pro-max', w: 440, h: 956, dpr: 3, landscape: false },
  { name: 'iphone-16-pro', w: 402, h: 874, dpr: 3, landscape: false },
  { name: 'iphone-15-pro-max', w: 430, h: 932, dpr: 3, landscape: false },
  { name: 'iphone-15-pro', w: 393, h: 852, dpr: 3, landscape: false },
  { name: 'iphone-14-plus', w: 428, h: 926, dpr: 3, landscape: false },
  { name: 'iphone-14', w: 390, h: 844, dpr: 3, landscape: false },
  { name: 'iphone-13-mini', w: 375, h: 812, dpr: 3, landscape: false },
  { name: 'iphone-11-pro-max', w: 414, h: 896, dpr: 3, landscape: false },
  { name: 'iphone-11', w: 414, h: 896, dpr: 2, landscape: false },
  { name: 'iphone-8-plus', w: 414, h: 736, dpr: 3, landscape: false },
  { name: 'iphone-se', w: 375, h: 667, dpr: 2, landscape: false },
  { name: 'ipad-pro-12', w: 1024, h: 1366, dpr: 2, landscape: true },
  { name: 'ipad-pro-11', w: 834, h: 1194, dpr: 2, landscape: true },
  { name: 'ipad-air', w: 834, h: 1112, dpr: 2, landscape: true },
  { name: 'ipad-10', w: 810, h: 1080, dpr: 2, landscape: true },
  { name: 'ipad-mini', w: 768, h: 1024, dpr: 2, landscape: true },
] as const;

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const f of readdirSync(OUT_DIR)) {
    if (f.endsWith('.png')) unlinkSync(join(OUT_DIR, f));
  }

  let count = 0;
  let bytes = 0;
  const emit = (name: string, buf: Buffer) => {
    writeFileSync(join(OUT_DIR, name), buf);
    count++;
    bytes += buf.length;
    console.log(`  ${name.padEnd(38)} ${(buf.length / 1024).toFixed(1)} KB`);
  };

  console.log('icons');
  for (const size of [16, 32, 192, 512]) emit(`icon-${size}.png`, iconAny(size));
  // iOS composites transparency onto an unpredictable backdrop, so the
  // apple-touch-icon wears the full-bleed gradient rather than the glowing orb.
  emit('apple-touch-icon.png', iconMaskable(180));
  for (const size of [192, 512]) emit(`icon-maskable-${size}.png`, iconMaskable(size));
  emit('badge-96.png', badge(96));

  console.log('splash screens');
  for (const d of APPLE_DEVICES) {
    emit(`splash-${d.name}-portrait.png`, splash(d.w * d.dpr, d.h * d.dpr));
    if (d.landscape) emit(`splash-${d.name}-landscape.png`, splash(d.h * d.dpr, d.w * d.dpr));
  }

  console.log(`\n${count} files, ${(bytes / 1024 / 1024).toFixed(2)} MB total → ${OUT_DIR}`);
}

main();
