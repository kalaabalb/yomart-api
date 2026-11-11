const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const mongoose = require("mongoose");
const Order = require("../model/order");
const OrderIdempotency = require("../model/orderIdempotency");
const Product = require("../model/product");
const StoreSettings = require("../model/storeSettings");
const User = require("../model/user");
const { issueUserToken } = require("../middleware/adminAccess");
const { normalizeIdempotencyKey } = require("../utils/orderIdempotency");

process.env.JWT_SECRET ||= "synthetic-order-idempotency-test-secret";

const originals = {
  index: OrderIdempotency.collection.createIndex,
  idemFind: OrderIdempotency.findOne,
  idemCreate: OrderIdempotency.create,
  orderFindOne: Order.findOne,
  orderCreate: Order.create,
  productUpdate: Product.findOneAndUpdate,
  settingsFindOne: StoreSettings.findOne,
  userFindById: User.findById,
  userFindOne: User.findOne,
  startSession: mongoose.startSession,
};

function makeHarness() {
  const customers = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  const productId = new mongoose.Types.ObjectId();
  const products = new Map([[productId.toString(), { _id: productId, name: "Synthetic phone", price: 100, offerPrice: 90, quantity: 5, isActive: true }]]);
  const orders = new Map();
  const records = new Map();
  let orderCreateFailure = false;
  let lock = Promise.resolve();
  const app = express();
  app.use(express.json());
  app.use("/orders", require("../routes/order"));

  OrderIdempotency.collection.createIndex = async () => "uniq_customer_order_idempotency_key";
  OrderIdempotency.findOne = async ({ userId, key }) => records.get(`${userId}:${key}`) || null;
  OrderIdempotency.create = async ([record]) => {
    const index = `${record.userId}:${record.key}`;
    if (records.has(index)) {
      const error = new Error("duplicate");
      error.code = 11000;
      throw error;
    }
    records.set(index, record);
    return [record];
  };
  Order.findOne = async ({ _id, userID }) => {
    const order = orders.get(String(_id));
    return order && String(order.userID) === String(userID) ? order : null;
  };
  Order.create = async ([order]) => {
    if (orderCreateFailure) {
      orderCreateFailure = false;
      throw new Error("synthetic transaction failure");
    }
    const created = { ...order, _id: order._id || new mongoose.Types.ObjectId() };
    orders.set(String(created._id), created);
    return [created];
  };
  Product.findOneAndUpdate = async (filter, update) => {
    const product = products.get(String(filter._id));
    if (!product || product.quantity < filter.quantity.$gte || product.isActive === false) return null;
    product.quantity += update.$inc.quantity;
    return { ...product };
  };
  let paymentMethods = [{ code: "cod", name: "Cash at collection", title: "Cash at collection", category: "cash_collection", requiresProof: false, enabled: true }];
  StoreSettings.findOne = async () => ({ deliveryFee: 250, paymentMethods });
  User.findById = async (id) => customers.some((customer) => customer.toString() === String(id))
    ? { _id: id, accountStatus: "active" }
    : null;
  User.findOne = () => ({ session: async () => ({ accountStatus: "active" }) });
  mongoose.startSession = async () => ({
    async withTransaction(operation) {
      const previous = lock;
      let unlock;
      lock = new Promise((resolve) => { unlock = resolve; });
      await previous;
      const productSnapshot = new Map([...products].map(([id, product]) => [id, { ...product }]));
      const recordSnapshot = new Map(records);
      const orderSnapshot = new Map(orders);
      try { await operation(this); }
      catch (error) {
        products.clear(); productSnapshot.forEach((value, key) => products.set(key, value));
        records.clear(); recordSnapshot.forEach((value, key) => records.set(key, value));
        orders.clear(); orderSnapshot.forEach((value, key) => orders.set(key, value));
        throw error;
      } finally { unlock(); }
    },
    async endSession() {},
  });
  return { app, customers, productId, products, orders, records, setPaymentMethods(value) { paymentMethods = value; }, failNextOrderCreate() { orderCreateFailure = true; } };
}

