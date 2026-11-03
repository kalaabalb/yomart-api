const crypto = require("node:crypto");
const express = require("express");
const multer = require("multer");
const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const Story = require("../model/story");
const { requireAdminAuth, buildOwnedQuery, canAccessOwnedDocument } = require("../middleware/adminAccess");
const { hasCloudinary, uploadLimiter } = require("../uploadFile");
const storyVideo = require("../utils/storyVideo");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: storyVideo.STORY_UPLOAD_LIMIT_BYTES,
    files: 1,
    fields: 3,
    fieldSize: 4096,
    fieldNameSize: 50,
    parts: 4,
  },
});
const activeUploadRequests = new Set();
const activeStoryIds = new Set();
function markStoryUploadActive(storyId) {
  const id = String(storyId);
  activeStoryIds.add(id);
  return () => activeStoryIds.delete(id);
}

function reserveStoryUploadSlot(req, res, next) {
  if (activeUploadRequests.size >= 1) {
    return res.status(429).json({ success: false, message: "Another story upload is already being processed. Try again shortly." });
  }
  const requestKey = Symbol("story-upload");
  activeUploadRequests.add(requestKey);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeUploadRequests.delete(requestKey);
  };
  res.once("finish", release);
  res.once("close", release);
  req.once("aborted", release);
  next();
}

const publicFields = (story) => {
  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  return {
    id: String(story._id),
    title: story.title,
    subtitle: story.subtitle,
    format: story.format,
    durationSeconds: story.durationSeconds,
    width: story.width,
    height: story.height,
    sortOrder: story.sortOrder,
    playbackUrl: storyVideo.signedPlaybackUrl(story.publicId, story.format, expiresAt),
    playbackExpiresAt: new Date(expiresAt * 1000).toISOString(),
  };
};

function parseStoryMetadata(body, { partial = false } = {}) {
  const output = {};
  if (!partial || body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 80) return { error: "Title is required and must be 80 characters or fewer." };
    output.title = body.title.trim();
  }
  if (!partial || body.subtitle !== undefined) {
    if (body.subtitle !== undefined && (typeof body.subtitle !== "string" || body.subtitle.trim().length > 140)) return { error: "Subtitle must be 140 characters or fewer." };
    output.subtitle = (body.subtitle || "").trim();
  }
  if (body.sortOrder !== undefined) {
    const sortOrder = Number(body.sortOrder);
    if (!Number.isInteger(sortOrder) || sortOrder < 0) return { error: "Sort order must be a non-negative integer." };
    output.sortOrder = sortOrder;
  }
  for (const key of ["isPublished", "isActive"]) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "boolean") return { error: `${key} must be a boolean.` };
      output[key] = body[key];
    }
  }
  return { value: output };
}

router.get("/published", asyncHandler(async (_req, res) => {
  if (!hasCloudinary()) return res.status(503).json({ success: false, message: "Story playback is temporarily unavailable." });
  const stories = await Story.find({ uploadStatus: "ready", isActive: true, isPublished: true }).sort({ sortOrder: 1, createdAt: -1 }).lean();
  try {
    return res.json({ success: true, data: stories.map(publicFields) });
  } catch (_) {
    return res.status(503).json({ success: false, message: "Story playback is temporarily unavailable." });
  }
}));

router.get("/", requireAdminAuth, asyncHandler(async (req, res) => {
  const stories = await Story.find(buildOwnedQuery(req, {})).sort({ sortOrder: 1, createdAt: -1 }).lean();
  const data = stories.map((story) => ({
    id: String(story._id), title: story.title, subtitle: story.subtitle,
    format: story.format, durationSeconds: story.durationSeconds,
    bytes: story.bytes, width: story.width, height: story.height,
    isPublished: story.isPublished, isActive: story.isActive, uploadStatus: story.uploadStatus,
    sortOrder: story.sortOrder, createdAt: story.createdAt, updatedAt: story.updatedAt,
    ...(hasCloudinary() && story.uploadStatus === "ready" ? { previewUrl: storyVideo.signedPlaybackUrl(story.publicId, story.format, Math.floor(Date.now() / 1000) + 300) } : {}),
  }));
  return res.json({ success: true, data });
}));

