const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const request = require("supertest");
const mongoose = require("mongoose");
const axios = require("axios");
const sharp = require("sharp");

process.env.PAYMENT_PROOFS_DIR = path.join(os.tmpdir(), "yomart-proof-test-storage");
process.env.UPLOADS_DIR = path.join(os.tmpdir(), "yomart-legacy-public-uploads");
process.env.JWT_SECRET = "payment-proof-test-secret";
const paymentRoutes = require("../routes/payment");
const uploadFile = require("../uploadFile");
const User = require("../model/user");
const AdminUser = require("../model/adminUser");
const Order = require("../model/order");
const PaymentProof = require("../model/paymentProof");
const { issueUserToken, issueAdminToken } = require("../middleware/adminAccess");

const original = { userFindById: User.findById, adminFindById: AdminUser.findById, orderFindById: Order.findById, paymentProofCreate: PaymentProof.create, paymentProofFindOne: PaymentProof.findOne };
const ownerId = new mongoose.Types.ObjectId();
const otherId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();
const superAdminId = new mongoose.Types.ObjectId();
const moderatorId = new mongoose.Types.ObjectId();
const orderId = new mongoose.Types.ObjectId();
const associatedProofRecordId = new mongoose.Types.ObjectId();
const proofId = `proof:payment-proofs/${ownerId}/payment_123e4567-e89b-12d3-a456-426614174000.webp`;
const fakeOrder = { _id: orderId, userID: ownerId, paymentProof: { storageKey: proofId, proofRecordId: associatedProofRecordId } };
let lastCreatedProof;

function syntheticSignedDownloadUrl(publicId, expiresAt) {
  const query = new URLSearchParams({
    api_key: process.env.CLOUDINARY_API_KEY,
    expires_at: String(expiresAt),
    format: "webp",
    public_id: publicId,
    signature: "synthetic-signature-value",
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: "authenticated",
  });
  return `https://api.cloudinary.com/v1_1/${encodeURIComponent(process.env.CLOUDINARY_CLOUD_NAME)}/image/download?${query}`;
}

function app() { const instance = express(); instance.use("/payment", paymentRoutes); instance.use(require("../middleware/errorHandler")); return instance; }

test.before(async () => {
  User.findById = async (id) => id.toString() === ownerId.toString() || id.toString() === otherId.toString()
    ? { _id: new mongoose.Types.ObjectId(id) } : null;
  AdminUser.findById = async (id) => id.toString() === adminId.toString()
    ? { _id: adminId, isActive: true, clearanceLevel: "admin" }
    : id.toString() === superAdminId.toString()
      ? { _id: superAdminId, isActive: true, clearanceLevel: "super_admin" }
    : id.toString() === moderatorId.toString()
      ? { _id: moderatorId, isActive: true, clearanceLevel: "moderator" }
      : null;
  Order.findById = async (id) => id.toString() === orderId.toString() ? fakeOrder : null;
  PaymentProof.create = async (values) => {
    lastCreatedProof = { _id: new mongoose.Types.ObjectId(), ...values };
    return lastCreatedProof;
  };
  PaymentProof.findOne = (filter) => ({
    select: async () => filter._id.toString() === associatedProofRecordId.toString() &&
      filter.ownerId.toString() === ownerId.toString() &&
      filter.orderId.toString() === orderId.toString() &&
      filter.status === "associated" && filter._id &&
      filter.orderId && filter.ownerId && proofId === fakeOrder.paymentProof.storageKey
      ? { _id: associatedProofRecordId, ownerId, orderId, status: "associated", storageKey: proofId }
      : null,
  });
  await fs.mkdir(path.join(process.env.PAYMENT_PROOFS_DIR, "payment-proofs", ownerId.toString()), { recursive: true });
  await fs.writeFile(path.join(process.env.PAYMENT_PROOFS_DIR, proofId.slice("proof:".length)), Buffer.from("test-image"));
  await fs.mkdir(path.join(process.env.UPLOADS_DIR, "payment-proofs", ownerId.toString()), { recursive: true });
  await fs.writeFile(path.join(process.env.UPLOADS_DIR, "payment-proofs", ownerId.toString(), "1792600000000_123e4567-e89b-12d3-a456-426614174000.webp"), Buffer.from("legacy-image"));
  await fs.mkdir(path.join(process.env.UPLOADS_DIR, "categories"), { recursive: true });
  await fs.writeFile(path.join(process.env.UPLOADS_DIR, "categories", "catalog.webp"), Buffer.from("public-catalog-image"));
});
test.after(async () => {
  User.findById = original.userFindById; AdminUser.findById = original.adminFindById; Order.findById = original.orderFindById; PaymentProof.create = original.paymentProofCreate; PaymentProof.findOne = original.paymentProofFindOne;
  await fs.rm(process.env.PAYMENT_PROOFS_DIR, { recursive: true, force: true });
  await fs.rm(process.env.UPLOADS_DIR, { recursive: true, force: true });
});