test.afterEach(() => {
  OrderIdempotency.collection.createIndex = originals.index;
  OrderIdempotency.findOne = originals.idemFind;
  OrderIdempotency.create = originals.idemCreate;
  Order.findOne = originals.orderFindOne;
  Order.create = originals.orderCreate;
  Product.findOneAndUpdate = originals.productUpdate;
  StoreSettings.findOne = originals.settingsFindOne;
  User.findById = originals.userFindById;
  User.findOne = originals.userFindOne;
  mongoose.startSession = originals.startSession;
});

function checkout(harness, customer, key, quantity = 2, paymentMethod = "cod") {
  return request(harness.app).post("/orders")
    .set("Authorization", `Bearer ${issueUserToken({ _id: customer })}`)
    .set("Idempotency-Key", key)
    .send({
      items: [{ productID: harness.productId.toString(), quantity, price: 0.01 }],
      totalPrice: 0.01,
      shippingAddress: { phone: "5550000", street: "Synthetic street", city: "Test city" },
      paymentMethod,
    });
}

test("database schema has a unique per-customer idempotency constraint and validates key shape", () => {
  const uniqueIndex = OrderIdempotency.schema.indexes().find(([keys, options]) =>
    keys.userId === 1 && keys.key === 1 && options.unique === true,
  );
  assert.ok(uniqueIndex, "idempotency must rely on a database unique index");
  assert.equal(normalizeIdempotencyKey("00000000-0000-4000-8000-000000000000"), "00000000-0000-4000-8000-000000000000");
  assert.equal(normalizeIdempotencyKey("short"), null);
  assert.equal(normalizeIdempotencyKey("bad key that contains spaces"), null);
});

test("duplicate retry returns the first order and decrements stock exactly once", async () => {
  const harness = makeHarness();
  const buyer = harness.customers[0];
  const key = "00000000-0000-4000-8000-000000000001";
  const first = await checkout(harness, buyer, key);
  const retry = await checkout(harness, buyer, key);
  assert.equal(first.statusCode, 200);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.body.data._id.toString(), first.body.data._id.toString());
  assert.equal(harness.orders.size, 1);
  assert.equal(harness.products.get(harness.productId.toString()).quantity, 3);
  assert.equal(first.body.data.inventoryReservation.state, "reserved");
  assert.equal(first.body.data.inventoryReservation.items[0].productID.toString(), harness.productId.toString());
  assert.equal(first.body.data.inventoryReservation.items[0].quantity, 2);
  assert.equal(retry.body.data.inventoryReservation.state, "reserved");
  assert.equal(first.body.data.orderTotal.delivery, 0);
  assert.equal(first.body.data.orderTotal.total, 180);
});

test("dynamic non-proof methods are accepted and an order keeps its original payment snapshot after edits", async () => {
  const harness = makeHarness();
  harness.setPaymentMethods([{
    code: "manual-confirmation-74", name: "Manual confirmation", title: "Manual confirmation",
    description: "Coordinate directly", category: "other", additionalDetails: "Synthetic detail",
    requiresProof: false, enabled: true,
  }]);
  const first = await checkout(harness, harness.customers[0], "dynamic-payment-key-01", 1, "manual-confirmation-74");
  assert.equal(first.status, 200);
  assert.equal(first.body.data.paymentMethod, "manual-confirmation-74");
  assert.equal(first.body.data.paymentMethodSnapshot.name, "Manual confirmation");
  assert.equal(first.body.data.paymentMethodSnapshot.requiresProof, false);
  assert.equal(Object.hasOwn(first.body.data, "paymentProof"), false);

  harness.setPaymentMethods([{
    code: "manual-confirmation-74", name: "Updated confirmation", title: "Updated confirmation",
    category: "other", additionalDetails: "Changed later", requiresProof: false, enabled: false,
  }]);
  const retry = await checkout(harness, harness.customers[0], "dynamic-payment-key-01", 1, "manual-confirmation-74");
  assert.equal(retry.status, 200);
  assert.equal(retry.body.data.paymentMethodSnapshot.name, "Manual confirmation");
  assert.equal(retry.body.data.paymentMethodSnapshot.additionalDetails, "Synthetic detail");
});

