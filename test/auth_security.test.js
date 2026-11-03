const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

process.env.JWT_SECRET = "test-secret";
process.env.JWT_EXPIRES_IN = "1h";

const userRoutes = require("../routes/user");
const adminRoutes = require("../routes/adminUser");
const orderRoutes = require("../routes/order");
const User = require("../model/user");
const AdminUser = require("../model/adminUser");
const Order = require("../model/order");
const Product = require("../model/product");
const StoreSettings = require("../model/storeSettings");
const OrderIdempotency = require("../model/orderIdempotency");
const {
  issueAdminToken,
  issueUserToken,
} = require("../middleware/adminAccess");

const originalMethods = {
  userFindOne: User.findOne,
  userFindById: User.findById,
  userSave: User.prototype.save,
  adminFindOne: AdminUser.findOne,
  adminFindById: AdminUser.findById,
  orderFindById: Order.findById,
  orderFind: Order.find,
  orderSave: Order.prototype.save,
  orderCreate: Order.create,
  productFindOneAndUpdate: Product.findOneAndUpdate,
  storeSettingsFindOne: StoreSettings.findOne,
  orderIdempotencyIndex: OrderIdempotency.collection.createIndex,
  orderIdempotencyFindOne: OrderIdempotency.findOne,
  orderIdempotencyCreate: OrderIdempotency.create,
  startSession: mongoose.startSession,
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/users", userRoutes);
  app.use("/admin-users", adminRoutes);
  app.use("/orders", orderRoutes);
  return app;
}

function restoreStubs() {
  User.findOne = originalMethods.userFindOne;
  User.findById = originalMethods.userFindById;
  User.prototype.save = originalMethods.userSave;
  AdminUser.findOne = originalMethods.adminFindOne;
  AdminUser.findById = originalMethods.adminFindById;
  Order.findById = originalMethods.orderFindById;
  Order.find = originalMethods.orderFind;
  Order.prototype.save = originalMethods.orderSave;
  Order.create = originalMethods.orderCreate;
  Product.findOneAndUpdate = originalMethods.productFindOneAndUpdate;
  StoreSettings.findOne = originalMethods.storeSettingsFindOne;
  OrderIdempotency.collection.createIndex = originalMethods.orderIdempotencyIndex;
  OrderIdempotency.findOne = originalMethods.orderIdempotencyFindOne;
  OrderIdempotency.create = originalMethods.orderIdempotencyCreate;
  mongoose.startSession = originalMethods.startSession;
}

test.afterEach(() => {
  restoreStubs();
});

