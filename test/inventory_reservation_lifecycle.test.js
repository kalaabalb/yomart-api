const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const mongoose = require("mongoose");
const Order = require("../model/order");
const Product = require("../model/product");
const AdminUser = require("../model/adminUser");
const SecurityAudit = require("../model/securityAudit");
const { issueAdminToken } = require("../middleware/adminAccess");
const {
  validateInventoryReservationMatchesOrder,
} = require("../utils/inventoryReservation");

process.env.JWT_SECRET ||= "synthetic-inventory-reservation-test-secret";

const original = {
  startSession: mongoose.startSession,
  findOrder: Order.findById,
  updateProduct: Product.updateOne,
  findAdmin: AdminUser.findById,
  auditCreate: SecurityAudit.create,
};
const adminId = new mongoose.Types.ObjectId();
const orderId = new mongoose.Types.ObjectId();
const productId = new mongoose.Types.ObjectId();
const otherProductId = new mongoose.Types.ObjectId();
const token = `Bearer ${issueAdminToken({ _id: adminId, clearanceLevel: "admin" })}`;

function createHarness({ historical = false, failSave = false, orderStatus = "pending" } = {}) {
  let order = {
    _id: orderId,
    userID: new mongoose.Types.ObjectId(),
    orderStatus,
    paymentStatus: "pending",
    paymentMethod: "cod",
    paymentMethodSnapshot: { category: "cash_collection", requiresProof: false },
    items: [{ productID: productId, productName: "Synthetic item", quantity: 2, price: 10 }],
    totalPrice: 20,
    ...(historical ? {} : {
      inventoryReservation: {
        state: "reserved",
        items: [{ productID: productId, quantity: 2 }],
        reservedAt: new Date("2026-01-01T00:00:00Z"),
      },
    }),
    async save() {
      if (failSave) throw new Error("synthetic transaction rollback");
      return this;
    },
  };
  const stock = { quantity: 8 };
  const otherStock = { quantity: 15 };
  const stocks = new Map([
    [productId.toString(), stock],
    [otherProductId.toString(), otherStock],
  ]);
  let updateCalls = 0;
  let queue = Promise.resolve();

  const app = express();
  app.use(express.json());
  app.use("/orders", require("../routes/order"));
  app.use("/payment", require("../routes/payment"));
  app.use(require("../middleware/errorHandler"));

  mongoose.startSession = async () => ({
    async withTransaction(callback) {
      const prior = queue;
      let unlock;
      queue = new Promise((resolve) => { unlock = resolve; });
      await prior;
      const orderSnapshot = structuredClone({ ...order, save: undefined });
      const stockSnapshot = stock.quantity;
      try {
        return await callback();
      } catch (error) {
        for (const key of Object.keys(order)) delete order[key];
        Object.assign(order, orderSnapshot);
        order.save = async function save() {
          if (failSave) throw new Error("synthetic transaction rollback");
          return this;
        };
        stock.quantity = stockSnapshot;
        throw error;
      } finally {
        unlock();
      }
    },
    async endSession() {},
  });
  Order.findById = () => ({ session: async () => order });
  Product.updateOne = async (filter, update, options) => {
    assert.ok(filter._id);
    assert.ok(options?.session);
    updateCalls += 1;
    const target = stocks.get(String(filter._id).toLowerCase());
    assert.ok(target);
    target.quantity += update.$inc.quantity;
    return { matchedCount: 1 };
  };
  AdminUser.findById = async (id) => id.toString() === adminId.toString()
    ? { _id: adminId, isActive: true, clearanceLevel: "admin" }
    : null;
  SecurityAudit.create = async () => [];

  const setOrder = (values) => {
    Object.assign(order, values);
  };
  return {
    app,
    order: () => order,
    stock,
    otherStock,
    updateCalls: () => updateCalls,
    setOrder,
    cancel: () => request(app).put(`/orders/${orderId}`).set("Authorization", token).send({ orderStatus: "cancelled" }),
    transition: (orderStatus) => request(app).put(`/orders/${orderId}`).set("Authorization", token).send({ orderStatus }),
    rejectPayment: () => request(app).put(`/orders/${orderId}/verify-payment`).set("Authorization", token).send({ verified: false }),
    rejectPaymentLegacy: () => request(app).post(`/payment/verify-payment/${orderId}`).set("Authorization", token).send({ verified: false }),
  };
}

