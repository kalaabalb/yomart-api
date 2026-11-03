const mongoose = require("mongoose");

const storySchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 80 },
  subtitle: { type: String, trim: true, maxlength: 140, default: "" },
  publicId: {
    type: String,
    required: true,
    unique: true,
    immutable: true,
    match: /^yomart\/stories\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  },
  uploadStatus: { type: String, enum: ["uploading", "ready", "cleanup_pending"], default: "uploading" },
  resourceType: { type: String, enum: ["video"], default: "video", immutable: true },
  format: { type: String, enum: ["mp4", "webm"], required: true, immutable: true },
  durationSeconds: { type: Number, min: 0.01, required: true, immutable: true },
  bytes: { type: Number, min: 1, required: true, immutable: true },
  width: { type: Number, min: 1, default: null, immutable: true },
  height: { type: Number, min: 1, default: null, immutable: true },
  isPublished: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  sortOrder: { type: Number, min: 0, default: 0 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "AdminUser", required: true },
}, { timestamps: true });

storySchema.index({ uploadStatus: 1, isActive: 1, isPublished: 1, sortOrder: 1 });
module.exports = mongoose.model("Story", storySchema);
