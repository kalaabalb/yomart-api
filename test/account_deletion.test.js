const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const mongoose = require("mongoose");
const User = require("../model/user");
const Order = require("../model/order");
const Rating = require("../model/rating");
const PaymentProof = require("../model/paymentProof");
const originalStartSession = mongoose.startSession;
const { issueUserToken } = require("../middleware/adminAccess");

process.env.JWT_SECRET ||= "account-deletion-test-secret";

const originals = {
  findOne: User.findOne,
  findById: User.findById,
  userDeleteOne: User.deleteOne,
  orderFind: Order.find,
  orderDeleteMany: Order.deleteMany,
  orderUpdateMany: Order.updateMany,
  userUpdateOne: User.updateOne,
  proofUpdateMany: PaymentProof.updateMany,
  ratingDeleteMany: Rating.deleteMany,
};

function app() {
  const server = express();
  server.use(express.json());
  server.use("/users", require("../routes/user"));
  return server;
}

test.afterEach(() => {
  User.findOne = originals.findOne;
  User.findById = originals.findById;
  User.deleteOne = originals.userDeleteOne;
  Order.find = originals.orderFind;
  Order.deleteMany = originals.orderDeleteMany;
  Order.updateMany = originals.orderUpdateMany;
  User.updateOne = originals.userUpdateOne;
  PaymentProof.updateMany = originals.proofUpdateMany;
  Rating.deleteMany = originals.ratingDeleteMany;
  mongoose.startSession = originalStartSession;
});

test("external account deletion verifies credentials and anonymizes retained evidence", async () => {
  const user = {
    _id: new mongoose.Types.ObjectId(),
    correctPassword: async (value) => value === "StrongPassword1!",
  };
  const actions = [];
  mongoose.startSession = async () => ({ withTransaction: async (operation) => operation(), endSession: async () => {} });
  User.findOne = async (query) => {
    assert.deepEqual(query, { email: "buyer@example.com" });
    return user;
  };
  Order.updateMany = async (query, update) => actions.push(["orders-anonymized", query, update]);
  PaymentProof.updateMany = async (query, update) => actions.push(["proof-access-revoked", query, update]);
  Rating.deleteMany = async (query) => actions.push(["ratings", query]);
  User.updateOne = async (query, update) => actions.push(["account-disabled", query, update]);

  const response = await request(app())
    .post("/users/account-deletion")
    .send({ email: " Buyer@Example.com ", password: "StrongPassword1!" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.match(response.body.message, /Order and payment evidence is retained in anonymized form/);
  assert.deepEqual(actions.map(([name]) => name), ["orders-anonymized", "proof-access-revoked", "ratings", "account-disabled"]);
  assert.ok(actions.every(([, query]) => query.userId || query.userID || query.ownerId || query._id));
  assert.deepEqual(actions[0][2].$set["shippingAddress.phone"], "");
  assert.deepEqual(actions[1][2].$set.accessRevokedAt instanceof Date, true);
  assert.equal(actions[3][2].$set.accountStatus, "deleted");
});

test("external account deletion does not delete data for an invalid password", async () => {
  const user = {
    _id: new mongoose.Types.ObjectId(),
    correctPassword: async () => false,
  };
  User.findOne = async () => user;
  Order.find = () => {
    throw new Error("orders must not be modified for an invalid password");
  };

  const response = await request(app())
    .post("/users/account-deletion")
    .send({ email: "buyer@example.com", password: "wrong" });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.success, false);
});

test("in-app account deletion requires an authenticated session", async () => {
  const response = await request(app())
    .delete("/users/account")
    .send({ currentPassword: "StrongPassword1!" });
  assert.equal(response.statusCode, 401);
});