test("receipt endpoint rejects unauthenticated requests", async () => {
  const response = await request(app()).get(`/payment/proofs/${orderId}`);
  assert.equal(response.statusCode, 401);
});

test("base64 upload stores a private proof and returns an opaque ID, not a URL", async () => {
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer();
  const response = await request(app())
    .post("/payment/upload-proof-base64")
    .set("Authorization", `Bearer ${issueUserToken({ _id: ownerId })}`)
    .send({ image: `data:image/png;base64,${image.toString("base64")}` });
  assert.equal(response.statusCode, 200);
  assert.match(response.body.data.proofRecordId, /^[a-f\d]{24}$/i);
  assert.equal("proofId" in response.body.data, false);
  assert.equal("storageKey" in response.body.data, false);
  assert.equal("imageUrl" in response.body.data, false);
  const location = uploadFile.privateProofLocation(lastCreatedProof.storageKey);
  assert.ok(location);
  await fs.access(path.join(uploadFile.privateProofRoot, location.key));
});

test("multipart upload also stores outside the public media tree", async () => {
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer();
  const response = await request(app())
    .post("/payment/upload-proof")
    .set("Authorization", `Bearer ${issueUserToken({ _id: ownerId })}`)
    .attach("proofImage", image, { filename: "receipt.png", contentType: "image/png" });
  assert.equal(response.statusCode, 200);
  assert.equal("proofId" in response.body.data, false);
  assert.equal("storageKey" in response.body.data, false);
  const location = uploadFile.privateProofLocation(lastCreatedProof.storageKey);
  assert.ok(location);
  await fs.access(path.join(uploadFile.privateProofRoot, location.key));
  await assert.rejects(fs.access(path.join(process.env.UPLOADS_DIR, location.key)));
});

test("multipart upload returns a safe validation error for unsupported files", async () => {
  const response = await request(app())
    .post("/payment/upload-proof")
    .set("Authorization", `Bearer ${issueUserToken({ _id: ownerId })}`)
    .attach("proofImage", Buffer.from("not an image"), { filename: "receipt.txt", contentType: "text/plain" });
  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /supported JPG, PNG, or WebP/);
});

test("receipt endpoint allows the owning customer", async () => {
  const response = await request(app()).get(`/payment/proofs/${orderId}`).set("Authorization", `Bearer ${issueUserToken({ _id: ownerId })}`);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers["content-type"], "image/webp");
});

test("receipt endpoint blocks another customer's order even with a changed order ID", async () => {
  const response = await request(app()).get(`/payment/proofs/${orderId}`).set("Authorization", `Bearer ${issueUserToken({ _id: otherId })}`);
  assert.equal(response.statusCode, 404);
});

test("legacy local receipts are no longer reachable from public static URLs", async () => {
  const server = express();
  server.use("/uploads", uploadFile.createPublicUploadHandler());
  const response = await request(server).get(`/uploads/payment-proofs/${ownerId}/1792600000000_123e4567-e89b-12d3-a456-426614174000.webp`);
  assert.equal(response.statusCode, 404);
});

