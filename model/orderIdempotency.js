const mongoose = require("mongoose");

const orderIdempotencySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    key: { type: String, required: true, minlength: 16, maxlength: 128 },
    requestFingerprint: { type: String, required: true, minlength: 64, maxlength: 64 },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
  },
  { timestamps: true },
);

orderIdempotencySchema.index(
  { userId: 1, key: 1 },
  { unique: true, name: "uniq_customer_order_idempotency_key" },
);

module.exports = mongoose.model("OrderIdempotency", orderIdempotencySchema);
