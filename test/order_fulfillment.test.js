const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const mongoose = require("mongoose");
const Order = require("../model/order");
const AdminUser = require("../model/adminUser");
const { issueAdminToken } = require("../middleware/adminAccess");
const { ORDER_STATUSES, canTransitionOrderStatus, normalizeCollectionPoint } = require("../utils/orderFulfillment");

process.env.JWT_SECRET ||= "synthetic-fulfillment-test-secret";

const adminIds = Object.fromEntries(["admin", "super_admin", "moderator", "inactive"].map((role) => [role, new mongoose.Types.ObjectId()]));
const oldAdminFind = AdminUser.findById;
const oldOrderFind = Order.findById;
const oldStartSession = mongoose.startSession;
const app = express();
app.use(express.json());
app.use("/orders", require("../routes/order"));
const auth = (role) => `Bearer ${issueAdminToken({ _id: adminIds[role], clearanceLevel: role === "inactive" ? "admin" : role })}`;

test.before(() => {
  mongoose.startSession = async () => ({
    withTransaction: async (operation) => operation(),
    endSession: async () => {},
  });
  AdminUser.findById = async (id) => {
    const role = Object.keys(adminIds).find((key) => adminIds[key].toString() === id.toString());
    return !role || role === "inactive" ? null : { _id: id, isActive: true, clearanceLevel: role };
  };
});

test.after(() => {
  AdminUser.findById = oldAdminFind;
  Order.findById = oldOrderFind;
  mongoose.startSession = oldStartSession;
});

test("collection statuses are additive and preserve historical statuses", () => {
  assert.ok(ORDER_STATUSES.includes("delivered"));
  assert.ok(ORDER_STATUSES.includes("ready_for_collection"));
  assert.ok(ORDER_STATUSES.includes("collected"));
  assert.equal(canTransitionOrderStatus("processing", "ready_for_collection"), true);
  assert.equal(canTransitionOrderStatus("ready_for_collection", "collected"), true);
  assert.equal(canTransitionOrderStatus("processing", "collected"), false);
  assert.equal(canTransitionOrderStatus("collected", "processing"), false);
  assert.equal(canTransitionOrderStatus("delivered", "delivered"), true);
});

test("collection point requires staff-entered name, address, and city", () => {
  assert.deepEqual(normalizeCollectionPoint({ name: "Main", address: "Market road", city: "Bahir Dar" }), {
    name: "Main", address: "Market road", city: "Bahir Dar",
  });
  assert.equal(normalizeCollectionPoint({ name: "Main", address: "Market road" }), null);
});

test("authorized admin records collection point and marks order ready", async () => {
  let saved = false;
  const order = {
    orderStatus: "processing",
    paymentMethod: "cod",
    async save() { saved = true; return this; },
  };
  Order.findById = () => ({ session: async () => order });
  const response = await request(app).put(`/orders/${new mongoose.Types.ObjectId()}`)
    .set("Authorization", auth("admin"))
    .send({
      orderStatus: "ready_for_collection",
      collectionPoint: { name: "Agreed location", address: "Staff recorded address", city: "Bahir Dar" },
    });
  assert.equal(response.statusCode, 200);
  assert.equal(saved, true);
  assert.equal(response.body.data.orderStatus, "ready_for_collection");
  assert.equal(response.body.data.collectionPoint.name, "Agreed location");
  assert.ok(response.body.data.collectionPoint.agreedAt);
});

test("ready status requires a collection point and collected cannot skip readiness", async () => {
  let saves = 0;
  const order = { orderStatus: "processing", paymentMethod: "cod", async save() { saves += 1; } };
  Order.findById = () => ({ session: async () => order });
  const ready = await request(app).put(`/orders/${new mongoose.Types.ObjectId()}`)
    .set("Authorization", auth("admin")).send({ orderStatus: "ready_for_collection" });
  assert.equal(ready.statusCode, 400);
  assert.equal(saves, 0);
  const collected = await request(app).put(`/orders/${new mongoose.Types.ObjectId()}`)
    .set("Authorization", auth("admin")).send({ orderStatus: "collected" });
  assert.equal(collected.statusCode, 409);
  assert.equal(saves, 0);
});

test("moderators and inactive admins cannot change collection point or status", async () => {
  let reads = 0;
  Order.findById = () => ({ session: async () => { reads += 1; return { orderStatus: "processing", paymentMethod: "cod" }; } });
  for (const role of ["moderator", "inactive"]) {
    const response = await request(app).put(`/orders/${new mongoose.Types.ObjectId()}`)
      .set("Authorization", auth(role))
      .send({ orderStatus: "ready_for_collection", collectionPoint: { name: "x", address: "y", city: "z" } });
    assert.ok([401, 403].includes(response.statusCode));
  }
  assert.equal(reads, 0);
});