// Adversarial regression cases documented in docs/launch/PAYMENT_PROOF_SECURITY_REVIEW.md.
test("legacy receipt URL aliases stay denied while public catalog media remains available", async () => {
  const server = express();
  server.use("/uploads", uploadFile.createPublicUploadHandler());
  const aliases = [
    `/uploads//payment-proofs/${ownerId}/1792600000000_123e4567-e89b-12d3-a456-426614174000.webp`,
    `/uploads/payment-proofs%2F${ownerId}%2F1792600000000_123e4567-e89b-12d3-a456-426614174000.webp`,
  ];
  const statuses = [];
  for (const alias of aliases) {
    const response = await request(server).get(alias);
    statuses.push(response.statusCode);
  }
  assert.deepEqual(statuses, [404, 404], `private receipt escaped via an alias: ${statuses.join(", ")}`);
  const catalog = await request(server).get("/uploads/categories/catalog.webp");
  assert.equal(catalog.statusCode, 200);
  assert.equal(catalog.body.toString(), "public-catalog-image");
});

test("canonical storage validation rejects overlapping and symlinked roots", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "yomart-storage-root-audit-"));
  const publicRoot = path.join(base, "public");
  const privateChild = path.join(publicRoot, "private");
  const separatePrivate = path.join(base, "separate-private");
  await fs.mkdir(privateChild, { recursive: true });
  await fs.mkdir(separatePrivate, { recursive: true });
  assert.throws(() => uploadFile.assertStorageRootsDisjoint(publicRoot, publicRoot));
  assert.throws(() => uploadFile.assertStorageRootsDisjoint(publicRoot, privateChild));
  assert.throws(() => uploadFile.assertStorageRootsDisjoint(privateChild, publicRoot));
  const privateAlias = path.join(base, "private-alias");
  await fs.symlink(privateChild, privateAlias, "dir");
  assert.throws(() => uploadFile.assertStorageRootsDisjoint(publicRoot, privateAlias));
  assert.doesNotThrow(() => uploadFile.assertStorageRootsDisjoint(publicRoot, separatePrivate));
  await fs.rm(base, { recursive: true, force: true });
});

test("legacy receipt symlinks cannot expose files outside the receipt directory", async () => {
  const filename = "1792600000000_123e4567-e89b-12d3-a456-426614174001.webp";
  const directory = path.join(process.env.UPLOADS_DIR, "payment-proofs", ownerId.toString());
  await fs.symlink("/etc/passwd", path.join(directory, filename));
  const server = express();
  server.get("/receipt", async (_req, res) => {
    const delivered = await uploadFile.deliverLegacyPaymentProof(
      `/uploads/payment-proofs/${ownerId}/${filename}`,
      ownerId.toString(),
      res,
    );
    if (!delivered) res.sendStatus(404);
  });
  const response = await request(server).get("/receipt");
  assert.equal(response.statusCode, 404);
});

test("new private proof files and symlinked directories cannot escape private storage", async () => {
  const filename = "payment_123e4567-e89b-12d3-a456-426614174002.webp";
  const ownerDirectory = path.join(uploadFile.privateProofRoot, "payment-proofs", ownerId.toString());
  await fs.mkdir(ownerDirectory, { recursive: true });
  await fs.symlink("/etc/passwd", path.join(ownerDirectory, filename));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "yomart-private-link-target-"));
  const otherOwnerId = new mongoose.Types.ObjectId();
  await fs.writeFile(path.join(outside, "payment_123e4567-e89b-12d3-a456-426614174003.webp"), "not a receipt");
  await fs.symlink(outside, path.join(uploadFile.privateProofRoot, "payment-proofs", otherOwnerId.toString()), "dir");

  const server = express();
  server.get("/private/:proofId", async (req, res) => {
    const delivered = await uploadFile.deliverPrivatePaymentProof(`proof:${decodeURIComponent(req.params.proofId)}`, res);
    if (!delivered) res.sendStatus(404);
  });
  const fileLink = await request(server).get(`/private/${encodeURIComponent(`payment-proofs/${ownerId}/${filename}`)}`);
  const directoryLink = await request(server).get(`/private/${encodeURIComponent(`payment-proofs/${otherOwnerId}/payment_123e4567-e89b-12d3-a456-426614174003.webp`)}`);
  assert.equal(fileLink.statusCode, 404);
  assert.equal(directoryLink.statusCode, 404);
  await fs.rm(outside, { recursive: true, force: true });
});

