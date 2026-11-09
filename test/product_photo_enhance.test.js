"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { enhanceProductPhoto, enhancementEnabled } = require("../utils/photoEnhance");

async function photo(svg) {
  return sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
}

test("plain-background photo becomes a square studio image", async () => {
  const input = await photo(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200">
    <rect width="100%" height="100%" fill="rgb(214,196,160)"/>
    <rect x="560" y="200" width="420" height="800" rx="50" fill="#1b2a49"/></svg>`);
  const { buffer, mode } = await enhanceProductPhoto(input);
  const meta = await sharp(buffer).metadata();
  assert.equal(mode, "studio");
  assert.equal(meta.format, "webp");
  assert.equal(meta.width, 1600);
  assert.equal(meta.height, 1600);
  // Backdrop corner must no longer carry the warm table colour.
  const { data } = await sharp(buffer).extract({ left: 4, top: 4, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[0] > 225 && data[1] > 225 && data[2] > 215, `corner ${Array.from(data)}`);
});

test("busy background is balanced, not cut out", async () => {
  const input = await photo(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200">
    <defs><pattern id="p" width="60" height="60" patternUnits="userSpaceOnUse">
    <rect width="30" height="30" fill="#8a6"/><rect x="30" y="30" width="30" height="30" fill="#468"/></pattern></defs>
    <rect width="100%" height="100%" fill="url(#p)"/><rect x="350" y="300" width="500" height="600" fill="#c33"/></svg>`);
  const { buffer, mode } = await enhanceProductPhoto(input);
  const meta = await sharp(buffer).metadata();
  assert.equal(mode, "balanced");
  assert.equal(meta.width, 1600);
  assert.equal(meta.height, 1600);
});

test("garbage input rejects so the upload layer can fall back", async () => {
  await assert.rejects(enhanceProductPhoto(Buffer.from("not an image")));
});

test("enhancement can be disabled per request or by env", () => {
  assert.equal(enhancementEnabled({ query: {} }), true);
  assert.equal(enhancementEnabled({ query: { enhance: "0" } }), false);
  process.env.PRODUCT_PHOTO_ENHANCE = "off";
  assert.equal(enhancementEnabled({ query: {} }), false);
  delete process.env.PRODUCT_PHOTO_ENHANCE;
});
