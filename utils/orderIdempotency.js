const crypto = require("crypto");

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

class IdempotencyConflictError extends Error {
  constructor(message = "This idempotency key was already used for a different checkout.") {
    super(message);
    this.name = "IdempotencyConflictError";
    this.statusCode = 409;
  }
}

function normalizeIdempotencyKey(value) {
  if (typeof value !== "string") return null;
  const key = value.trim();
  return IDEMPOTENCY_KEY_PATTERN.test(key) ? key : null;
}

function createOrderRequestFingerprint({ items, shippingAddress, paymentMethod, paymentProof }) {
  const secret = process.env.ORDER_IDEMPOTENCY_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error("Order idempotency fingerprint secret is not configured.");
  const canonicalRequest = JSON.stringify({
    items: items.map(({ productID, quantity, variant }) => ({ productID: String(productID), quantity, variant })),
    shippingAddress: {
      phone: shippingAddress.phone,
      street: shippingAddress.street,
      city: shippingAddress.city,
      state: shippingAddress.state,
      country: shippingAddress.country,
      latitude: shippingAddress.latitude,
      longitude: shippingAddress.longitude,
    },
    paymentMethod,
    paymentProof: paymentMethod === "cod" ? null : {
      proofRecordId: paymentProof?.proofRecordId || null,
    },
  });
  return crypto.createHmac("sha256", secret).update(canonicalRequest).digest("hex");
}

let indexPromise;
async function ensureOrderIdempotencyIndex(OrderIdempotency) {
  if (!indexPromise) {
    indexPromise = OrderIdempotency.collection.createIndex(
      { userId: 1, key: 1 },
      { unique: true, name: "uniq_customer_order_idempotency_key" },
    ).catch((error) => {
      indexPromise = null;
      throw error;
    });
  }
  return indexPromise;
}

async function findIdempotentOrder({ OrderIdempotency, Order, userId, key, requestFingerprint }) {
  const record = await OrderIdempotency.findOne({ userId, key });
  if (!record) return null;
  if (record.requestFingerprint !== requestFingerprint) throw new IdempotencyConflictError();

  const order = await Order.findOne({ _id: record.orderId, userID: userId });
  if (!order) {
    const error = new Error("The previous checkout result is unavailable.");
    error.statusCode = 503;
    throw error;
  }
  return order;
}

function isDuplicateKeyError(error) {
  return error?.code === 11000 || error?.code === "E11000";
}

module.exports = {
  IDEMPOTENCY_KEY_PATTERN,
  IdempotencyConflictError,
  normalizeIdempotencyKey,
  createOrderRequestFingerprint,
  ensureOrderIdempotencyIndex,
  findIdempotentOrder,
  isDuplicateKeyError,
};