test.afterEach(() => {
  mongoose.startSession = original.startSession;
  Order.findById = original.findOrder;
  Product.updateOne = original.updateProduct;
  AdminUser.findById = original.findAdmin;
  SecurityAudit.create = original.auditCreate;
});

test("reservation schema is additive and leaves historical orders without an inferred state", () => {
  const legacy = new Order({
    userID: new mongoose.Types.ObjectId(),
    items: [{ productID: productId, productName: "Historical item", quantity: 1, price: 10 }],
    totalPrice: 10,
    paymentMethod: "cod",
  });
  assert.equal(legacy.inventoryReservation?.state, undefined);

  const current = new Order({
    userID: new mongoose.Types.ObjectId(),
    items: [{ productID: productId, productName: "Synthetic item", quantity: 2, price: 10 }],
    totalPrice: 20,
    paymentMethod: "cod",
    inventoryReservation: {
      state: "reserved",
      items: [{ productID: productId, quantity: 2 }],
      reservedAt: new Date(),
    },
  });
  assert.equal(current.validateSync(), undefined);
  assert.equal(current.toObject().inventoryReservation.state, "reserved");
});

const validId = productId.toHexString();
const otherId = otherProductId.toHexString();
const reservationOrder = (items, reservationItems = items) => ({
  items: items.map(([id, quantity]) => ({ productID: id, quantity })),
  inventoryReservation: {
    state: "reserved",
    items: reservationItems.map(([id, quantity]) => ({ productID: id, quantity })),
  },
});

const inconsistentReservations = [
  ["different valid product", reservationOrder([[validId, 2]], [[otherId, 2]])],
  ["larger marker quantity", reservationOrder([[validId, 2]], [[validId, 3]])],
  ["smaller marker quantity", reservationOrder([[validId, 3]], [[validId, 2]])],
  ["omitted order product", reservationOrder([[validId, 1], [otherId, 2]], [[validId, 1]])],
  ["extra marker product", reservationOrder([[validId, 1]], [[validId, 1], [otherId, 1]])],
];

for (const [label, order] of inconsistentReservations) {
  test(`reservation validator rejects ${label}`, () => {
    assert.throws(() => validateInventoryReservationMatchesOrder(order), { statusCode: 409 });
    assert.equal(order.inventoryReservation.state, "reserved");
  });
}

test("duplicate order lines aggregate by normalized product ID", () => {
  const order = reservationOrder([[validId, 1], [productId, 2]], [[productId, 3]]);
  const totals = validateInventoryReservationMatchesOrder(order);
  assert.deepEqual([...totals], [[validId, 3]]);
});

test("duplicate marker entries aggregate when they match the order total", () => {
  const order = reservationOrder([[productId, 3]], [[validId.toUpperCase(), 1], [productId, 2]]);
  const totals = validateInventoryReservationMatchesOrder(order);
  assert.deepEqual([...totals], [[validId, 3]]);
});

for (const [label, value] of [
  ["empty string ID", ""],
  ["malformed ID", "not-an-object-id"],
  ["12-character ID", "abcdefghijkl"],
]) {
  test(`reservation validator rejects ${label}`, () => {
    assert.throws(() => validateInventoryReservationMatchesOrder(reservationOrder([[value, 1]])), { statusCode: 409 });
  });
}

for (const [label, value] of [
  ["zero", 0],
  ["negative", -1],
  ["fractional", 1.5],
  ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ["numeric string", "2"],
  ["missing", undefined],
]) {
  test(`reservation validator rejects ${label} quantity`, () => {
    assert.throws(() => validateInventoryReservationMatchesOrder(reservationOrder([[validId, value]])), { statusCode: 409 });
  });
}

test("reservation validator rejects empty order and marker item lists", () => {
  assert.throws(() => validateInventoryReservationMatchesOrder(reservationOrder([], [])), { statusCode: 409 });
  assert.throws(() => validateInventoryReservationMatchesOrder(reservationOrder([[validId, 1]], [])), { statusCode: 409 });
});

test("new-order cancellation restores its exact reservation and records the release", async () => {
  const h = createHarness();
  const response = await h.cancel();
  assert.equal(response.status, 200);
  assert.equal(h.stock.quantity, 10);
  assert.equal(h.order().inventoryReservation.state, "released");
  assert.equal(h.order().inventoryReservation.releaseReason, "cancelled");
  assert.equal(h.updateCalls(), 1);
});

