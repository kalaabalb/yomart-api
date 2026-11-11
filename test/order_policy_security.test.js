const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const mongoose = require("mongoose");
const AdminUser = require("../model/adminUser");
const PaymentProof = require("../model/paymentProof");
const Order = require("../model/order");
const SecurityAudit = require("../model/securityAudit");
const User = require("../model/user");
const ProofCleanupJob = require("../model/proofCleanupJob");
const mongooseOriginalStartSession = mongoose.startSession;
const originalOrderFindById = Order.findById;
const originalAuditCreate = SecurityAudit.create;
const { issueAdminToken, CAPABILITY_ROLES } = require("../middleware/adminAccess");
const { claimUploadedProof, isEligibleForProofReplacement } = require("../utils/paymentProofPolicy");

process.env.JWT_SECRET ||= "order-policy-test-secret";
const roles = Object.fromEntries(["moderator", "admin", "super_admin", "inactive"].map((role) => [role, new mongoose.Types.ObjectId()]));
const oldFindById = AdminUser.findById;
const oldStartSession = mongoose.startSession;
function app() {
  const server = express();
  server.use(express.json());
  server.use("/orders", require("../routes/order"));
  server.use("/payment", require("../routes/payment"));
  server.use("/users", require("../routes/user"));
  server.use(require("../middleware/errorHandler"));
  return server;
}

test.before(() => {
  mongoose.startSession = async () => ({
    withTransaction: async (operation) => operation(),
    endSession: async () => {},
  });
  AdminUser.findById = async (id) => {
    const role = Object.keys(roles).find((name) => roles[name].toString() === id.toString());
    if (!role || role === "inactive") return null;
    return { _id: roles[role], isActive: true, clearanceLevel: role };
  };
});
test.after(() => {
  AdminUser.findById = oldFindById;
  mongoose.startSession = oldStartSession;
});

const token = (role) => `Bearer ${issueAdminToken({ _id: roles[role], clearanceLevel: role === "inactive" ? "admin" : role })}`;

test("capability matrix follows existing admin roles and denies moderators by default", () => {
  assert.deepEqual(CAPABILITY_ROLES["orders.read"], ["admin", "super_admin"]);
  assert.deepEqual(CAPABILITY_ROLES["orders.fulfill"], ["admin", "super_admin"]);
  assert.deepEqual(CAPABILITY_ROLES["payments.review"], ["admin", "super_admin"]);
  assert.deepEqual(CAPABILITY_ROLES["customers.read"], ["admin", "super_admin"]);
  assert.deepEqual(CAPABILITY_ROLES["orders.delete"], ["super_admin"]);
});

test("moderator direct API calls cannot read order/customer data or invoke order/payment actions", async () => {
  const endpoints = [
    ["get", "/orders"],
    ["get", "/orders/payment-status/pending"],
    ["get", "/orders/admin/pending-verification"],
    ["put", `/orders/${new mongoose.Types.ObjectId()}`, { orderStatus: "shipped" }],
    ["put", `/orders/${new mongoose.Types.ObjectId()}/verify-payment`, { verified: true }],
    ["delete", `/orders/${new mongoose.Types.ObjectId()}`],
    ["post", `/payment/verify-payment/${new mongoose.Types.ObjectId()}`, { verified: true }],
    ["get", `/payment/proofs/${new mongoose.Types.ObjectId()}`],
    ["get", "/users"],
  ];
  for (const [method, url, body] of endpoints) {
    const response = await request(app())[method](url).set("Authorization", token("moderator")).send(body || {});
    assert.equal(response.statusCode, 403, `${method.toUpperCase()} ${url} returned ${response.statusCode}`);
  }
});

test("inactive admin accounts cannot use privileged order routes", async () => {
  const response = await request(app()).get("/orders/payment-status/pending").set("Authorization", token("inactive"));
  assert.equal(response.statusCode, 401);
});