test("dynamic proof-required methods reject missing proof and inactive methods are unavailable", async () => {
  const harness = makeHarness();
  harness.setPaymentMethods([{
    code: "bank-transfer-custom", name: "Configured bank", title: "Configured bank",
    category: "bank_transfer", providerName: "Synthetic provider", accountIdentifier: "synthetic-account",
    requiresProof: true, enabled: true,
  }]);
  const missingProof = await checkout(harness, harness.customers[0], "dynamic-proof-key-01", 1, "bank-transfer-custom");
  assert.equal(missingProof.status, 400);
  assert.equal(harness.products.get(harness.productId.toString()).quantity, 5);
  harness.setPaymentMethods([]);
  const inactive = await checkout(harness, harness.customers[0], "dynamic-inactive-key-01", 1, "bank-transfer-custom");
  assert.equal(inactive.status, 400);
  assert.equal(harness.products.get(harness.productId.toString()).quantity, 5);
});

test("order accepts an optional area and ignores customer-supplied collection point data", async () => {
  const harness = makeHarness();
  const response = await request(harness.app).post("/orders")
    .set("Authorization", `Bearer ${issueUserToken({ _id: harness.customers[0] })}`)
    .set("Idempotency-Key", "00000000-0000-4000-8000-000000000011")
    .send({
      items: [{ productID: harness.productId, quantity: 1 }],
      shippingAddress: { phone: "5550000", city: "Test city", latitude: 11.5, longitude: 37.4 },
      collectionPoint: { name: "Customer supplied", address: "Untrusted", city: "Test" },
      orderStatus: "collected",
      paymentMethod: "cod",
    });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.data.shippingAddress.street, "");
  assert.equal(response.body.data.collectionPoint, undefined);
  assert.equal(response.body.data.orderStatus, "pending");
  assert.equal(response.body.data.orderTotal.delivery, 0);
});

test("blank optional coordinates stay absent and malformed coordinate pairs are rejected", async () => {
  const harness = makeHarness();
  const blank = await request(harness.app).post("/orders")
    .set("Authorization", `Bearer ${issueUserToken({ _id: harness.customers[0] })}`)
    .set("Idempotency-Key", "00000000-0000-4000-8000-000000000014")
    .send({ items: [{ productID: harness.productId, quantity: 1 }], shippingAddress: { phone: "555", city: "City", latitude: null, longitude: null }, paymentMethod: "cod" });
  assert.equal(blank.statusCode, 200);
  assert.equal(blank.body.data.shippingAddress.latitude, undefined);
  const invalid = await request(harness.app).post("/orders")
    .set("Authorization", `Bearer ${issueUserToken({ _id: harness.customers[1] })}`)
    .set("Idempotency-Key", "00000000-0000-4000-8000-000000000015")
    .send({ items: [{ productID: harness.productId, quantity: 1 }], shippingAddress: { phone: "555", city: "City", latitude: 95, longitude: 200 }, paymentMethod: "cod" });
  assert.equal(invalid.statusCode, 400);
});

test("order creation rejects missing phone or destination city", async () => {
  const harness = makeHarness();
  for (const shippingAddress of [
    { city: "Test city" },
    { phone: "5550000" },
  ]) {
    const response = await request(harness.app).post("/orders")
      .set("Authorization", `Bearer ${issueUserToken({ _id: harness.customers[0] })}`)
      .set("Idempotency-Key", `00000000-0000-4000-8000-00000000001${shippingAddress.phone ? "2" : "3"}`)
      .send({ items: [{ productID: harness.productId, quantity: 1 }], shippingAddress, paymentMethod: "cod" });
    assert.equal(response.statusCode, 400);
  }
});

