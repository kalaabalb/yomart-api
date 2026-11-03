const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const routes = require("../routes/storeSettings");
const { normalizeSupportInstagram } = routes;
const StoreSettings = require("../model/storeSettings");
const AdminUser = require("../model/adminUser");
const { issueAdminToken } = require("../middleware/adminAccess");

process.env.JWT_SECRET ||= "synthetic-store-settings-test-secret";

const originalFindOneAndUpdate = StoreSettings.findOneAndUpdate;
const originalFindOne = StoreSettings.findOne;
const originalAdminFindById = AdminUser.findById;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/store-settings", routes);
  return app;
}

test("store settings cannot be changed without administrator authentication", async () => {
  const response = await request(createApp())
    .put("/store-settings")
    .send({
      supportPhone: "123",
      supportTelegram: "store",
      supportInstagram: "yomart",
      paymentMethods: [
        {
          code: "cod",
          title: "Cash on delivery",
          subtitle: "Pay on arrival",
          enabled: true,
        },
      ],
    });

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.success, false);
});

test("checkout settings expose no customer-facing payment defaults and reads never create settings", async () => {
  StoreSettings.findOne = () => ({ lean: async () => null });
  StoreSettings.findOneAndUpdate = async () => { throw new Error("checkout GET must be read-only"); };
  try {
    const response = await request(createApp()).get("/store-settings/checkout");
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.data.paymentMethods, []);
  } finally {
    StoreSettings.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test("Instagram contact is optional for existing admin clients", () => {
  assert.equal(normalizeSupportInstagram(undefined), "");
});

test("contact configuration accepts usernames and rejects URLs or unsafe Instagram values", () => {
  assert.equal(normalizeSupportInstagram("@yomart.store"), "yomart.store");
  assert.equal(normalizeSupportInstagram(""), "");
  assert.equal(normalizeSupportInstagram("https://instagram.com/yomart"), null);
  assert.equal(normalizeSupportInstagram("javascript:alert(1)"), null);
  assert.equal(normalizeSupportInstagram("x".repeat(31)), null);
});

test("legacy payment method settings remain untouched when read", async () => {
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  const legacySettings = {
    supportPhone: "",
    supportTelegram: "",
    createdAt: timestamp,
    updatedAt: timestamp,
    paymentMethods: [
      { code: "cbe", title: "Bank transfer", subtitle: "Pay with bank transfer", enabled: true, instructions: "" },
      { code: "telebirr", title: "Telebirr", subtitle: "Pay with Telebirr", enabled: true, instructions: "" },
      { code: "cod", title: "Cash on delivery", subtitle: "Pay when you receive your order", enabled: true, instructions: "" },
    ],
    save: async function () {},
  };
  StoreSettings.findOne = () => ({ lean: async () => legacySettings });
  AdminUser.findById = async (id) => ({ _id: id, clearanceLevel: "super_admin", isActive: true });
  try {
    const response = await request(createApp()).get("/store-settings").set("Authorization", `Bearer ${issueAdminToken({ _id: "settings-legacy", clearanceLevel: "super_admin" })}`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.data.paymentMethods.length, 3);
  } finally {
    StoreSettings.findOne = originalFindOne;
    AdminUser.findById = originalAdminFindById;
  }
});

test("checkout settings endpoint is read-only and returns only enabled configured methods", async () => {
  let leanCalled = false;
  StoreSettings.findOne = () => ({ lean: async () => {
    leanCalled = true;
    return {
      deliveryFee: 75,
      paymentMethods: [
        { code: "cod", title: "Cash on delivery", subtitle: "Configured subtitle", instructions: "Configured terms", enabled: true },
        { code: "cbe", title: "Disabled bank", subtitle: "Hidden", instructions: "Do not show", enabled: false },
      ],
    };
  } });
  const updateSpy = StoreSettings.findOneAndUpdate;
  StoreSettings.findOneAndUpdate = async () => { throw new Error("read-only checkout route must not write"); };
  try {
    const response = await request(createApp()).get("/store-settings/checkout");
    assert.equal(response.statusCode, 200);
    assert.equal(leanCalled, true);
    assert.equal(response.body.data.deliveryFee, 0);
    assert.equal(response.body.data.paymentMethods.length, 1);
    assert.deepEqual(response.body.data.paymentMethods[0], {
      code: "cod", name: "Cash on delivery", description: "Configured subtitle", category: "cash_collection",
      logoUrl: "", providerName: "", accountHolder: "", accountIdentifier: "", additionalDetails: "",
      instructions: "Configured terms", requiresProof: false, title: "Cash on delivery", subtitle: "Configured subtitle", enabled: true,
    });
  } finally {
    StoreSettings.findOneAndUpdate = updateSpy;
    StoreSettings.findOne = originalFindOne;
  }
});

test("missing checkout settings expose no invented fee or payment methods", async () => {
  StoreSettings.findOne = () => ({ lean: async () => null });
  try {
    const response = await request(createApp()).get("/store-settings/checkout");
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.data, { deliveryFee: 0, paymentMethods: [] });
  } finally { StoreSettings.findOne = originalFindOne; }
});

test("updating checkout settings without legacy contact fields preserves those fields", async () => {
  process.env.JWT_SECRET ||= "settings-test-secret-value";
  let update;
  AdminUser.findById = async (id) => ({ _id: id, clearanceLevel: "super_admin", isActive: true });
  StoreSettings.findOneAndUpdate = async (_query, changes) => {
    update = changes;
    return { supportPhone: "existing phone remains", supportTelegram: "existing account remains", ...changes.$set };
  };
  try {
    const token = issueAdminToken({ _id: "settings-test", clearanceLevel: "super_admin" });
    const response = await request(createApp()).put("/store-settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ deliveryFee: 0 });
    assert.equal(response.statusCode, 200);
    assert.equal(Object.hasOwn(update.$set, "supportPhone"), false);
    assert.equal(Object.hasOwn(update.$set, "supportTelegram"), false);
    assert.equal(Object.hasOwn(update.$set, "supportInstagram"), false);
    assert.equal(response.body.data.supportPhone, "existing phone remains");
  } finally {
    StoreSettings.findOneAndUpdate = originalFindOneAndUpdate;
    AdminUser.findById = originalAdminFindById;
  }
});