test("admin and super-admin have the documented read and fulfillment capabilities", async () => {
  const oldFind = Order.find;
  const oldFindByIdAndUpdate = Order.findByIdAndUpdate;
  const oldUsersFind = User.find;
  const oldFindById = Order.findById;
  let customerProjection;
  const query = () => ({ populate() { return this; }, sort: async () => [] });
  Order.find = query;
  Order.findByIdAndUpdate = async (_id, update) => ({ _id, ...update });
  Order.findById = () => ({ session: async () => ({ orderStatus: "processing", paymentMethod: "cod", async save() { return this; } }) });
  User.find = () => ({ select: async (selection) => { customerProjection = selection; return []; } });
  try {
    for (const role of ["admin", "super_admin"]) {
      for (const [method, url, body] of [
        ["get", "/orders"],
        ["get", "/orders/payment-status/pending"],
        ["get", "/orders/admin/pending-verification"],
        ["get", "/users"],
        ["put", `/orders/${new mongoose.Types.ObjectId()}`, { orderStatus: "shipped" }],
      ]) {
        const response = await request(app())[method](url).set("Authorization", token(role)).send(body || {});
        assert.equal(response.statusCode, 200, `${role} ${method.toUpperCase()} ${url} returned ${response.statusCode}`);
      }
      assert.equal(customerProjection, "_id name email phone createdAt accountStatus");
      // Existing proof route accepts the role, then returns not-found for the
      // intentionally absent test order; it must not reject an authorized role.
      const proofResponse = await request(app()).get(`/payment/proofs/${new mongoose.Types.ObjectId()}`).set("Authorization", token(role));
      assert.equal(proofResponse.statusCode, 404);
      assert.notEqual(proofResponse.statusCode, 403);
    }
  } finally {
    Order.find = oldFind;
    Order.findByIdAndUpdate = oldFindByIdAndUpdate;
    Order.findById = oldFindById;
    User.find = oldUsersFind;
  }
});

test("only super-admin can delete orders, and evidence-bearing orders remain protected", async () => {
  const oldFindById = Order.findById;
  const oldDelete = Order.findByIdAndDelete;
  Order.findById = async () => null;
  Order.findByIdAndDelete = async (_id) => ({ _id });
  try {
    const orderId = new mongoose.Types.ObjectId();
    const denied = await request(app()).delete(`/orders/${orderId}`).set("Authorization", token("admin"));
    assert.equal(denied.statusCode, 403);
    const allowed = await request(app()).delete(`/orders/${orderId}`).set("Authorization", token("super_admin"));
    assert.equal(allowed.statusCode, 200);
  } finally {
    Order.findById = oldFindById;
    Order.findByIdAndDelete = oldDelete;
  }
});

test("payment proof schema enforces one active proof association per order", () => {
  const associationIndex = PaymentProof.schema.indexes().find(([keys, options]) =>
    keys.orderId === 1 && options.unique === true && options.partialFilterExpression?.status === "associated",
  );
  assert.ok(associationIndex, "missing unique partial active-order index");
});

test("a proof record cannot be claimed by a second order or another customer", async () => {
  const proofId = "proof:payment-proofs/owner/payment_123e4567-e89b-12d3-a456-426614174000.webp";
  const ownerId = new mongoose.Types.ObjectId();
  let association = null;
  let filterWasInternalOnly = false;
  const originalClaim = PaymentProof.findOneAndUpdate;
  PaymentProof.findOneAndUpdate = async (filter, update) => {
    filterWasInternalOnly = !Object.hasOwn(filter, "storageKey");
    if (association || filter.ownerId.toString() !== ownerId.toString() || filter.status !== "uploaded" || filter.orderId !== null) return null;
    association = update.$set.orderId;
    return { _id: new mongoose.Types.ObjectId(), ...update.$set, storageKey: proofId };
  };
  try {
    const firstOrderId = new mongoose.Types.ObjectId();
    const firstProofRecordId = new mongoose.Types.ObjectId();
    const claimed = await claimUploadedProof({ proofRecordId: firstProofRecordId, ownerId, orderId: firstOrderId });
    assert.equal(claimed.storageKey, proofId);
    assert.equal(filterWasInternalOnly, true);
    await assert.rejects(claimUploadedProof({ proofRecordId: new mongoose.Types.ObjectId(), ownerId, orderId: new mongoose.Types.ObjectId() }), { statusCode: 409 });
    association = null;
    await assert.rejects(claimUploadedProof({ proofRecordId: new mongoose.Types.ObjectId(), ownerId: new mongoose.Types.ObjectId(), orderId: new mongoose.Types.ObjectId() }), { statusCode: 409 });
  } finally { PaymentProof.findOneAndUpdate = originalClaim; }
});

