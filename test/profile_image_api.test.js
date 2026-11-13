const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "yomart-profile-image-test-"));
const publicRoot = path.join(os.tmpdir(), `yomart-profile-public-${crypto.randomUUID()}`);
process.env.JWT_SECRET ||= "profile-image-tests-only-secret-value";
process.env.UPLOADS_DIR = publicRoot;
process.env.PAYMENT_PROOFS_DIR = path.join(root, "private");
delete process.env.CLOUDINARY_CLOUD_NAME;
delete process.env.CLOUDINARY_API_KEY;
delete process.env.CLOUDINARY_API_SECRET;

const express = require("express");
const request = require("supertest");
const sharp = require("sharp");
const User = require("../model/user");
const { issueUserToken } = require("../middleware/adminAccess");
const { profileImageLocation } = require("../uploadFile");
const routes = require("../routes/user");

const ownerId = "0123456789abcdef01234567";
let savedUser;
const originalFindById = User.findById;
const originalSave = User.prototype.save;
function userQuery() {
  return {
    select() { return this; },
    then(resolve, reject) { return Promise.resolve(savedUser).then(resolve, reject); },
  };
}
const app = () => { const server = express(); server.use(express.json()); server.use("/users", routes); return server; };
const auth = () => `Bearer ${issueUserToken({ _id: ownerId })}`;

test.beforeEach(() => {
  savedUser = { _id: ownerId, name: "Customer", email: "private@example.invalid", accountStatus: "active", profileImageKey: undefined, save: async function () { savedUser = this; } };
  User.findById = () => userQuery();
  User.prototype.save = originalSave;
});
test.after(() => {
  User.findById = originalFindById;
  User.prototype.save = originalSave;
  return Promise.all([fsp.rm(root, { recursive: true, force: true }), fsp.rm(publicRoot, { recursive: true, force: true })]);
});

test("profile images require an authenticated customer session", async () => {
  assert.equal((await request(app()).get("/users/profile/image")).status, 401);
  assert.equal((await request(app()).delete("/users/profile/image")).status, 401);
});

test("owner can upload, retrieve, replace and remove a private profile image", async () => {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123456" } }).png().toBuffer();
  const uploaded = await request(app()).post("/users/profile/image").set("Authorization", auth()).attach("image", png, { filename: "avatar.png", contentType: "image/png" });
  assert.equal(uploaded.status, 200, uploaded.text);
  assert.equal(uploaded.body.data.profileImageAvailable, true);
  assert.equal(JSON.stringify(uploaded.body).includes("profile-images/"), false);
  const firstKey = savedUser.profileImageKey;
  assert.ok(profileImageLocation(firstKey, ownerId));

  const retrieved = await request(app()).get("/users/profile/image").set("Authorization", auth());
  assert.equal(retrieved.status, 200); assert.equal(retrieved.headers["content-type"], "image/webp");
  assert.match(retrieved.headers["cache-control"], /private/); assert.match(retrieved.headers["cache-control"], /no-store/);

  const replacement = await request(app()).post("/users/profile/image").set("Authorization", auth()).attach("image", png, { filename: "new-avatar.png", contentType: "image/png" });
  assert.equal(replacement.status, 200); assert.notEqual(savedUser.profileImageKey, firstKey);
  assert.equal(await fsp.access(path.join(process.env.PAYMENT_PROOFS_DIR, firstKey.slice("profile:".length))).then(() => true, () => false), false);

  const removed = await request(app()).delete("/users/profile/image").set("Authorization", auth());
  assert.equal(removed.status, 200); assert.equal(removed.body.data.profileImageAvailable, false);
  assert.equal((await request(app()).get("/users/profile/image").set("Authorization", auth())).status, 404);
});

test("profile image rejects unsupported media and malformed owner references", async () => {
  const response = await request(app()).post("/users/profile/image").set("Authorization", auth()).attach("image", Buffer.from("not an image"), { filename: "avatar.svg", contentType: "image/svg+xml" });
  assert.equal(response.status, 400);
  assert.equal(profileImageLocation("profile:profile-images/aaaaaaaaaaaaaaaaaaaaaaaa/profile_12345678-1234-1234-1234-123456789abc", ownerId), null);
  assert.equal(profileImageLocation(`profile:profile-images/${ownerId}/profile_12345678-1234-1234-1234-123456789abc`, "aaaaaaaaaaaaaaaaaaaaaaaa"), null);
});
