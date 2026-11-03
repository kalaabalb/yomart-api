const mongoose = require("mongoose");

const paymentProofSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  storageKey: { type: String, required: true, unique: true, select: false },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
  status: { type: String, enum: ["uploaded", "associated", "superseded", "cleanup_pending", "deleted"], default: "uploaded", index: true },
  accessRevokedAt: Date,
  supersededAt: Date,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { timestamps: true });

// There may be many historical proofs per order, but only one active proof.
paymentProofSchema.index({ orderId: 1 }, { unique: true, partialFilterExpression: { status: "associated", orderId: { $type: "objectId" } } });

module.exports = mongoose.model("PaymentProof", paymentProofSchema);