test("local proof deletion is idempotent and refuses final-file and parent-directory symlinks", { skip: process.platform !== "linux" }, async () => {
  const cloudNames = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"];
  const oldCloudConfig = Object.fromEntries(cloudNames.map((name) => [name, process.env[name]]));
  cloudNames.forEach((name) => delete process.env[name]);
  const ownerDirectory = path.join(uploadFile.privateProofRoot, "payment-proofs", ownerId.toString());
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "yomart-proof-delete-target-"));
  const finalFilename = "payment_123e4567-e89b-12d3-a456-426614174010.webp";
  const externalFile = path.join(outside, "external.webp");
  await fs.mkdir(ownerDirectory, { recursive: true });
  await fs.writeFile(externalFile, "keep this file");
  try {
    await fs.symlink(externalFile, path.join(ownerDirectory, finalFilename));
    await assert.rejects(uploadFile.deletePrivatePaymentProof(`proof:payment-proofs/${ownerId}/${finalFilename}`));
    assert.equal(await fs.readFile(externalFile, "utf8"), "keep this file");
    await fs.rm(path.join(ownerDirectory, finalFilename));

    const otherOwner = new mongoose.Types.ObjectId();
    const symlinkOwnerDirectory = path.join(uploadFile.privateProofRoot, "payment-proofs", otherOwner.toString());
    const directoryFilename = "payment_123e4567-e89b-12d3-a456-426614174012.webp";
    await fs.copyFile(externalFile, path.join(outside, directoryFilename));
    await fs.symlink(outside, symlinkOwnerDirectory, "dir");
    await assert.rejects(uploadFile.deletePrivatePaymentProof(`proof:payment-proofs/${otherOwner}/${directoryFilename}`));
    assert.equal(await fs.readFile(externalFile, "utf8"), "keep this file");
    await fs.rm(symlinkOwnerDirectory);

    const regularFilename = "payment_123e4567-e89b-12d3-a456-426614174011.webp";
    const regularPath = path.join(ownerDirectory, regularFilename);
    await fs.writeFile(regularPath, "receipt");
    await uploadFile.deletePrivatePaymentProof(`proof:payment-proofs/${ownerId}/${regularFilename}`);
    await uploadFile.deletePrivatePaymentProof(`proof:payment-proofs/${ownerId}/${regularFilename}`);
    await assert.rejects(fs.stat(regularPath), { code: "ENOENT" });
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
    for (const name of cloudNames) {
      if (oldCloudConfig[name] === undefined) delete process.env[name];
      else process.env[name] = oldCloudConfig[name];
    }
  }
});

