const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const StoreSettings = require("../model/storeSettings");
const Order = require("../model/order");
const AdminUser = require("../model/adminUser");
const { issueAdminToken } = require("../middleware/adminAccess");
const { normalizePaymentMethod, paymentMethodSnapshot } = require("../utils/paymentMethods");
const routes = require("../routes/storeSettings");

process.env.JWT_SECRET ||= "synthetic-payment-method-tests-only-secret";

const originals = {
  findOne: StoreSettings.findOne,
  findOneAndUpdate: StoreSettings.findOneAndUpdate,
  orderExists: Order.exists,
  adminFindById: AdminUser.findById,
};
let settings;
let legacyReference = null;

function makeSettings() {
  return {
    key: "storefront",
    paymentMethods: [],
    async save() {},
  };
}
function app() { const server = express(); server.use(express.json()); server.use("/store-settings", routes); return server; }
function token(role = "super_admin") { return issueAdminToken({ _id: `test-${role}`, clearanceLevel: role }); }
function fakeMethod(value) { return { ...value, set(next) { Object.assign(this, next); } }; }
function installModelFakes() {
  StoreSettings.findOne = () => {
    if (settings) settings.paymentMethods = settings.paymentMethods.map((method) => method.set ? method : fakeMethod(method));
    const query = Promise.resolve(settings);
    query.lean = async () => settings ? { ...settings, paymentMethods: settings.paymentMethods.map((method) => ({ ...method })) } : null;
    return query;
  };
  StoreSettings.findOneAndUpdate = async (_query, update) => {
    if (!settings) settings = makeSettings();
    if (update.$set) Object.assign(settings, update.$set);
    return settings;
  };
  Order.exists = async () => legacyReference;
  AdminUser.findById = async (id) => ({ _id: id, clearanceLevel: String(id).slice("test-".length), isActive: true });
}

test.beforeEach(() => { settings = makeSettings(); legacyReference = null; installModelFakes(); });
test.afterEach(() => {
  StoreSettings.findOne = originals.findOne;
  StoreSettings.findOneAndUpdate = originals.findOneAndUpdate;
  Order.exists = originals.orderExists;
  AdminUser.findById = originals.adminFindById;
});

test("validation supports arbitrary provider names, optional proof, and cash collection without account data", () => {
  const bank = normalizePaymentMethod({ name: "Example transfer", category: "bank_transfer", providerName: "Any locally supported bank", accountIdentifier: "synthetic-account", instructions: "Synthetic instructions", requiresProof: true, enabled: true }, { code: "any-bank-method" });
  assert.equal(bank.error, undefined);
  assert.equal(paymentMethodSnapshot({ code: "provider_method_82", ...bank.value }).requiresProof, true);
  const optional = normalizePaymentMethod({ name: "Manual confirmation", category: "other", additionalDetails: "Confirm with staff", requiresProof: false }, { code: "manual-without-proof" });
  assert.equal(optional.error, undefined);
  const cash = normalizePaymentMethod({ name: "Cash at collection", category: "cash_collection", requiresProof: false }, { code: "cash-at-collection" });
  assert.equal(cash.error, undefined);
  assert.equal(normalizePaymentMethod({ name: "Bad cash", category: "cash_collection", requiresProof: true }, { code: "bad-cash-method" }).error !== undefined, true);
  assert.equal(normalizePaymentMethod({ name: "Missing bank", category: "bank_transfer", requiresProof: true }, { code: "missing-bank" }).error !== undefined, true);
});

test("payment snapshots serialize Mongoose subdocuments as well as plain records", () => {
  const document = new StoreSettings({ paymentMethods: [{
    code: "arbitrary-provider", name: "Saved method", title: "Saved method",
    category: "other", instructions: "Saved customer instructions", enabled: true, requiresProof: false,
  }] });
  const snapshot = paymentMethodSnapshot(document.paymentMethods[0]);
  assert.equal(snapshot.name, "Saved method");
  assert.equal(snapshot.instructions, "Saved customer instructions");
  assert.equal(snapshot.requiresProof, false);
});

test("order snapshot schema is optional for history and immutable for new orders", () => {
  assert.equal(Order.schema.path("paymentMethodSnapshot").options.immutable, true);
  const historical = new Order({ paymentMethod: "legacy-code" });
  assert.equal(historical.paymentMethodSnapshot, undefined);
});

