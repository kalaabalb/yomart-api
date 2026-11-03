const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const cloudinary = require("cloudinary").v2;
const { configuredMaxDuration, probeVideoBuffer, validateProviderStoryAsset, deleteAuthenticatedVideo, uploadAuthenticatedVideo } = require("../utils/storyVideo");

test("story duration must be explicitly configured", () => {
  assert.throws(() => configuredMaxDuration({}), { statusCode: 503 });
  assert.equal(configuredMaxDuration({ STORY_MAX_DURATION_SECONDS: "22" }), 22);
  assert.throws(() => configuredMaxDuration({ STORY_MAX_DURATION_SECONDS: "not-a-number" }), { statusCode: 503 });
});

test("server media probe reads duration and rejects videos above the configured limit", { skip: process.platform === "win32" }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "yomart-ffprobe-test-"));
  const fakeProbe = path.join(directory, "probe");
  await fs.writeFile(fakeProbe, '#!/bin/sh\ncat >/dev/null\nprintf \'{"format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"4.5"},"streams":[{"codec_type":"video","width":360,"height":640}]}\'\n', { mode: 0o700 });
  try {
    const metadata = await probeVideoBuffer(Buffer.from("synthetic media bytes"), { maxDurationSeconds: 5, ffprobePath: fakeProbe });
    assert.deepEqual(metadata, { format: "mp4", durationSeconds: 4.5, width: 360, height: 640 });
    await assert.rejects(
      probeVideoBuffer(Buffer.from("synthetic media bytes"), { maxDurationSeconds: 4, ffprobePath: fakeProbe }),
      { statusCode: 400 },
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Cloudinary upload errors reject safely for API-level handling", async () => {
  const originalUploadStream = cloudinary.uploader.upload_stream;
  cloudinary.uploader.upload_stream = (_options, callback) => {
    const stream = new PassThrough();
    stream.on("finish", () => callback(new Error("synthetic provider failure")));
    return stream;
  };
  try {
    await assert.rejects(uploadAuthenticatedVideo(Buffer.from("synthetic"), "yomart/stories/123e4567-e89b-42d3-a456-426614174012"), /synthetic provider failure/);
  } finally {
    cloudinary.uploader.upload_stream = originalUploadStream;
  }
});

test("Cloudinary upload stream errors are observed instead of becoming unhandled", async () => {
  const originalUploadStream = cloudinary.uploader.upload_stream;
  cloudinary.uploader.upload_stream = () => {
    const stream = new PassThrough();
    stream.end = () => process.nextTick(() => stream.emit("error", new Error("synthetic stream failure")));
    return stream;
  };
  try {
    await assert.rejects(uploadAuthenticatedVideo(Buffer.from("synthetic"), "yomart/stories/123e4567-e89b-42d3-a456-426614174011"), /synthetic stream failure/);
  } finally {
    cloudinary.uploader.upload_stream = originalUploadStream;
  }
});

test("provider asset must match the managed story ID and validated media metadata", () => {
  const publicId = "yomart/stories/123e4567-e89b-42d3-a456-426614174010";
  const asset = {
    public_id: publicId,
    resource_type: "video",
    type: "authenticated",
    format: "mp4",
    bytes: 2048,
    duration: 8.5,
  };
  assert.doesNotThrow(() => validateProviderStoryAsset(asset, {
    publicId, expectedBytes: 2048, maxDurationSeconds: 12, expectedFormat: "mp4",
  }));
  for (const invalid of [
    { ...asset, public_id: "catalog/other-asset" },
    { ...asset, type: "upload" },
    { ...asset, bytes: undefined },
    { ...asset, bytes: 1024 },
    { ...asset, duration: undefined },
    { ...asset, duration: 13 },
    { ...asset, format: "webm" },
  ]) {
    assert.throws(() => validateProviderStoryAsset(invalid, {
      publicId, expectedBytes: 2048, maxDurationSeconds: 12, expectedFormat: "mp4",
    }));
  }
});

test("story deletion refuses provider IDs outside its generated namespace", async () => {
  const originalDestroy = cloudinary.uploader.destroy;
  let providerCalled = false;
  cloudinary.uploader.destroy = async () => { providerCalled = true; return { result: "ok" }; };
  try {
    await assert.rejects(deleteAuthenticatedVideo("catalog/product-image"), /outside the managed story namespace/);
    assert.equal(providerCalled, false);
  } finally {
    cloudinary.uploader.destroy = originalDestroy;
  }
});
