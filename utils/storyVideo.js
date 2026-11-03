const { spawn } = require("node:child_process");
const ffprobeStatic = require("ffprobe-static");
const cloudinary = require("cloudinary").v2;

const STORY_UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024; // Existing backend image upload cap.
const STORY_FORMATS = new Set(["mp4", "webm"]);
const STORY_PUBLIC_ID_PATTERN = /^yomart\/stories\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertManagedStoryPublicId(publicId) {
  if (typeof publicId !== "string" || !STORY_PUBLIC_ID_PATTERN.test(publicId)) {
    throw new Error("Refusing to access a Cloudinary asset outside the managed story namespace.");
  }
}

function validateProviderStoryAsset(asset, { publicId, expectedBytes, maxDurationSeconds, expectedFormat }) {
  assertManagedStoryPublicId(publicId);
  const bytes = Number(asset?.bytes);
  const duration = Number(asset?.duration);
  if (
    asset?.public_id !== publicId ||
    asset?.resource_type !== "video" ||
    asset?.type !== "authenticated" ||
    asset?.format !== expectedFormat ||
    !Number.isSafeInteger(bytes) || bytes !== expectedBytes ||
    bytes <= 0 || bytes > STORY_UPLOAD_LIMIT_BYTES ||
    !Number.isFinite(duration) || duration <= 0 || duration > maxDurationSeconds
  ) {
    throw new Error("Cloudinary returned unexpected story asset metadata.");
  }
}

function configuredMaxDuration(env = process.env) {
  const value = Number(env.STORY_MAX_DURATION_SECONDS);
  if (!Number.isFinite(value) || value <= 0) {
    const error = new Error("Video stories are disabled until STORY_MAX_DURATION_SECONDS is configured.");
    error.statusCode = 503;
    throw error;
  }
  return value;
}

function probeVideoBuffer(buffer, { maxDurationSeconds = configuredMaxDuration(), ffprobePath = ffprobeStatic.path } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return Promise.reject(Object.assign(new Error("Video file is empty."), { statusCode: 400 }));
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, ["-v", "error", "-show_entries", "format=format_name,duration:stream=codec_type,width,height", "-of", "json", "-i", "pipe:0"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(Object.assign(new Error("Could not validate video media."), { statusCode: 400 }));
    }, 10000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); if (stdout.length > 64 * 1024) child.kill("SIGKILL"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); if (stderr.length > 8 * 1024) child.kill("SIGKILL"); });
    child.on("error", () => finish(Object.assign(new Error("Video validation is unavailable on this server."), { statusCode: 503 })));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) return finish(Object.assign(new Error("The uploaded file is not a valid supported video."), { statusCode: 400 }));
      try {
        const metadata = JSON.parse(stdout);
        const formatNames = String(metadata.format?.format_name || "").split(",");
        const format = formatNames.includes("webm") ? "webm" : formatNames.some((name) => ["mp4", "mov", "m4a", "3gp", "3g2", "mj2"].includes(name)) ? "mp4" : null;
        const videoStream = metadata.streams?.find((stream) => stream.codec_type === "video");
        const duration = Number(metadata.format?.duration);
        if (!format || !STORY_FORMATS.has(format) || !videoStream || !Number.isFinite(duration) || duration <= 0) {
          return finish(Object.assign(new Error("Only valid MP4 or WebM videos with a video track are supported."), { statusCode: 400 }));
        }
        if (duration > maxDurationSeconds) return finish(Object.assign(new Error(`Video exceeds the configured maximum duration of ${maxDurationSeconds} seconds.`), { statusCode: 400 }));
        finish(null, { format, durationSeconds: duration, width: Number(videoStream.width) || null, height: Number(videoStream.height) || null });
      } catch (_) {
        finish(Object.assign(new Error("Could not validate video media."), { statusCode: 400 }));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(buffer);
  });
}

function uploadAuthenticatedVideo(buffer, publicId) {
  assertManagedStoryPublicId(publicId);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      error ? reject(error) : resolve(result);
    };
    const upload = cloudinary.uploader.upload_stream({
      public_id: publicId,
      resource_type: "video",
      type: "authenticated",
      overwrite: false,
    }, (error, result) => finish(error, result));
    upload.once("error", (error) => finish(error));
    upload.end(buffer);
  });
}

async function deleteAuthenticatedVideo(publicId) {
  assertManagedStoryPublicId(publicId);
  const result = await cloudinary.uploader.destroy(publicId, {
    resource_type: "video",
    type: "authenticated",
    invalidate: true,
  });
  if (!result || !["ok", "not found"].includes(result.result)) throw new Error("Video provider deletion did not complete.");
  return result;
}

function signedPlaybackUrl(publicId, format, expiresAt) {
  assertManagedStoryPublicId(publicId);
  if (!STORY_FORMATS.has(format) || !Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new Error("Invalid story playback URL parameters.");
  }
  return cloudinary.utils.private_download_url(publicId, format, {
    resource_type: "video",
    type: "authenticated",
    expires_at: expiresAt,
    attachment: false,
    streaming_attachment: false,
  });
}

module.exports = { STORY_UPLOAD_LIMIT_BYTES, STORY_FORMATS, configuredMaxDuration, probeVideoBuffer, validateProviderStoryAsset, assertManagedStoryPublicId, uploadAuthenticatedVideo, deleteAuthenticatedVideo, signedPlaybackUrl };