test("invalid image bytes with an accepted multipart MIME do not crash the API process", () => {
  const script = String.raw`
    process.env.PAYMENT_PROOFS_DIR = require('node:path').join(require('node:os').tmpdir(), 'yomart-bad-proof-child');
    process.env.UPLOADS_DIR = require('node:path').join(require('node:os').tmpdir(), 'yomart-bad-upload-child');
    process.env.JWT_SECRET = 'payment-proof-child-test-secret';
    const express = require('express');
    const request = require('supertest');
    const mongoose = require('mongoose');
    const User = require('./model/user');
    const { issueUserToken } = require('./middleware/adminAccess');
    const owner = new mongoose.Types.ObjectId();
    User.findById = async id => ({ _id: new mongoose.Types.ObjectId(id) });
    const app = express();
    app.use('/payment', require('./routes/payment'));
    app.use(require('./middleware/errorHandler'));
    request(app).post('/payment/upload-proof')
      .set('Authorization', 'Bearer ' + issueUserToken({ _id: owner }))
      .attach('proofImage', Buffer.from('not actually a PNG'), { filename: 'bad.png', contentType: 'image/png' })
      .then(response => { console.log('HTTP ' + response.statusCode); })
      .catch(error => { console.error(error.message); process.exitCode = 2; });
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 0, `multipart request terminated its child process: ${result.stderr}`);
  assert.match(result.stdout, /HTTP 400/);
});

test("truncated multipart parser input returns a controlled 400 response", async () => {
  const response = await request(app())
    .post("/payment/upload-proof")
    .set("Authorization", `Bearer ${issueUserToken({ _id: ownerId })}`)
    .set("Content-Type", "multipart/form-data; boundary=receipt-boundary")
    .send("--receipt-boundary\r\nContent-Disposition: form-data; name=\"proofImage\"; filename=\"partial.png\"\r\nContent-Type: image/png\r\n\r\npartial");
  assert.equal(response.statusCode, 400);
});

test("authorized retrieval can still serve a matching legacy local receipt", async () => {
  const url = `/uploads/payment-proofs/${ownerId}/1792600000000_123e4567-e89b-12d3-a456-426614174000.webp`;
  const server = express();
  server.get("/receipt", async (req, res) => {
    const delivered = await uploadFile.deliverLegacyPaymentProof(url, req.query.owner, res);
    if (!delivered) res.sendStatus(404);
  });
  const allowed = await request(server).get(`/receipt?owner=${ownerId}`);
  const denied = await request(server).get(`/receipt?owner=${otherId}`);
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.body.toString(), "legacy-image");
  assert.equal(denied.statusCode, 404);
});

test("legacy Cloudinary public receipt URLs are never fetched, even when they look valid", async () => {
  const names = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const oldGet = axios.get;
  process.env.CLOUDINARY_CLOUD_NAME = "synthetic-cloud";
  process.env.CLOUDINARY_API_KEY = "synthetic-key";
  process.env.CLOUDINARY_API_SECRET = "synthetic-secret";
  let fetchCount = 0;
  axios.get = async () => { fetchCount += 1; throw new Error("unexpected fetch"); };
  const urls = [
    `https://res.cloudinary.com/synthetic-cloud/image/upload/v1/payment-proofs/${ownerId}/receipt.webp`,
    `https://res.cloudinary.com/synthetic-cloud/image/upload/c_scale,w_800/v1/payment-proofs/${ownerId}/receipt.webp`,
    `https://res.cloudinary.com/synthetic-cloud/image/upload/v1/payment-proofs/${ownerId}/receipt.webp?version=1`,
  ];
  try {
    for (const url of urls) {
      assert.equal(await uploadFile.deliverLegacyPaymentProof(url, ownerId.toString(), { set() {}, destroy() {} }), false);
    }
    assert.equal(fetchCount, 0);
  } finally {
    axios.get = oldGet;
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("order proof endpoint fails closed for legacy public Cloudinary URLs without fetching them", async () => {
  const names = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const oldGet = axios.get;
  let fetchCount = 0;
  names.forEach(name => { process.env[name] = `synthetic-${name.toLowerCase()}`; });
  axios.get = async () => { fetchCount += 1; throw new Error("must never fetch a legacy provider URL"); };
  const saved = fakeOrder.paymentProof;
  fakeOrder.paymentProof = { imageUrl: `https://res.cloudinary.com/synthetic-cloud/image/upload/v1/payment-proofs/${ownerId}/legacy.webp` };
  try {
    const response = await request(app()).get(`/payment/proofs/${orderId}`)
      .set("Authorization", `Bearer ${issueUserToken({ _id: ownerId })}`);
    assert.equal(response.statusCode, 404);
    assert.equal(response.body.message, "Payment proof is unavailable.");
    assert.equal(fetchCount, 0);
    assert.doesNotMatch(JSON.stringify(response.body), /cloudinary|legacy\.webp|storageKey|imageUrl/i);
  } finally {
    fakeOrder.paymentProof = saved;
    axios.get = oldGet;
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("private proof metadata without its proof record fails closed without legacy fallback", async () => {
  const saved = fakeOrder.paymentProof;
  fakeOrder.paymentProof = { storageKey: proofId, imageUrl: `https://res.cloudinary.com/synthetic-cloud/image/upload/receipt.webp` };
  const oldGet = axios.get;
  let fetchCount = 0;
  axios.get = async () => { fetchCount += 1; throw new Error("must not fetch fallback URL"); };
  try {
    const response = await request(app()).get(`/payment/proofs/${orderId}`)
      .set("Authorization", `Bearer ${issueUserToken({ _id: ownerId })}`);
    assert.equal(response.statusCode, 404);
    assert.equal(response.body.message, "Payment proof is unavailable.");
    assert.equal(fetchCount, 0);
  } finally {
    fakeOrder.paymentProof = saved;
    axios.get = oldGet;
  }
});

test("orders with missing owner metadata return a controlled proof-not-found response", async () => {
  const oldFindById = Order.findById;
  Order.findById = async () => ({ _id: orderId, paymentProof: { imageUrl: "https://provider.invalid/legacy.webp" } });
  try {
    const response = await request(app()).get(`/payment/proofs/${orderId}`)
      .set("Authorization", `Bearer ${issueAdminToken({ _id: adminId, clearanceLevel: "admin" })}`);
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.body, { success: false, message: "Payment proof not found." });
  } finally {
    Order.findById = oldFindById;
  }
});

test("Cloudinary retrieval failure returns a generic unavailable response without provider details", async () => {
  const cloudinary = uploadFile.cloudinary;
  const names = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const oldSigning = cloudinary.utils.private_download_url;
  const oldGet = axios.get;
  names.forEach(name => { process.env[name] = `synthetic-${name.toLowerCase()}`; });
  cloudinary.utils.private_download_url = (publicId, _format, options) => syntheticSignedDownloadUrl(publicId, options.expires_at);
  axios.get = async () => { throw new Error("synthetic provider error containing private diagnostic details"); };
  try {
    const response = await request(app()).get(`/payment/proofs/${orderId}`)
      .set("Authorization", `Bearer ${issueUserToken({ _id: ownerId })}`);
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.body, { success: false, message: "Payment proof is unavailable." });
    assert.doesNotMatch(JSON.stringify(response.body), /cloudinary|signature|storageKey|payment-proofs|synthetic/i);
  } finally {
    cloudinary.utils.private_download_url = oldSigning;
    axios.get = oldGet;
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("authenticated administrators can review receipts", async () => {
  const response = await request(app()).get(`/payment/proofs/${orderId}`).set("Authorization", `Bearer ${issueAdminToken({ _id: adminId, clearanceLevel: "admin" })}`);
  assert.equal(response.statusCode, 200);
});

test("authenticated super-admins can review receipts", async () => {
  const response = await request(app()).get(`/payment/proofs/${orderId}`).set("Authorization", `Bearer ${issueAdminToken({ _id: superAdminId, clearanceLevel: "super_admin" })}`);
  assert.equal(response.statusCode, 200);
});

test("moderators without payment-review clearance cannot access receipts", async () => {
  const response = await request(app()).get(`/payment/proofs/${orderId}`).set("Authorization", `Bearer ${issueAdminToken({ _id: moderatorId, clearanceLevel: "moderator" })}`);
  assert.equal(response.statusCode, 403);
});

test("inactive administrators cannot access receipts", async () => {
  const inactiveAdminId = new mongoose.Types.ObjectId();
  const response = await request(app()).get(`/payment/proofs/${orderId}`).set("Authorization", `Bearer ${issueAdminToken({ _id: inactiveAdminId, clearanceLevel: "admin" })}`);
  assert.equal(response.statusCode, 401);
});

test("a proof ID owned by another customer cannot be attached to this order", async () => {
  const originalProof = fakeOrder.paymentProof.storageKey;
  fakeOrder.paymentProof.storageKey = `proof:payment-proofs/${otherId}/payment_123e4567-e89b-12d3-a456-426614174000.webp`;
  try {
    const response = await request(app()).get(`/payment/proofs/${orderId}`).set("Authorization", `Bearer ${issueUserToken({ _id: ownerId })}`);
    assert.equal(response.statusCode, 404);
  } finally {
    fakeOrder.paymentProof.storageKey = originalProof;
  }
});

test("a mismatched payment-proof record cannot authorize receipt retrieval", async () => {
  const previous = fakeOrder.paymentProof.proofRecordId;
  const oldFindOne = PaymentProof.findOne;
  const requestedProofRecordId = new mongoose.Types.ObjectId();
  fakeOrder.paymentProof.proofRecordId = requestedProofRecordId;
  PaymentProof.findOne = (filter) => {
    assert.equal(filter._id.toString(), requestedProofRecordId.toString());
    assert.equal(filter.ownerId.toString(), ownerId.toString());
    assert.equal(filter.orderId.toString(), orderId.toString());
    assert.equal(filter.status, "associated");
    return { select: async () => null };
  };
  try {
    const response = await request(app()).get(`/payment/proofs/${orderId}`).set("Authorization", `Bearer ${issueUserToken({ _id: ownerId })}`);
    assert.equal(response.statusCode, 404);
  } finally {
    if (previous === undefined) delete fakeOrder.paymentProof.proofRecordId;
    else fakeOrder.paymentProof.proofRecordId = previous;
    PaymentProof.findOne = oldFindOne;
  }
});

test("proof IDs must belong to the order owner and cannot contain arbitrary paths", () => {
  assert.equal(uploadFile.privateProofLocation(proofId).userId, ownerId.toString());
  assert.equal(uploadFile.privateProofLocation(proofId.replace(ownerId.toString(), otherId.toString())).userId, otherId.toString());
  assert.equal(uploadFile.privateProofLocation("proof:../../public/receipt.jpg"), null);
  assert.equal(uploadFile.privateProofLocation("https://res.cloudinary.com/public/receipt.webp"), null);
});

test("order JSON never exposes legacy URLs or private storage keys", () => {
  const OrderModel = require("../model/order");
  const doc = new OrderModel({ userID: ownerId, totalPrice: 10, paymentMethod: "cbe", paymentProof: { imageUrl: "https://public.example/receipt.jpg", storageKey: proofId } });
  const json = doc.toJSON();
  assert.equal(json.paymentProof.available, true);
  assert.equal("imageUrl" in json.paymentProof, false);
  assert.equal("storageKey" in json.paymentProof, false);
});

test("Cloudinary receipt proxy uses a one-minute signed URL without exposing it to the client", async () => {
  const cloudinary = uploadFile.cloudinary;
  const old = { name: process.env.CLOUDINARY_CLOUD_NAME, key: process.env.CLOUDINARY_API_KEY, secret: process.env.CLOUDINARY_API_SECRET, signing: cloudinary.utils.private_download_url, get: axios.get };
  process.env.CLOUDINARY_CLOUD_NAME = "test-cloud"; process.env.CLOUDINARY_API_KEY = "test-key"; process.env.CLOUDINARY_API_SECRET = "test-secret";
  let expiresAt; let requestedUrl; let requestOptions; let piped = false; let redirected = false;
  const expectedPublicId = proofId.slice("proof:".length).replace(/\.webp$/, "");
  cloudinary.utils.private_download_url = (publicId, format, options) => {
    assert.equal(publicId, expectedPublicId);
    assert.equal(format, "webp");
    assert.equal(options.type, "authenticated");
    expiresAt = options.expires_at;
    return syntheticSignedDownloadUrl(publicId, expiresAt);
  };
  axios.get = async (url, options) => { requestedUrl = new URL(url); requestOptions = options; return { data: { on() {}, pipe() { piped = true; } } }; };
  const started = Math.floor(Date.now() / 1000);
  const response = { set() {}, destroy() {} };
  response.redirect = () => { redirected = true; };
  await uploadFile.deliverPrivatePaymentProof(proofId, response);
  assert.ok(expiresAt >= started + 59 && expiresAt <= started + 61);
  assert.equal(requestedUrl.hostname, "api.cloudinary.com");
  assert.equal(requestedUrl.pathname, "/v1_1/test-cloud/image/download");
  assert.equal(requestedUrl.searchParams.get("public_id"), expectedPublicId);
  assert.equal(requestedUrl.searchParams.get("type"), "authenticated");
  assert.equal(requestOptions.maxRedirects, 0);
  assert.equal(requestOptions.validateStatus(200), true);
  assert.equal(requestOptions.validateStatus(302), false);
  assert.equal(piped, true);
  assert.equal(redirected, false);
  cloudinary.utils.private_download_url = old.signing;
  axios.get = old.get;
  for (const [key, value] of [["CLOUDINARY_CLOUD_NAME", old.name], ["CLOUDINARY_API_KEY", old.key], ["CLOUDINARY_API_SECRET", old.secret]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("expired Cloudinary signed URLs fail closed instead of returning receipt bytes", async () => {
  const cloudinary = uploadFile.cloudinary;
  const old = { name: process.env.CLOUDINARY_CLOUD_NAME, key: process.env.CLOUDINARY_API_KEY, secret: process.env.CLOUDINARY_API_SECRET, signing: cloudinary.utils.private_download_url, get: axios.get };
  process.env.CLOUDINARY_CLOUD_NAME = "test-cloud"; process.env.CLOUDINARY_API_KEY = "test-key"; process.env.CLOUDINARY_API_SECRET = "test-secret";
  cloudinary.utils.private_download_url = (publicId, _format, options) => syntheticSignedDownloadUrl(publicId, options.expires_at);
  let requested = false;
  axios.get = async (_url, options) => {
    requested = true;
    assert.equal(options.maxRedirects, 0);
    throw new Error("provider rejected the synthetic signed request");
  };
  const response = { set() {}, destroy() {} };
  assert.equal(await uploadFile.deliverPrivatePaymentProof(proofId, response), false);
  assert.equal(requested, true);
  cloudinary.utils.private_download_url = old.signing; axios.get = old.get;
  for (const [key, value] of [["CLOUDINARY_CLOUD_NAME", old.name], ["CLOUDINARY_API_KEY", old.key], ["CLOUDINARY_API_SECRET", old.secret]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("untrusted signed URL origins and redirects are never fetched", async () => {
  const cloudinary = uploadFile.cloudinary;
  const names = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const oldSigning = cloudinary.utils.private_download_url;
  const oldGet = axios.get;
  names.forEach(name => { process.env[name] = `synthetic-${name.toLowerCase()}`; });
  let fetchCount = 0;
  cloudinary.utils.private_download_url = () => "https://attacker.invalid/redirect";
  axios.get = async () => { fetchCount += 1; throw new Error("must not fetch untrusted origin"); };
  try {
    assert.equal(await uploadFile.deliverPrivatePaymentProof(proofId, { set() {}, destroy() {} }), false);
    assert.equal(fetchCount, 0);
  } finally {
    cloudinary.utils.private_download_url = oldSigning;
    axios.get = oldGet;
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("payment proof upload rejects unsupported extension and MIME combinations", () => {
  const filter = uploadFile.createFileFilter();
  const outcome = (originalname, mimetype) => new Promise((resolve) => filter({}, { originalname, mimetype }, (error, accepted) => resolve({ error, accepted })));
  return Promise.all([
    outcome("receipt.exe", "image/png"),
    outcome("receipt.jpg", "text/plain"),
  ]).then(results => results.forEach(result => assert.ok(result.error)));
});

test("production-like environments cannot silently store receipts on implicit local disk", () => {
  const names = ["NODE_ENV", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "PAYMENT_PROOFS_DIR"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.NODE_ENV = "staging";
  for (const name of names.slice(1)) delete process.env[name];
  assert.throws(uploadFile.ensurePrivateProofStorageConfigured, /PAYMENT_PROOFS_DIR/);
  process.env.PAYMENT_PROOFS_DIR = "/persistent/private-proofs";
  assert.doesNotThrow(uploadFile.ensurePrivateProofStorageConfigured);
  for (const name of names) {
    if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
  }
});

test("partial Cloudinary credentials fail closed instead of switching receipt storage", () => {
  const names = ["NODE_ENV", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "PAYMENT_PROOFS_DIR"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.NODE_ENV = "staging";
  process.env.CLOUDINARY_CLOUD_NAME = "synthetic-cloud";
  process.env.CLOUDINARY_API_KEY = "synthetic-key";
  delete process.env.CLOUDINARY_API_SECRET;
  process.env.PAYMENT_PROOFS_DIR = path.join(os.tmpdir(), "yomart-explicit-private-test-root");
  try {
    assert.throws(uploadFile.validateUploadStorageRoots, /Cloudinary requires/);
    assert.throws(uploadFile.ensurePrivateProofStorageConfigured, /Cloudinary requires/);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("staging receipt uploads require Cloudinary or an explicitly configured private root", () => {
  const names = ["NODE_ENV", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "PAYMENT_PROOFS_DIR"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.NODE_ENV = "staging";
  for (const name of names.slice(1, 4)) delete process.env[name];
  delete process.env.PAYMENT_PROOFS_DIR;
  try {
    assert.throws(uploadFile.ensurePrivateProofStorageConfigured, /PAYMENT_PROOFS_DIR/);
    process.env.PAYMENT_PROOFS_DIR = path.join(os.tmpdir(), "yomart-explicit-private-test-root");
    assert.doesNotThrow(uploadFile.ensurePrivateProofStorageConfigured);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
