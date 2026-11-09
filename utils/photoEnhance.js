"use strict";

/**
 * Free, dependency-light product photo enhancement (uses only `sharp`).
 *
 * Pipeline:
 *  1. Normalise orientation, flatten transparency, bound the working size.
 *  2. Detect whether the photo has a plain background (low variance border ring).
 *  3a. Plain background  -> cut the subject out (edge flood-fill), neutralise the
 *      colour cast using the background as a white reference, then place the
 *      product on a soft studio backdrop with a contact shadow, centred in a
 *      square with even padding.
 *  3b. Busy background   -> keep the scene (never cut badly): gray-world white
 *      balance, auto-levels, gentle sharpen, centred on a square studio canvas.
 *
 * The function never throws for a decodable image; callers should still wrap it
 * and fall back to the original buffer.
 */

const sharp = require("sharp");

const OUTPUT_SIZE = 1600;
const WORK_EDGE = 560; // analysis resolution for mask building
const STUDIO_TOP = [250, 249, 246];
const STUDIO_BOTTOM = [234, 232, 227];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function median(values) {
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Sample a ring around the border and describe it. */
function analyseBorder(data, w, h, channels) {
  const ring = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  const rs = [];
  const gs = [];
  const bs = [];
  const push = (x, y) => {
    const i = (y * w + x) * channels;
    rs.push(data[i]);
    gs.push(data[i + 1]);
    bs.push(data[i + 2]);
  };
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (x < ring || y < ring || x >= w - ring || y >= h - ring) push(x, y);
    }
  }
  const bg = [median(rs), median(gs), median(bs)];
  let dev = 0;
  for (let i = 0; i < rs.length; i += 1) {
    dev += Math.abs(rs[i] - bg[0]) + Math.abs(gs[i] - bg[1]) + Math.abs(bs[i] - bg[2]);
  }
  dev /= rs.length * 3;
  return { bg, dev };
}