test("concurrent claims of one proof produce one winner", async () => {
  let claimed = false;
  const originalClaim = PaymentProof.findOneAndUpdate;
  PaymentProof.findOneAndUpdate = async (_filter, update) => {
    if (claimed) return null;
    claimed = true;
    await new Promise((resolve) => setImmediate(resolve));
    return { _id: new mongoose.Types.ObjectId(), ...update.$set, storageKey: "proof:payment-proofs/u/p.webp" };
  };
  try {
    const attempts = await Promise.allSettled([1, 2].map(() => claimUploadedProof({ proofRecordId: new mongoose.Types.ObjectId(), proofId: "proof:payment-proofs/u/p.webp", ownerId: new mongoose.Types.ObjectId(), orderId: new mongoose.Types.ObjectId() })));
    assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((item) => item.status === "rejected" && item.reason.statusCode === 409).length, 1);
  } finally { PaymentProof.findOneAndUpdate = originalClaim; }
});

test("proof replacement is limited to the same customer's eligible unpaid non-COD order", () => {
  const ownerId = new mongoose.Types.ObjectId();
  const eligible = { userID: ownerId, paymentMethod: "cbe", paymentStatus: "pending", orderStatus: "payment_pending" };
  assert.equal(isEligibleForProofReplacement(eligible, ownerId), true);
  for (const changes of [
    { paymentStatus: "verified" }, { paymentStatus: "failed" }, { orderStatus: "cancelled" },
    { orderStatus: "delivered" }, { paymentMethod: "cod" },
  ]) assert.equal(isEligibleForProofReplacement({ ...eligible, ...changes }, ownerId), false);
  assert.equal(isEligibleForProofReplacement(eligible, new mongoose.Types.ObjectId()), false);
});