test("valid user login returns a signed token", async () => {
  const fakeUser = {
    _id: new mongoose.Types.ObjectId(),
    name: "alice",
    email: "alice@example.com",
    emailVerified: true,
    phone: null,
    phoneVerified: false,
    createdAt: new Date(),
    correctPassword: async () => true,
  };

  User.findOne = async () => fakeUser;

  const app = createApp();
  const response = await request(app)
    .post("/users/login")
    .send({ name: "alice", password: "secret" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.ok(response.body.data.token);

  const tokenData = jwt.verify(response.body.data.token, "test-secret");
  assert.equal(tokenData.role, "user");
  assert.equal(tokenData.sub, fakeUser._id.toString());
});

test("user login accepts the email shown by the login screen", async () => {
  const fakeUser = {
    _id: new mongoose.Types.ObjectId(),
    name: "alice",
    email: "alice@example.com",
    emailVerified: true,
    correctPassword: async () => true,
  };
  User.findOne = async (query) => {
    assert.deepEqual(query, {
      $or: [
        { name: "alice@example.com" },
        { email: "alice@example.com" },
      ],
    });
    return fakeUser;
  };

  const response = await request(createApp())
    .post("/users/login")
    .send({ name: "ALICE@example.com", password: "secret" });

  assert.equal(response.statusCode, 200);
  assert.ok(response.body.data.token);
});

test("valid admin login returns a signed token", async () => {
  const fakeAdmin = {
    _id: new mongoose.Types.ObjectId(),
    username: "superadmin",
    name: "Super Admin",
    email: "admin@example.com",
    clearanceLevel: "super_admin",
    isActive: true,
    correctPassword: async () => true,
  };

  AdminUser.findOne = async () => fakeAdmin;

  const app = createApp();
  const response = await request(app)
    .post("/admin-users/login")
    .send({ username: "superadmin", password: "secret" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.ok(response.body.data.token);

  const tokenData = jwt.verify(response.body.data.token, "test-secret");
  assert.equal(tokenData.role, "admin");
  assert.equal(tokenData.sub, fakeAdmin._id.toString());
});

test("invalid user credentials are rejected", async () => {
  User.findOne = async () => null;

  const app = createApp();
  const response = await request(app)
    .post("/users/login")
    .send({ name: "alice", password: "wrong" });

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.success, false);
});

test("accounts can sign in without email verification", async () => {
  User.findOne = async () => ({
    _id: new mongoose.Types.ObjectId(),
    name: "alice",
    email: "alice@example.com",
    emailVerified: false,
    correctPassword: async () => true,
  });

  const response = await request(createApp())
    .post("/users/login")
    .send({ name: "alice", password: "correct-password" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.ok(response.body.data.token);
});

test("registration creates an account without sending email", async () => {
  User.findOne = async () => null;
  User.prototype.save = async function () {
    this._id = new mongoose.Types.ObjectId();
    this.createdAt = new Date();
    return this;
  };

  const response = await request(createApp())
    .post("/users/register")
    .send({
      name: "alice",
      email: "alice@example.com",
      password: "StrongPass1!",
    });

  assert.equal(response.statusCode, 201);
  assert.equal(response.body.success, true);
  assert.ok(response.body.data.token);
  assert.equal(response.body.data.user.email, "alice@example.com");
  assert.equal(response.body.data.user.emailVerified, false);
  assert.match(response.body.message, /created/i);
});

test("registration rejects malformed email before database access", async () => {
  User.findOne = async () => {
    throw new Error("Database should not be queried for invalid input");
  };

  const response = await request(createApp())
    .post("/users/register")
    .send({
      name: "alice",
      email: "not-an-email",
      password: "StrongPass1!",
    });

  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /valid email/i);
});

test("registration rejects weak passwords before database access", async () => {
  User.findOne = async () => {
    throw new Error("Database should not be queried for invalid input");
  };

  const response = await request(createApp())
    .post("/users/register")
    .send({
      name: "alice",
      email: "alice@example.com",
      password: "short",
    });

  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /8 characters/i);
});

test("password changes reject weak new passwords", async () => {
  const fakeUser = {
    _id: new mongoose.Types.ObjectId(),
    name: "alice",
    correctPassword: async () => true,
  };
  User.findById = async () => fakeUser;

  const response = await request(createApp())
    .put("/users/profile")
    .set("Authorization", `Bearer ${issueUserToken(fakeUser)}`)
    .send({ name: "alice", currentPassword: "OldPass1!", password: "weak" });

  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /at least 8 characters/i);
});

test("protected user profile route rejects missing token", async () => {
  const app = createApp();
  const response = await request(app).get("/users/profile");

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.success, false);
});

test("protected user profile route rejects invalid token", async () => {
  const app = createApp();
  const response = await request(app)
    .get("/users/profile")
    .set("Authorization", "Bearer not-a-valid-token");

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.success, false);
});

test("a user cannot impersonate another user when creating an order", async () => {
  const authUserId = new mongoose.Types.ObjectId();
  const fakeUser = {
    _id: authUserId,
    name: "buyer",
    correctPassword: async () => true,
  };

  User.findById = async () => fakeUser;

  let saveCalled = false;
  Order.prototype.save = async function () {
    saveCalled = true;
    return this;
  };

  const app = createApp();
  const token = issueUserToken(fakeUser);
  const response = await request(app)
    .post("/orders")
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", "00000000-0000-4000-8000-000000000010")
    .send({
      userID: new mongoose.Types.ObjectId().toString(),
      items: [{ productID: "p1", productName: "Product", quantity: 1, price: 10 }],
      totalPrice: 10,
      shippingAddress: { phone: "123", street: "Main", city: "Addis" },
      paymentMethod: "cod",
      orderTotal: { subtotal: 10, total: 10 },
    });

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.success, false);
  assert.equal(saveCalled, false);
});

