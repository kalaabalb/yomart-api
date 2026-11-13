const mongoose = require("mongoose");

const supportContentSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 100 },
  body: { type: String, required: true, trim: true, maxlength: 4000 },
  sortOrder: { type: Number, min: 0, max: 100000, default: 0 },
  isActive: { type: Boolean, default: false },
}, { timestamps: true });

supportContentSchema.index({ isActive: 1, sortOrder: 1, _id: 1 });

module.exports = mongoose.model("SupportContent", supportContentSchema);
