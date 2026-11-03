const mongoose = require("mongoose");

const securityAuditSchema = new mongoose.Schema({
  action: { type: String, enum: ["proof_associated", "proof_replaced", "payment_verified", "payment_rejected"], required: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, index: true },
  actorId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  actorRole: { type: String, enum: ["user", "admin", "super_admin"], required: true },
  oldProofId: mongoose.Schema.Types.ObjectId,
  newProofId: mongoose.Schema.Types.ObjectId,
  createdAt: { type: Date, default: Date.now, immutable: true },
}, { versionKey: false });

module.exports = mongoose.model("SecurityAudit", securityAuditSchema);