test("same customer/key with changed contents is rejected without another stock change", async () => {
  const harness = makeHarness();
  const key = "00000000-0000-4000-8000-000000000002";
  assert.equal((await checkout(harness, harness.customers[0], key, 1)).statusCode, 200);
  const changed = await checkout(harness, harness.customers[0], key, 2);
  assert.equal(changed.statusCode, 409);
  assert.equal(harness.orders.size, 1);
  assert.equal(harness.products.get(harness.productId.toString()).quantity, 4);
});

test("concurrent identical submissions commit one order and one stock decrement", async () => {
  const harness = makeHarness();
  const key = "00000000-0000-4000-8000-000000000003";
  const results = await Promise.all([
    checkout(harness, harness.customers[0], key),
    checkout(harness, harness.customers[0], key),
  ]);
  assert.deepEqual(results.map((result) => result.statusCode), [200, 200]);
  assert.equal(results[0].body.data._id.toString(), results[1].body.data._id.toString());
  assert.equal(harness.orders.size, 1);
  assert.equal(harness.products.get(harness.productId.toString()).quantity, 3);
});

test("concurrent reuse of one key for different contents rejects the losing request", async () => {
  const harness = makeHarness();
  const key = "00000000-0000-4000-8000-000000000007";
  const results = await Promise.all([
    checkout(harness, harness.customers[0], key, 1),
    checkout(harness, harness.customers[0], key, 2),
  ]);
  assert.deepEqual(results.map((result) => result.statusCode).sort(), [200, 409]);
  assert.equal(harness.orders.size, 1);
  const committedQuantity = results.find((result) => result.statusCode === 200).body.data.items[0].quantity;
  assert.equal(harness.products.get(harness.productId.toString()).quantity, 5 - committedQuantity);
});

test("idempotency keys are isolated by customer", async () => {
  const harness = makeHarness();
  const key = "00000000-0000-4000-8000-000000000004";
  const first = await checkout(harness, harness.customers[0], key, 1);
  const second = await checkout(harness, harness.customers[1], key, 1);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.notEqual(first.body.data._id.toString(), second.body.data._id.toString());
  assert.equal(harness.orders.size, 2);
  assert.equal(harness.products.get(harness.productId.toString()).quantity, 3);
});

test("failed transaction rolls back its key, order, and stock so same-key retry can succeed", async () => {
  const harness = makeHarness();
  const key = "00000000-0000-4000-8000-000000000005";
  harness.failNextOrderCreate();
  const failed = await checkout(harness, harness.customers[0], key, 2);
  assert.equal(failed.statusCode, 500);
  assert.equal(harness.orders.size, 0);
  assert.equal(harness.records.size, 0);
  assert.equal(harness.products.get(harness.productId.toString()).quantity, 5);
  const retry = await checkout(harness, harness.customers[0], key, 2);
  assert.equal(retry.statusCode, 200);
  assert.equal(harness.orders.size, 1);
  assert.equal(harness.products.get(harness.productId.toString()).quantity, 3);
});

test("order detail remains restricted to its owner", async () => {
  const harness = makeHarness();
  const key = "00000000-0000-4000-8000-000000000006";
  const created = await checkout(harness, harness.customers[0], key, 1);
  const originalFindById = Order.findById;
  Order.findById = (id) => ({ populate: async () => harness.orders.get(String(id)) || null });
  try {
    const denied = await request(harness.app).get(`/orders/${created.body.data._id}`)
      .set("Authorization", `Bearer ${issueUserToken({ _id: harness.customers[1] })}`);
    assert.equal(denied.statusCode, 403);
  } finally { Order.findById = originalFindById; }
});

test("order creation requires an idempotency key", async () => {
  const harness = makeHarness();
  const response = await request(harness.app).post("/orders")
    .set("Authorization", `Bearer ${issueUserToken({ _id: harness.customers[0] })}`)
    .send({ items: [{ productID: harness.productId, quantity: 1 }], shippingAddress: { phone: "x", street: "y", city: "z" }, paymentMethod: "cod" });
  assert.equal(response.statusCode, 400);
  assert.equal(harness.orders.size, 0);
});
