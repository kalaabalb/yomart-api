const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
process.env.JWT_SECRET ||= "support-content-tests-only-secret-value";
const SupportContent = require("../model/supportContent");
const AdminUser = require("../model/adminUser");
const { issueAdminToken } = require("../middleware/adminAccess");
const routes = require("../routes/supportContent");

const originals = {
  find: SupportContent.find, create: SupportContent.create,
  update: SupportContent.findByIdAndUpdate, remove: SupportContent.findByIdAndDelete,
  admin: AdminUser.findById,
};
const app = () => { const server = express(); server.use(express.json()); server.use("/support-content", routes); return server; };
const token = (role = "admin") => issueAdminToken({ _id: "0123456789abcdef01234567", clearanceLevel: role });
const listQuery = (rows) => ({ select() { return this; }, sort(value) { assert.deepEqual(value, { sortOrder: 1, _id: 1 }); return this; }, lean: async () => rows });
test.afterEach(() => {
  SupportContent.find = originals.find; SupportContent.create = originals.create;
  SupportContent.findByIdAndUpdate = originals.update; SupportContent.findByIdAndDelete = originals.remove;
  AdminUser.findById = originals.admin;
});

test("public support API lists only published sanitized content without writes", async () => {
  let query;
  SupportContent.find = (filter) => { query = filter; return listQuery([
    { title: "Contact options", body: "Use the contact details shown here.", sortOrder: 1, isActive: true, internalNote: "private" },
  ]); };
  SupportContent.create = () => { throw new Error("GET must not write"); };
  const response = await request(app()).get("/support-content");
  assert.equal(response.status, 200); assert.deepEqual(query, { isActive: true });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.body.data, [{ title: "Contact options", body: "Use the contact details shown here.", sortOrder: 1 }]);
});

test("support content GET returns an empty list when nothing is published", async () => {
  SupportContent.find = () => listQuery([]);
  const response = await request(app()).get("/support-content");
  assert.equal(response.status, 200); assert.deepEqual(response.body.data, []);
});

test("anonymous and moderator cannot manage support content", async () => {
  assert.equal((await request(app()).post("/support-content").send({})).status, 401);
  AdminUser.findById = async (id) => ({ _id: id, clearanceLevel: "moderator", isActive: true });
  const response = await request(app()).post("/support-content").set("Authorization", `Bearer ${token("moderator")}`).send({});
  assert.equal(response.status, 403);
});

test("authorized admins can add, edit, unpublish, and delete plain-text help entries", async () => {
  AdminUser.findById = async (id) => ({ _id: id, clearanceLevel: "admin", isActive: true });
  let stored;
  SupportContent.create = async (value) => (stored = { ...value, _id: "0123456789abcdef01234567" });
  SupportContent.findByIdAndUpdate = async (_id, update) => (stored = { ...stored, ...update.$set });
  SupportContent.findByIdAndDelete = async () => stored;
  const auth = { Authorization: `Bearer ${token()}` };
  const created = await request(app()).post("/support-content").set(auth).send({ title: "Help", body: "Instructions", isActive: true });
  assert.equal(created.status, 201); assert.equal(created.body.data.isActive, true);
  const edited = await request(app()).put("/support-content/0123456789abcdef01234567").set(auth).send({ title: "Updated help", body: "Updated instructions", isActive: false, sortOrder: 2 });
  assert.equal(edited.status, 200); assert.equal(edited.body.data.isActive, false); assert.equal(edited.body.data.sortOrder, 2);
  assert.equal((await request(app()).delete("/support-content/0123456789abcdef01234567").set(auth)).status, 200);
});

test("support editor rejects markup, invalid states, and out-of-range text", async () => {
  AdminUser.findById = async (id) => ({ _id: id, clearanceLevel: "super_admin", isActive: true });
  for (const body of [
    { title: "<script>", body: "help" },
    { title: "Help", body: "<img src=x>" },
    { title: "Help", body: "help", isActive: "true" },
    { title: "x".repeat(101), body: "help" },
  ]) {
    assert.equal((await request(app()).post("/support-content").set("Authorization", `Bearer ${token("super_admin")}`).send(body)).status, 400);
  }
});