test("payment rejection restores the reservation in the payment transaction", async () => {
  const h = createHarness();
  h.setOrder({
    orderStatus: "payment_pending",
    paymentMethod: "manual-bank-transfer",
    paymentMethodSnapshot: { category: "bank_transfer", requiresProof: true },
    paymentProof: { imageUrl: "synthetic-proof-reference" },
  });
  const response = await h.rejectPayment();
  assert.equal(response.status, 200);
  assert.equal(h.order().paymentStatus, "failed");
  assert.equal(h.order().orderStatus, "cancelled");
  assert.equal(h.order().inventoryReservation.state, "released");
  assert.equal(h.order().inventoryReservation.releaseReason, "payment_rejected");
  assert.equal(h.stock.quantity, 10);
  assert.equal(h.updateCalls(), 1);

  const retry = await h.rejectPayment();
  assert.equal(retry.status, 409);
  assert.equal(h.stock.quantity, 10);
  assert.equal(h.updateCalls(), 1);
});

test("legacy payment-review route also releases new reservations on rejection", async () => {
  const h = createHarness();
  h.setOrder({
    orderStatus: "payment_pending",
    paymentMethod: "manual-wallet-transfer",
    paymentMethodSnapshot: { category: "mobile_wallet", requiresProof: true },
    paymentProof: { imageUrl: "synthetic-proof-reference" },
  });
  const response = await h.rejectPaymentLegacy();
  assert.equal(response.status, 200);
  assert.equal(h.order().inventoryReservation.state, "released");
  assert.equal(h.order().inventoryReservation.releaseReason, "payment_rejected");
  assert.equal(h.stock.quantity, 10);
});

test("duplicate cancellation is a no-op after the first stock release", async () => {
  const h = createHarness();
  assert.equal((await h.cancel()).status, 200);
  assert.equal((await h.cancel()).status, 200);
  assert.equal(h.stock.quantity, 10);
  assert.equal(h.updateCalls(), 1);
});