test("public checkout methods expose only active customer fields and GET performs no writes", async () => {
  settings.paymentMethods = [
    fakeMethod({ code: "custom_bank_method", name: "Example Bank", title: "Example Bank", category: "bank_transfer", providerName: "A configurable bank", accountHolder: "Test Recipient", accountIdentifier: "synthetic-123", instructions: "Test only", additionalDetails: "Details", requiresProof: true, enabled: true, displayOrder: 1, internalNote: "hidden" }),
    fakeMethod({ code: "inactive_wallet", name: "Hidden wallet", title: "Hidden wallet", category: "mobile_wallet", accountIdentifier: "private", enabled: false, requiresProof: false, displayOrder: 0 }),
  ];
  StoreSettings.findOneAndUpdate = async () => { throw new Error("checkout GET must not write settings"); };
  const response = await request(app()).get("/store-settings/checkout");
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body.data.paymentMethods.length, 1);
  assert.equal(response.body.data.paymentMethods[0].code, "custom_bank_method");
  assert.equal(response.body.data.paymentMethods[0].accountIdentifier, "synthetic-123");
  assert.equal(Object.hasOwn(response.body.data.paymentMethods[0], "internalNote"), false);
  assert.equal(Object.hasOwn(response.body.data.paymentMethods[0], "_id"), false);
});

test("only active super admins can read or manage payment methods", async () => {
  assert.equal((await request(app()).get("/store-settings/payment-methods")).status, 401);
  const moderator = await request(app()).post("/store-settings/payment-methods").set("Authorization", `Bearer ${token("moderator")}`).send({});
  assert.equal(moderator.status, 403);
  const admin = await request(app()).get("/store-settings/payment-methods").set("Authorization", `Bearer ${token("admin")}`);
  assert.equal(admin.status, 403);
  AdminUser.findById = async (id) => ({ _id: id, clearanceLevel: "super_admin", isActive: false });
  const inactive = await request(app()).post("/store-settings/payment-methods").set("Authorization", `Bearer ${token()}`).send({});
  assert.equal(inactive.status, 401);
});

test("super admin can create, edit, deactivate and delete arbitrary methods", async () => {
  const auth = { Authorization: `Bearer ${token()}` };
  const created = await request(app()).post("/store-settings/payment-methods").set(auth).send({
    name: "Flexible wallet", category: "mobile_wallet", providerName: "Any wallet provider",
    accountIdentifier: "synthetic-wallet-id", instructions: "Synthetic instruction", enabled: true,
    requiresProof: true, displayOrder: 4,
  });
  assert.equal(created.status, 201);
  const code = created.body.data.code;
  assert.match(code, /^pm_[a-f0-9]{32}$/);
  assert.equal(created.body.data.requiresProof, true);

  const updated = await request(app()).put(`/store-settings/payment-methods/${code}`).set(auth).send({
    ...created.body.data, name: "Renamed wallet", enabled: false, requiresProof: false,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.enabled, false);
  assert.equal(updated.body.data.name, "Renamed wallet");

  const removed = await request(app()).delete(`/store-settings/payment-methods/${code}`).set(auth);
  assert.equal(removed.status, 200);
  assert.equal(settings.paymentMethods.length, 0);
});

test("cash methods force no proof and legacy order references block unsafe deletion", async () => {
  const auth = { Authorization: `Bearer ${token()}` };
  const created = await request(app()).post("/store-settings/payment-methods").set(auth).send({
    name: "Cash at collection", category: "cash_collection", enabled: true, requiresProof: false,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.requiresProof, false);
  legacyReference = { _id: "legacy-order" };
  const blocked = await request(app()).delete(`/store-settings/payment-methods/${created.body.data.code}`).set(auth);
  assert.equal(blocked.status, 409);
  assert.equal(settings.paymentMethods.length, 1);
});

test("legacy settings reads are protected and legacy bulk writes cannot replace payment methods", async () => {
  const anonymous = await request(app()).get("/store-settings");
  assert.equal(anonymous.status, 401);
  const response = await request(app()).put("/store-settings").set("Authorization", `Bearer ${token()}`).send({
    paymentMethods: [{ code: "arbitrary", name: "Attempted overwrite", category: "other", instructions: "x" }],
  });
  assert.equal(response.status, 400);
});
