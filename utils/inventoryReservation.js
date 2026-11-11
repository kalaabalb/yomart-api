const mongoose = require("mongoose");

function reservationError(message = "The inventory reservation does not match the order and requires review.") {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

function normalizeProductId(value) {
  let id;
  if (typeof value === "string") id = value;
  else if (value && typeof value.toHexString === "function") id = value.toHexString();
  else return null;

  return /^[0-9a-f]{24}$/i.test(id) && mongoose.isValidObjectId(id)
    ? id.toLowerCase()
    : null;
}

function aggregateItems(items, label) {
  if (!Array.isArray(items) || items.length === 0) {
    throw reservationError(`${label} must contain at least one valid item.`);
  }

  const quantities = new Map();
  for (const item of items) {
    const productId = normalizeProductId(item?.productID);
    const quantity = item?.quantity;
    if (!productId || typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 1) {
      throw reservationError(`${label} contains an invalid product identity or quantity.`);
    }

    const aggregate = (quantities.get(productId) || 0) + quantity;
    if (!Number.isSafeInteger(aggregate)) {
      throw reservationError(`${label} contains an invalid aggregate quantity.`);
    }
    // Duplicate lines are valid in both persisted arrays; canonicalize and
    // aggregate them so equality is based on the actual reserved total.
    quantities.set(productId, aggregate);
  }
  return quantities;
}

/**
 * Validate the persisted reservation snapshot against the persisted order
 * lines. The returned map contains one canonical ObjectId and total quantity
 * per product. This function performs no database writes.
 */
function validateInventoryReservationMatchesOrder(order) {
  const reservation = order?.inventoryReservation;
  if (!reservation || typeof reservation !== "object" || Array.isArray(reservation)) {
    throw reservationError("This order has no verifiable inventory reservation.");
  }
  if (!["reserved", "released", "consumed"].includes(reservation.state)) {
    throw reservationError("The inventory reservation state is invalid.");
  }

  const orderQuantities = aggregateItems(order?.items, "The persisted order");
  const reservationQuantities = aggregateItems(reservation.items, "The inventory reservation");
  if (orderQuantities.size !== reservationQuantities.size) {
    throw reservationError();
  }
  for (const [productId, quantity] of orderQuantities) {
    if (reservationQuantities.get(productId) !== quantity) {
      throw reservationError();
    }
  }
  return reservationQuantities;
}

/**
 * Restore stock only for an order with an explicit, still-reserved marker.
 * Call inside the transaction that saves the status change. Historical orders
 * without verifiable reservation evidence fail closed and are never inferred.
 */
async function releaseInventoryReservation(order, { Product, session, reason, now = new Date() }) {
  const reservation = order?.inventoryReservation;
  const quantities = validateInventoryReservationMatchesOrder(order);

  if (reservation.state === "released") {
    return { released: false, state: "released" };
  }
  if (reservation.state !== "reserved") {
    throw reservationError("A consumed inventory reservation cannot be released.");
  }
  if (!Product || !session || !["cancelled", "payment_rejected"].includes(reason)) {
    throw reservationError("The inventory reservation cannot be safely released.");
  }

  for (const [productId, quantity] of quantities) {
    const result = await Product.updateOne(
      { _id: productId },
      { $inc: { quantity } },
      { session },
    );
    const matchedCount = result?.matchedCount ?? result?.n ?? 0;
    if (matchedCount !== 1) {
      throw reservationError("A reserved product is unavailable; cancellation was not applied.");
    }
  }

  reservation.state = "released";
  reservation.releasedAt = now;
  reservation.releaseReason = reason;
  reservation.consumedAt = undefined;
  return { released: true, state: "released" };
}

/** Validate and mark a reservation consumed on handoff without changing stock. */
function consumeInventoryReservation(order, { now = new Date() } = {}) {
  const reservation = order?.inventoryReservation;
  validateInventoryReservationMatchesOrder(order);

  if (reservation.state === "consumed") {
    return { consumed: false, state: "consumed" };
  }
  if (reservation.state !== "reserved") {
    throw reservationError("A released inventory reservation cannot be consumed.");
  }

  reservation.state = "consumed";
  reservation.consumedAt = now;
  reservation.releasedAt = undefined;
  reservation.releaseReason = undefined;
  return { consumed: true, state: "consumed" };
}

module.exports = {
  releaseInventoryReservation,
  consumeInventoryReservation,
  validateInventoryReservationMatchesOrder,
};
