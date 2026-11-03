const mongoose = require("mongoose");

const proofCleanupJobSchema = new mongoose.Schema({
  proofId: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentProof", required: true, unique: true },
  reason: { type: String, enum: ["orphaned_upload", "superseded"], required: true },
  state: { type: String, enum: ["pending", "processing", "retry", "complete", "retained"], default: "pending", index: true },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  leaseId: { type: String, default: null },
  leaseExpiresAt: { type: Date, default: null },
  lastErrorCode: { type: String },
  lastAttemptAt: Date,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model("ProofCleanupJob", proofCleanupJobSchema);