router.post("/", requireAdminAuth, uploadLimiter, reserveStoryUploadSlot, (req, res, next) => {
  if (!hasCloudinary()) return res.status(503).json({ success: false, message: "Video uploads require configured Cloudinary storage; local video storage is disabled." });
  try { storyVideo.configuredMaxDuration(); } catch (error) { return res.status(error.statusCode || 503).json({ success: false, message: error.message }); }
  upload.single("video")(req, res, (error) => {
    if (error) return res.status(error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ success: false, message: error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE" ? "Video exceeds the 10 MiB upload limit." : "Video upload could not be parsed." });
    next();
  });
}, asyncHandler(async (req, res) => {
  const parsed = parseStoryMetadata(req.body || {});
  if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
  if (!req.file) return res.status(400).json({ success: false, message: "Choose an MP4 or WebM video." });
  const extension = require("node:path").extname(req.file.originalname).toLowerCase();
  const mimeMatches = (extension === ".mp4" && req.file.mimetype === "video/mp4") || (extension === ".webm" && req.file.mimetype === "video/webm");
  if (!mimeMatches) return res.status(400).json({ success: false, message: "Choose a matching MP4 or WebM video file." });
  const maxDurationSeconds = storyVideo.configuredMaxDuration();
  let metadata;
  try {
    metadata = await storyVideo.probeVideoBuffer(req.file.buffer, { maxDurationSeconds });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ success: false, message: error.statusCode === 503 ? error.message : "The uploaded file is not a valid supported video." });
  }
  if ((extension === ".webm") !== (metadata.format === "webm")) return res.status(400).json({ success: false, message: "The video content does not match its file type." });
  const publicId = `yomart/stories/${crypto.randomUUID()}`;
  let story;
  try {
    story = await Story.create({
      ...parsed.value,
      publicId,
      format: metadata.format,
      durationSeconds: metadata.durationSeconds,
      bytes: req.file.size,
      width: metadata.width,
      height: metadata.height,
      createdBy: req.adminUser._id,
      uploadStatus: "uploading",
      isPublished: false,
    });
  } catch (_) {
    return res.status(503).json({ success: false, message: "Story metadata could not be saved; no video was uploaded." });
  }
  const storyId = String(story._id);
  const releaseStoryUpload = markStoryUploadActive(storyId);
  try {
    const asset = await storyVideo.uploadAuthenticatedVideo(req.file.buffer, publicId);
    storyVideo.validateProviderStoryAsset(asset, {
      publicId,
      expectedBytes: req.file.size,
      maxDurationSeconds,
      expectedFormat: metadata.format,
    });
    story.uploadStatus = "ready";
    await story.save();
    return res.status(201).json({ success: true, data: { id: String(story._id), title: story.title, subtitle: story.subtitle, isPublished: story.isPublished, isActive: story.isActive, format: story.format, durationSeconds: story.durationSeconds, bytes: story.bytes, uploadStatus: story.uploadStatus } });
  } catch (_) {
    story.uploadStatus = "cleanup_pending";
    story.isPublished = false;
    story.isActive = false;
    await story.save().catch(() => {});
    return res.status(502).json({ success: false, message: "Video storage could not accept or finish the upload (for example, a network or quota limit). The story remains unpublished and is retained for safe cleanup or retry." });
  } finally {
    releaseStoryUpload();
  }
}));

router.put("/:id", requireAdminAuth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid story ID." });
  const parsed = parseStoryMetadata(req.body || {}, { partial: true });
  if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
  if (!Object.keys(parsed.value).length) return res.status(400).json({ success: false, message: "No story changes were provided." });
  const story = await Story.findById(req.params.id);
  if (!story) return res.status(404).json({ success: false, message: "Story not found." });
  if (!canAccessOwnedDocument(req, story)) return res.status(403).json({ success: false, message: "You can only manage stories you created." });
  if (story.uploadStatus !== "ready") return res.status(409).json({ success: false, message: "Only a ready story can be edited. Wait for upload or cleanup to finish." });
  Object.assign(story, parsed.value);
  await story.save();
  return res.json({ success: true, data: { id: String(story._id), title: story.title, subtitle: story.subtitle, isPublished: story.isPublished, isActive: story.isActive, sortOrder: story.sortOrder } });
}));

router.delete("/:id", requireAdminAuth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ success: false, message: "Invalid story ID." });
  const story = await Story.findById(req.params.id);
  if (!story) return res.status(404).json({ success: false, message: "Story not found." });
  if (!canAccessOwnedDocument(req, story)) return res.status(403).json({ success: false, message: "You can only manage stories you created." });
  if (activeStoryIds.has(String(story._id))) return res.status(409).json({ success: false, message: "This story upload is still in progress. Retry deletion after the upload finishes." });
  story.isActive = false;
  story.isPublished = false;
  story.uploadStatus = "cleanup_pending";
  await story.save();
  try {
    await storyVideo.deleteAuthenticatedVideo(story.publicId);
  } catch (_) {
    return res.status(502).json({ success: false, message: "Video deletion failed; the story record was kept so you can retry." });
  }
  await Story.findByIdAndDelete(story._id);
  return res.json({ success: true, message: "Story deleted." });
}));

module.exports = router;
module.exports.parseStoryMetadata = parseStoryMetadata;
module.exports.reserveStoryUploadSlot = reserveStoryUploadSlot;
module.exports.markStoryUploadActive = markStoryUploadActive;
