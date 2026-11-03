const ORDER_STATUSES = Object.freeze([
  "pending",
  "processing",
  "shipped",
  "delivered", // Retained for historical orders.
  "cancelled",
  "payment_pending",
  "payment_verified",
  "ready_for_collection",
  "collected",
]);

const STATUS_TRANSITIONS = Object.freeze({
  pending: ["processing", "cancelled"],
  payment_pending: ["payment_verified", "cancelled"],
  payment_verified: ["processing", "cancelled"],
  processing: ["shipped", "ready_for_collection", "delivered", "cancelled"],
  shipped: ["ready_for_collection", "delivered"],
  ready_for_collection: ["collected"],
  delivered: [],
  collected: [],
  cancelled: [],
});

function normalizeCollectionPoint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const name = typeof value.name === "string" ? value.name.trim().slice(0, 120) : "";
  const address = typeof value.address === "string" ? value.address.trim().slice(0, 240) : "";
  const city = typeof value.city === "string" ? value.city.trim().slice(0, 100) : "";
  if (!name || !address || !city) return null;
  return { name, address, city };
}

function canTransitionOrderStatus(current, next) {
  return current === next || Boolean(STATUS_TRANSITIONS[current]?.includes(next));
}

module.exports = { ORDER_STATUSES, STATUS_TRANSITIONS, normalizeCollectionPoint, canTransitionOrderStatus };
