const mongoose = require("mongoose");

const posterSchema = new mongoose.Schema(
  {
    posterName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    subtitle: { type: String, trim: true, maxlength: 160, default: "" },
    sortOrder: { type: Number, min: 0, default: 0 },
    isActive: { type: Boolean, default: true },
    imageUrl: {
      type: String,
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdminUser",
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("Poster", posterSchema);