test("concurrent cancellation requests release a reservation exactly once", async () => {
  const h = createHarness();
  const responses = await Promise.all([h.cancel(), h.cancel()]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.equal(h.stock.quantity, 10);
  assert.equal(h.updateCalls(), 1);
});

test("concurrent cancellation and fulfillment cannot commit incompatible order states", async () => {
  const h = createHarness({ orderStatus: "processing" });
  h.setOrder({ collectionPoint: { name: "Agreed point", address: "Synthetic address", city: "Bahir Dar" } });
  const [cancelled, readied] = await Promise.all([h.cancel(), h.transition("ready_for_collection")]);
  assert.equal(cancelled.status, 200);
  assert.equal(readied.status, 409);
  assert.equal(h.order().orderStatus, "cancelled");
  assert.equal(h.order().inventoryReservation.state, "released");
  assert.equal(h.stock.quantity, 10);
  assert.equal(h.updateCalls(), 1);
});

test("successful collection consumes the reservation without restoring stock", async () => {
  const h = createHarness();
  h.setOrder({
    orderStatus: "processing",
    collectionPoint: { name: "Agreed point", address: "Synthetic address", city: "Bahir Dar" },
  });
  const ready = await h.transition("ready_for_collection");
  assert.equal(ready.status, 200);
  const collected = await h.transition("collected");
  assert.equal(collected.status, 200);
  assert.equal(h.order().inventoryReservation.state, "consumed");
  assert.ok(h.order().inventoryReservation.consumedAt instanceof Date);
  assert.equal(h.stock.quantity, 8);
  assert.equal(h.updateCalls(), 0);
});

test("successful delivery consumes the reservation without restoring stock", async () => {
  const h = createHarness();
  h.setOrder({ orderStatus: "processing" });
  const delivered = await h.transition("delivered");
  assert.equal(delivered.status, 200);
  assert.equal(h.order().inventoryReservation.state, "consumed");
  assert.ok(h.order().inventoryReservation.consumedAt instanceof Date);
  assert.equal(h.stock.quantity, 8);
  assert.equal(h.updateCalls(), 0);
});

test("inconsistent reservation release fails closed and retry cannot change stock or order", async () => {
  const h = createHarness();
  h.setOrder({
    items: [{ productID: productId, productName: "Synthetic item", quantity: 2, price: 10 }],
    inventoryReservation: {
      state: "reserved",
      items: [{ productID: otherProductId, quantity: 2 }],
      reservedAt: new Date(),
    },
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal((await h.cancel()).status, 409);
    assert.equal(h.stock.quantity, 8);
    assert.equal(h.otherStock.quantity, 15);
    assert.equal(h.order().orderStatus, "pending");
    assert.equal(h.order().inventoryReservation.state, "reserved");
    assert.equal(h.updateCalls(), 0);
  }
});

const routeMismatchCases = [
  ["larger quantity", [[productId, 2]], [[productId, 3]]],
  ["smaller quantity", [[productId, 3]], [[productId, 2]]],
  ["omitted product", [[productId, 1], [otherProductId, 2]], [[productId, 1]]],
  ["extra product", [[productId, 1]], [[productId, 1], [otherProductId, 1]]],
  ["invalid product ID", [[productId, 1]], [["", 1]]],
  ["invalid quantity", [[productId, 2]], [[productId, 0]]],
];

for (const [label, orderLines, markerLines] of routeMismatchCases) {
  test(`cancellation with ${label} leaves all stock and order state unchanged`, async () => {
    const h = createHarness();
    h.setOrder({
      items: orderLines.map(([id, quantity]) => ({ productID: id, productName: "Synthetic item", quantity, price: 10 })),
      inventoryReservation: {
        state: "reserved",
        items: markerLines.map(([id, quantity]) => ({ productID: id, quantity })),
      },
    });

    const response = await h.cancel();
    assert.equal(response.status, 409);
    assert.equal(h.stock.quantity, 8);
    assert.equal(h.otherStock.quantity, 15);
    assert.equal(h.order().orderStatus, "pending");
    assert.equal(h.order().inventoryReservation.state, "reserved");
    assert.equal(h.updateCalls(), 0);
  });
}

test("payment rejection with an inconsistent reservation preserves payment, order and stock state", async () => {
  const h = createHarness();
  h.setOrder({
    orderStatus: "payment_pending",
    paymentMethod: "manual-bank-transfer",
    paymentMethodSnapshot: { category: "bank_transfer", requiresProof: true },
    paymentProof: { imageUrl: "synthetic-proof-reference" },
    items: [{ productID: productId, productName: "Synthetic item", quantity: 2, price: 10 }],
    inventoryReservation: {
      state: "reserved",
      items: [{ productID: otherProductId, quantity: 2 }],
    },
  });

  const response = await h.rejectPayment();
  assert.equal(response.status, 409);
  assert.equal(h.stock.quantity, 8);
  assert.equal(h.otherStock.quantity, 15);
  assert.equal(h.order().orderStatus, "payment_pending");
  assert.equal(h.order().paymentStatus, "pending");
  assert.equal(h.order().inventoryReservation.state, "reserved");
  assert.equal(h.updateCalls(), 0);
});

test("inconsistent reservation consumption fails closed without changing order or stock", async () => {
  const h = createHarness({ orderStatus: "processing" });
  h.setOrder({
    items: [{ productID: productId, productName: "Synthetic item", quantity: 2, price: 10 }],
    inventoryReservation: {
      state: "reserved",
      items: [{ productID: productId, quantity: 1 }],
      reservedAt: new Date(),
    },
  });

  const response = await h.transition("delivered");
  assert.equal(response.status, 409);
  assert.equal(h.stock.quantity, 8);
  assert.equal(h.otherStock.quantity, 15);
  assert.equal(h.order().orderStatus, "processing");
  assert.equal(h.order().inventoryReservation.state, "reserved");
  assert.equal(h.updateCalls(), 0);
});

test("historical orders without a reservation fail closed and are never restocked", async () => {
  const h = createHarness({ historical: true });
  const response = await h.cancel();
  assert.equal(response.status, 409);
  assert.equal(h.order().orderStatus, "pending");
  assert.equal(h.order().inventoryReservation, undefined);
  assert.equal(h.stock.quantity, 8);
  assert.equal(h.updateCalls(), 0);
});

test("historical delivery without a reservation cannot change the order status", async () => {
  const h = createHarness({ historical: true, orderStatus: "processing" });
  const response = await h.transition("delivered");
  assert.equal(response.status, 409);
  assert.equal(h.order().orderStatus, "processing");
  assert.equal(h.order().inventoryReservation, undefined);
  assert.equal(h.stock.quantity, 8);
  assert.equal(h.otherStock.quantity, 15);
  assert.equal(h.updateCalls(), 0);
});

test("a transaction failure rolls back stock and the cancellation marker", async () => {
  const h = createHarness({ failSave: true });
  const response = await h.cancel();
  assert.equal(response.status, 500);
  assert.equal(h.stock.quantity, 8);
  assert.equal(h.order().orderStatus, "pending");
  assert.equal(h.order().inventoryReservation.state, "reserved");
  assert.equal(h.updateCalls(), 1);
});