test("order totals and initial states are derived from server product data", async () => {
  const productId = new mongoose.Types.ObjectId();
  const buyer = { _id: new mongoose.Types.ObjectId(), name: "buyer" };
  const product = {
    _id: productId,
    name: "Admin catalog phone",
    price: 180,
    offerPrice: 150,
    quantity: 8,
  };
  User.findById = async () => buyer;
  User.findOne = () => ({ session: async () => buyer });
  StoreSettings.findOne = async () => ({
    deliveryFee: 0,
    paymentMethods: [{ code: "cod", title: "Cash on collection", enabled: true }],
  });
  OrderIdempotency.collection.createIndex = async () => "unique-index";
  OrderIdempotency.findOne = async () => null;
  OrderIdempotency.create = async ([record]) => [record];
  Product.findOneAndUpdate = async (_filter, update) => {
    assert.deepEqual(update, { $inc: { quantity: -2 } });
    return product;
  };
  mongoose.startSession = async () => ({
    withTransaction: async (work) => work(),
    endSession: async () => {},
  });
  Order.create = async ([order]) => [order];

  const response = await request(createApp())
    .post("/orders")
    .set("Authorization", `Bearer ${issueUserToken(buyer)}`)
    .set("Idempotency-Key", "00000000-0000-4000-8000-000000000011")
    .send({
      items: [{
        productID: productId.toString(),
        productName: "Fake client name",
        quantity: 2,
        price: 0.01,
      }],
      totalPrice: 0.02,
      orderTotal: { subtotal: 0.02, total: 0.02 },
      orderStatus: "delivered",
      paymentStatus: "verified",
      shippingAddress: { phone: "123", street: "Main", city: "Addis" },
      paymentMethod: "cod",
    });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.data.items[0].productName, "Admin catalog phone");
  assert.equal(response.body.data.items[0].price, 150);
  assert.equal(response.body.data.totalPrice, 300);
  assert.equal(response.body.data.orderTotal.total, 300);
  assert.equal(response.body.data.orderStatus, "pending");
  assert.equal(response.body.data.paymentStatus, "pending");
});

test("a user cannot read another user's order", async () => {
  const authUserId = new mongoose.Types.ObjectId();
  const otherUserId = new mongoose.Types.ObjectId();
  const fakeUser = {
    _id: authUserId,
    name: "buyer",
    correctPassword: async () => true,
  };

  User.findById = async () => fakeUser;

  const app = createApp();
  const token = issueUserToken(fakeUser);
  const response = await request(app)
    .get(`/orders/orderByUserId/${otherUserId.toString()}`)
    .set("Authorization", `Bearer ${token}`);

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.success, false);
});

test("a user cannot read an order with a missing owner reference", async () => {
  const fakeUser = {
    _id: new mongoose.Types.ObjectId(),
    name: "buyer",
  };
  User.findById = async () => fakeUser;
  Order.findById = () => ({
    populate: async () => ({ _id: new mongoose.Types.ObjectId(), userID: null }),
  });

  const response = await request(createApp())
    .get(`/orders/${new mongoose.Types.ObjectId()}`)
    .set("Authorization", `Bearer ${issueUserToken(fakeUser)}`);

  assert.equal(response.statusCode, 403);
  assert.equal(response.body.success, false);
});

test("admin login token authorizes admin profile access", async () => {
  const fakeAdmin = {
    _id: new mongoose.Types.ObjectId(),
    username: "superadmin",
    name: "Super Admin",
    email: "admin@example.com",
    clearanceLevel: "super_admin",
    isActive: true,
  };

  AdminUser.findById = async () => fakeAdmin;

  const app = createApp();
  const token = issueAdminToken(fakeAdmin);
  const response = await request(app)
    .get("/admin-users/profile")
    .set("Authorization", `Bearer ${token}`);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.username, fakeAdmin.username);
});

test("invalid admin token is rejected", async () => {
  const app = createApp();
  const response = await request(app)
    .get("/admin-users/profile")
    .set("Authorization", "Bearer invalid.admin.token");

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.success, false);
});
