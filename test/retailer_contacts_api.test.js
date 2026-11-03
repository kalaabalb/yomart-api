const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const RetailerContact = require("../model/retailerContact");
const AdminUser = require("../model/adminUser");
const { issueAdminToken } = require("../middleware/adminAccess");
const { normalizeAndValidateContact, toPublicContact } = require("../utils/retailerContact");
const routes = require("../routes/retailerContacts");

process.env.JWT_SECRET ||= "retailer-contact-tests-only-secret-value";
const originals = {
  find: RetailerContact.find,
  create: RetailerContact.create,
  findByIdAndUpdate: RetailerContact.findByIdAndUpdate,
  findByIdAndDelete: RetailerContact.findByIdAndDelete,
  adminFindById: AdminUser.findById,
};
function app() { const server = express(); server.use(express.json()); server.use("/retailer-contacts", routes); return server; }
function adminToken(clearanceLevel = "admin") {
  return issueAdminToken({ _id: `test-${clearanceLevel}`, clearanceLevel });
}
test.afterEach(() => {
  RetailerContact.find = originals.find;
  RetailerContact.create = originals.create;
  RetailerContact.findByIdAndUpdate = originals.findByIdAndUpdate;
  RetailerContact.findByIdAndDelete = originals.findByIdAndDelete;
  AdminUser.findById = originals.adminFindById;
});

test("validates and normalizes multiple supported contact types without fixed contact values", () => {
  assert.equal(normalizeAndValidateContact({ label: "Phone", type: "phone", value: "+251 911 234 567" }).value.value, "+251 911 234 567");
  assert.equal(normalizeAndValidateContact({ label: "Telegram", type: "telegram", value: "@sample_contact" }).value.value, "sample_contact");
  assert.equal(normalizeAndValidateContact({ label: "WhatsApp", type: "whatsapp", value: "+251 911 234 567" }).value.value, "251911234567");
  assert.match(normalizeAndValidateContact({ label: "Web", type: "website", value: "https://example.org/help" }).value.value, /^https:/);
  assert.match(normalizeAndValidateContact({ label: "Unsafe", type: "other", value: "javascript:alert(1)" }).error, /HTTPS/);
});

test("public endpoint reads only active contacts, orders stably, and returns a safe customer projection", async () => {
  let filter;
  let sort;
  RetailerContact.find = (query) => {
    filter = query;
    return { select(selection) { assert.match(selection, /-_id/); return this; }, sort(value) { sort = value; return this; }, lean: async () => [
      { label: "Call", description: "Support", type: "phone", value: "+251 911 234 567", placement: "support_page", displayOrder: 2, isActive: true, internalNote: "private" },
      { label: "Telegram", description: "", type: "telegram", value: "sample_contact", placement: "all", displayOrder: 2, isActive: true, internalNote: "private" },
    ] };
  };
  const response = await request(app()).get("/retailer-contacts");
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(filter, { isActive: true });
  assert.deepEqual(sort, { displayOrder: 1, _id: 1 });
  assert.equal(response.body.data.length, 2);
  assert.equal(response.body.data[0].href, "tel:+251911234567");
  assert.equal(response.body.data[1].href, "https://t.me/sample_contact");
  assert.equal("isActive" in response.body.data[0], false);
  assert.equal("internalNote" in response.body.data[0], false);
  assert.equal("_id" in response.body.data[0], false);
});

test("public endpoint returns a clean empty list and does not write", async () => {
  RetailerContact.find = () => ({ select() { return this; }, sort() { return this; }, lean: async () => [] });
  RetailerContact.create = () => { throw new Error("public GET must never create contacts"); };
  const response = await request(app()).get("/retailer-contacts");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, []);
});

test("admin contact mutations reject anonymous and moderator users", async () => {
  const anonymous = await request(app()).post("/retailer-contacts").send({});
  assert.equal(anonymous.status, 401);
  AdminUser.findById = async (id) => ({ _id: id, clearanceLevel: "moderator", isActive: true });
  const moderator = await request(app()).post("/retailer-contacts").set("Authorization", `Bearer ${adminToken("moderator")}`).send({});
  assert.equal(moderator.status, 403);
});

test("active admins can create, update, toggle, and delete contacts", async () => {
  let current = { _id: "contact-id", label: "Initial", type: "phone", value: "123456789", placement: "all", description: "", displayOrder: 0, isActive: true };
  AdminUser.findById = async (id) => ({ _id: id, clearanceLevel: "admin", isActive: true });
  RetailerContact.create = async (value) => ({ ...value, _id: "contact-id" });
  RetailerContact.findByIdAndUpdate = async (_id, update) => { current = { ...current, ...update.$set }; return current; };
  RetailerContact.findByIdAndDelete = async () => current;
  const token = adminToken("admin");
  const created = await request(app()).post("/retailer-contacts").set("Authorization", `Bearer ${token}`).send({ label: "Phone A", type: "phone", value: "+251911234567", placement: "product_details" });
  assert.equal(created.status, 201);
  const id = "0123456789abcdef01234567";
  const updated = await request(app()).put(`/retailer-contacts/${id}`).set("Authorization", `Bearer ${token}`).send({ label: "Phone B", type: "phone", value: "+251911234568", placement: "support_page", isActive: false });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.isActive, false);
  const removed = await request(app()).delete(`/retailer-contacts/${id}`).set("Authorization", `Bearer ${token}`);
  assert.equal(removed.status, 200);
});

test("the same admin can add multiple phone and Telegram entries", async () => {
  AdminUser.findById = async (id) => ({ _id: id, clearanceLevel: "admin", isActive: true });
  const saved = [];
  RetailerContact.create = async (value) => {
    saved.push(value);
    return { ...value, _id: `contact-${saved.length}` };
  };
  const token = adminToken();
  for (const entry of [
    { label: "Primary phone", type: "phone", value: "+251911234567", placement: "support_page" },
    { label: "Alternate phone", type: "phone", value: "+251922345678", placement: "storefront_footer" },
    { label: "Primary Telegram", type: "telegram", value: "sample_primary" },
    { label: "Alternate Telegram", type: "telegram", value: "sample_alternate" },
  ]) {
    const response = await request(app()).post("/retailer-contacts")
      .set("Authorization", `Bearer ${token}`).send(entry);
    assert.equal(response.status, 201);
  }
  assert.equal(saved.filter((item) => item.type === "phone").length, 2);
  assert.equal(saved.filter((item) => item.type === "telegram").length, 2);
});

test("inactive administrators are denied by the active-admin authentication middleware", async () => {
  AdminUser.findById = async (id) => ({ _id: id, clearanceLevel: "admin", isActive: false });
  const response = await request(app()).get("/retailer-contacts/admin").set("Authorization", `Bearer ${adminToken()}`);
  assert.equal(response.status, 401);
});

test("public contact serialization emits only validated link schemes", () => {
  const parsed = normalizeAndValidateContact({ label: "Email", type: "email", value: "help@example.org" });
  const output = toPublicContact(parsed.value);
  assert.equal(output.href, "mailto:help@example.org");
  assert.ok(normalizeAndValidateContact({ label: "Unsafe email", type: "email", value: "help@example.org?subject=hello" }).error);
  assert.equal(Object.hasOwn(output, "isActive"), false);
});