/** Flood-fill the background from the border; returns Uint8Array 1=subject. */
function buildSubjectMask(data, w, h, channels, bg, threshold) {
  const total = w * h;
  const isBg = new Uint8Array(total);
  const near = (idx) => {
    const i = idx * channels;
    const dr = data[i] - bg[0];
    const dg = data[i + 1] - bg[1];
    const db = data[i + 2] - bg[2];
    return Math.sqrt(dr * dr + dg * dg + db * db) < threshold;
  };
  const stack = new Int32Array(total);
  let sp = 0;
  const seed = (x, y) => {
    const idx = y * w + x;
    if (!isBg[idx] && near(idx)) {
      isBg[idx] = 1;
      stack[sp++] = idx;
    }
  };
  for (let x = 0; x < w; x += 1) {
    seed(x, 0);
    seed(x, h - 1);
  }
  for (let y = 0; y < h; y += 1) {
    seed(0, y);
    seed(w - 1, y);
  }
  while (sp > 0) {
    const idx = stack[--sp];
    const x = idx % w;
    const y = (idx - x) / w;
    if (x > 0) {
      const n = idx - 1;
      if (!isBg[n] && near(n)) { isBg[n] = 1; stack[sp++] = n; }
    }
    if (x < w - 1) {
      const n = idx + 1;
      if (!isBg[n] && near(n)) { isBg[n] = 1; stack[sp++] = n; }
    }
    if (y > 0) {
      const n = idx - w;
      if (!isBg[n] && near(n)) { isBg[n] = 1; stack[sp++] = n; }
    }
    if (y < h - 1) {
      const n = idx + w;
      if (!isBg[n] && near(n)) { isBg[n] = 1; stack[sp++] = n; }
    }
  }
  const mask = new Uint8Array(total);
  let area = 0;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < total; i += 1) {
    if (!isBg[i]) {
      mask[i] = 255;
      area += 1;
      const x = i % w;
      const y = (i - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { mask, area, box: { minX, minY, maxX, maxY }, total };
}

/** Keep only the largest connected subject blob (drops dust/noise specks). */
function keepLargestBlob(mask, w, h) {
  const label = new Int32Array(w * h);
  let best = 0;
  let bestSize = 0;
  let next = 1;
  const stack = new Int32Array(w * h);
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || label[start]) continue;
    let sp = 0;
    let size = 0;
    stack[sp++] = start;
    label[start] = next;
    while (sp > 0) {
      const idx = stack[--sp];
      size += 1;
      const x = idx % w;
      const neighbours = [];
      if (x > 0) neighbours.push(idx - 1);
      if (x < w - 1) neighbours.push(idx + 1);
      if (idx >= w) neighbours.push(idx - w);
      if (idx < w * (h - 1)) neighbours.push(idx + w);
      for (const n of neighbours) {
        if (mask[n] && !label[n]) {
          label[n] = next;
          stack[sp++] = n;
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = next;
    }
    next += 1;
  }
  const out = new Uint8Array(mask.length);
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < mask.length; i += 1) {
    if (label[i] === best) {
      out[i] = 255;
      const x = i % w;
      const y = (i - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { mask: out, area: bestSize, box: { minX, minY, maxX, maxY } };
}

function studioBackground(size) {
  const top = `rgb(${STUDIO_TOP.join(",")})`;
  const bottom = `rgb(${STUDIO_BOTTOM.join(",")})`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <defs><radialGradient id="g" cx="50%" cy="42%" r="75%">
      <stop offset="0%" stop-color="${top}"/><stop offset="100%" stop-color="${bottom}"/>
    </radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function shadowLayer(size, cx, baseY, width) {
  const rx = Math.max(10, width * 0.46);
  const ry = Math.max(6, width * 0.07);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <ellipse cx="${cx}" cy="${baseY}" rx="${rx}" ry="${ry}" fill="rgba(30,25,15,0.38)"/></svg>`;
  return sharp(Buffer.from(svg)).blur(Math.max(6, width * 0.025)).png().toBuffer();
}

/** Per-channel gain so a neutral reference becomes neutral, clamped to avoid wild shifts. */
function neutralGains(reference, strength = 1) {
  const avg = (reference[0] + reference[1] + reference[2]) / 3 || 1;
  return reference.map((v) => clamp(1 + ((avg / Math.max(v, 1)) - 1) * strength, 0.82, 1.22));
}

async function enhanceBusy(prepared, gains) {
  const body = await sharp(prepared)
    .recomb([
      [gains[0], 0, 0],
      [0, gains[1], 0],
      [0, 0, gains[2]],
    ])
    .normalise({ lower: 2, upper: 99 })
    .modulate({ saturation: 1.05 })
    .sharpen({ sigma: 0.8, m1: 0.6, m2: 1.2 })
    .resize(Math.round(OUTPUT_SIZE * 0.94), Math.round(OUTPUT_SIZE * 0.94), {
      fit: "inside",
      withoutEnlargement: false,
    })
    .toBuffer();
  const background = await studioBackground(OUTPUT_SIZE);
  return sharp(background)
    .composite([{ input: body, gravity: "centre" }])
    .webp({ quality: 86 })
    .toBuffer();
}

/**
 * @param {Buffer} input raw uploaded image
 * @returns {Promise<{buffer: Buffer, mode: "studio"|"balanced"}>}
 */
async function enhanceProductPhoto(input) {
  const prepared = await sharp(input, { failOn: "none" })
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize(2000, 2000, { fit: "inside", withoutEnlargement: true })
    .toColourspace("srgb")
    .removeAlpha()
    .png({ compressionLevel: 1 })
    .toBuffer();

  const { data, info } = await sharp(prepared)
    .resize(WORK_EDGE, WORK_EDGE, { fit: "inside" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels } = info;

  const { bg, dev } = analyseBorder(data, w, h, channels);
  const spread = Math.max(bg[0], bg[1], bg[2]) - Math.min(bg[0], bg[1], bg[2]);
  const plainBackground = dev < 14;

  // Gray-world estimate for busy photos.
  const means = [0, 0, 0];
  const step = 3;
  let count = 0;
  for (let i = 0; i < data.length; i += channels * step) {
    means[0] += data[i];
    means[1] += data[i + 1];
    means[2] += data[i + 2];
    count += 1;
  }
  const grayWorld = neutralGains(means.map((m) => m / count), 0.7);

  if (!plainBackground) {
    const buffer = await enhanceBusy(prepared, grayWorld);
    return { buffer, mode: "balanced" };
  }

  const threshold = clamp(dev * 3.2 + 26, 30, 62);
  let subject = buildSubjectMask(data, w, h, channels, bg, threshold);
  const ratio = subject.area / subject.total;
  if (ratio < 0.03 || ratio > 0.9) {
    return { buffer: await enhanceBusy(prepared, grayWorld), mode: "balanced" };
  }
  subject = keepLargestBlob(subject.mask, w, h);

  const { minX, minY, maxX, maxY } = subject.box;
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  if (bw < w * 0.1 || bh < h * 0.1) {
    return { buffer: await enhanceBusy(prepared, grayWorld), mode: "balanced" };
  }

  // Fill pinholes/halo: dilate a touch via blur+threshold, then feather at full res.
  const fullMeta = await sharp(prepared).metadata();
  const sx = fullMeta.width / w;
  const sy = fullMeta.height / h;
  const margin = 2;
  const cropLeft = clamp(Math.floor((minX - margin) * sx), 0, fullMeta.width - 1);
  const cropTop = clamp(Math.floor((minY - margin) * sy), 0, fullMeta.height - 1);
  const cropW = clamp(Math.ceil((bw + margin * 2) * sx), 1, fullMeta.width - cropLeft);
  const cropH = clamp(Math.ceil((bh + margin * 2) * sy), 1, fullMeta.height - cropTop);

  const maskLeft = clamp(Math.floor((cropLeft) / sx), 0, w - 1);
  const maskTop = clamp(Math.floor((cropTop) / sy), 0, h - 1);
  const maskW = clamp(Math.ceil(cropW / sx), 1, w - maskLeft);
  const maskH = clamp(Math.ceil(cropH / sy), 1, h - maskTop);

  const alpha = await sharp(Buffer.from(subject.mask), { raw: { width: w, height: h, channels: 1 } })
    .extract({ left: maskLeft, top: maskTop, width: maskW, height: maskH })
    .resize(cropW, cropH, { fit: "fill", kernel: "cubic" })
    .blur(2.2)
    .linear(1.9, -90) // tighten the blurred edge so it is soft but not ghosted
    .toColourspace("b-w")
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (alpha.info.channels !== 1 || alpha.info.width !== cropW || alpha.info.height !== cropH) {
    throw new Error("Unexpected mask layout");
  }

  // Backdrop -> near-white point (fixes colour cast AND dim exposure in one step).
  const bgNeutral = spread < 60;
  const gains = bgNeutral
    ? bg.map((v) => clamp(246 / Math.max(v, 1), 0.8, 1.45))
    : grayWorld;

  const cropped = await sharp(prepared)
    .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
    .recomb([
      [gains[0], 0, 0],
      [0, gains[1], 0],
      [0, 0, gains[2]],
    ])
    .modulate({ saturation: 1.04 })
    .sharpen({ sigma: 0.8, m1: 0.6, m2: 1.2 })
    .png({ compressionLevel: 1 })
    .toBuffer();

  const target = Math.round(OUTPUT_SIZE * 0.74);
  // joinChannel runs after resize inside sharp, so join first, then resize.
  const joined = await sharp(cropped)
    .joinChannel(alpha.data, { raw: { width: cropW, height: cropH, channels: 1 } })
    .png({ compressionLevel: 1 })
    .toBuffer();
  const cutout = await sharp(joined)
    .resize(target, target, { fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer({ resolveWithObject: true });

  const cw = cutout.info.width;
  const ch = cutout.info.height;
  const left = Math.round((OUTPUT_SIZE - cw) / 2);
  const top = Math.round((OUTPUT_SIZE - ch) / 2 - OUTPUT_SIZE * 0.015);
  const baseY = top + ch - Math.round(ch * 0.01);

  const [background, shadow] = await Promise.all([
    studioBackground(OUTPUT_SIZE),
    shadowLayer(OUTPUT_SIZE, OUTPUT_SIZE / 2, baseY, cw),
  ]);

  const buffer = await sharp(background)
    .composite([
      { input: shadow, left: 0, top: 0 },
      { input: cutout.data, left, top },
    ])
    .webp({ quality: 86 })
    .toBuffer();
  return { buffer, mode: "studio" };
}

function enhancementEnabled(req) {
  if (String(process.env.PRODUCT_PHOTO_ENHANCE || "on").toLowerCase() === "off") return false;
  const flag = req?.query?.enhance;
  return !(flag === "0" || flag === "false" || flag === "off");
}

module.exports = { enhanceProductPhoto, enhancementEnabled };