test("customer can replace a proof on the same eligible order and the replacement is audited", async () => {
  const ownerId = new mongoose.Types.ObjectId();
  const orderId = new mongoose.Types.ObjectId();
  const oldProofId = new mongoose.Types.ObjectId();
  const newProofId = new mongoose.Types.ObjectId();
  const oldStorageKey = `proof:payment-proofs/${ownerId}/payment_123e4567-e89b-12d3-a456-426614174000.webp`;
  const newStorageKey = `proof:payment-proofs/${ownerId}/payment_123e4567-e89b-12d3-a456-426614174001.webp`;
  const oldProof = { _id: oldProofId, orderId, status: "associated" };
  const newProof = { _id: newProofId, orderId: null, status: "uploaded", storageKey: newStorageKey };
  const order = {
    _id: orderId, userID: ownerId, paymentMethod: "cbe", paymentStatus: "pending", orderStatus: "payment_pending",
    paymentProof: { storageKey: oldStorageKey, proofRecordId: oldProofId },
    async save() { return this; },
  };
  const originalUserFindById = User.findById;
  const originalUserFindOne = User.findOne;
  const originalOrderFindById = Order.findById;
  const originalPaymentProofUpdate = PaymentProof.findOneAndUpdate;
  const originalCleanupUpdate = ProofCleanupJob.updateOne;
  const originalStartSession = mongoose.startSession;
  const originalAuditCreate = SecurityAudit.create;
  let orderReadCount = 0;
  let auditEvent;
  User.findById = async () => ({ _id: ownerId, accountStatus: "active" });
  User.findOne = () => ({ session: async () => ({ _id: ownerId, accountStatus: "active" }) });
  Order.findById = () => {
    orderReadCount += 1;
    return orderReadCount === 1 ? Promise.resolve(order) : { session: async () => order };
  };
  PaymentProof.findOneAndUpdate = async (filter, update) => {
    if (filter._id.toString() === oldProofId.toString()) {
      Object.assign(oldProof, update.$set);
      return oldProof;
    }
    if (filter._id.toString() === newProofId.toString()) {
      Object.assign(newProof, update.$set);
      return newProof;
    }
    return null;
  };
  ProofCleanupJob.updateOne = async () => ({ acknowledged: true });
  mongoose.startSession = async () => ({ withTransaction: async (callback) => callback(), endSession: async () => {} });
  SecurityAudit.create = async ([event]) => { auditEvent = event; };
  try {
    const response = await request(app()).put(`/orders/${orderId}/payment-proof`)
      .set("Authorization", `Bearer ${require("../middleware/adminAccess").issueUserToken({ _id: ownerId })}`)
      .send({ proofRecordId: newProofId });
    assert.equal(response.statusCode, 200);
    assert.equal(order.paymentProof.proofRecordId.toString(), newProofId.toString());
    assert.equal(oldProof.status, "superseded");
    assert.equal(oldProof.orderId, null);
    assert.equal(newProof.status, "associated");
    assert.equal(newProof.orderId.toString(), orderId.toString());
    assert.equal(auditEvent.action, "proof_replaced");
    assert.equal(auditEvent.orderId.toString(), orderId.toString());
    assert.equal(auditEvent.actorId.toString(), ownerId.toString());
    assert.equal(auditEvent.oldProofId.toString(), oldProofId.toString());
    assert.equal(auditEvent.newProofId.toString(), newProofId.toString());
  } finally {
    User.findById = originalUserFindById;
    User.findOne = originalUserFindOne;
    Order.findById = originalOrderFindById;
    PaymentProof.findOneAndUpdate = originalPaymentProofUpdate;
    ProofCleanupJob.updateOne = originalCleanupUpdate;
    mongoose.startSession = originalStartSession;
    SecurityAudit.create = originalAuditCreate;
  }
});

test("admin and super-admin can complete payment decisions with an atomic audit event", async () => {
  const previousSession = mongoose.startSession;
  const previousFind = Order.findById;
  const previousCreate = SecurityAudit.create;
  const oldAdmin = roles.admin;
  const oldSuper = roles.super_admin;
  for (const role of ["admin", "super_admin"]) {
    const order = {
      _id: new mongoose.Types.ObjectId(), paymentMethod: "cbe", paymentStatus: "pending", orderStatus: "payment_pending",
      paymentProof: { storageKey: "proof:payment-proofs/a/b.webp" },
      async save() { return this; },
    };
    let audit;
    mongoose.startSession = async () => ({ withTransaction: async (fn) => fn(), endSession: async () => {} });
    Order.findById = () => ({ session: async () => order });
    SecurityAudit.create = async (rows) => { audit = rows[0]; };
    const response = await request(app()).put(`/orders/${order._id}/verify-payment`).set("Authorization", token(role)).send({ verified: true });
    assert.equal(response.statusCode, 200, `${role} could not verify an eligible order`);
    assert.equal(audit.action, "payment_verified");
    assert.equal(audit.actorRole, role);
    assert.equal(audit.orderId.toString(), order._id.toString());
  }
  mongoose.startSession = previousSession;
  Order.findById = previousFind;
  SecurityAudit.create = previousCreate;
});

test("order JSON does not disclose proof record IDs or storage references", () => {
  const Order = require("../model/order");
  const order = new Order({
    userID: new mongoose.Types.ObjectId(), totalPrice: 10, paymentMethod: "cbe",
    paymentProof: { storageKey: "proof:payment-proofs/opaque", proofRecordId: new mongoose.Types.ObjectId(), imageUrl: "https://public.invalid/receipt" },
  });
  const json = order.toJSON();
  assert.equal(json.paymentProof.available, true);
  assert.equal("proofRecordId" in json.paymentProof, false);
  assert.equal("storageKey" in json.paymentProof, false);
  assert.equal("imageUrl" in json.paymentProof, false);
});
