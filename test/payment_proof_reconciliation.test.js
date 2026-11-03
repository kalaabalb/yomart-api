const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const mongoose = require("mongoose");
const { buildPaymentProofReconciliation } = require("../utils/paymentProofReconciliation");
const { validateLocalMongoTarget, writePrivateReport, runAudit } = require("../scripts/audit_legacy_payment_proofs");
const { inspectPaymentProofAsset } = require("../uploadFile");

test("reconciliation marks shared references and ambiguous ownership without choosing an owner", async () => {
  const ownerA = new mongoose.Types.ObjectId();
  const ownerB = new mongoose.Types.ObjectId();
  const shared = "https://res.cloudinary.com/example/image/upload/v1/payment-proofs/private-id/receipt.webp";
  const report = await buildPaymentProofReconciliation({
    orders: [
      { _id: "order-a", userID: ownerA, paymentProof: { imageUrl: shared } },
      { _id: "order-b", userID: ownerB, paymentProof: { imageUrl: shared } },
    ],
    proofs: [],
    inspectAsset: async () => ({ storageType: "cloudinary_legacy_public", assetStatus: "unverified" }),
  });
  assert.equal(report.summary.byReviewStatus.duplicate_reference, 2);
  assert.equal(report.records[0].ownershipStatus, "ambiguous");
  assert.deepEqual(report.records[0].sharedOrderIds, ["order-a", "order-b"]);
  assert.equal(report.records[0].assetStatus, "unverified");
  assert.equal(report.records[0].proofReference, shared);
  assert.equal(report.records[0].proofFingerprint.length, 64);
  assert.equal("email" in report.records[0], false);
});

test("report distinguishes missing assets, inaccessible assets, and missing references", async () => {
  const customer = new mongoose.Types.ObjectId();
  const report = await buildPaymentProofReconciliation({
    orders: [
      { _id: "missing", userID: customer, paymentProof: { imageUrl: "/uploads/payment-proofs/missing.webp" } },
      { _id: "inaccessible", userID: customer, paymentProof: { imageUrl: "https://res.cloudinary.com/example/image/upload/receipt.webp" } },
      { _id: "no-reference", userID: customer, paymentProof: {} },
    ],
    inspectAsset: async (reference) => reference.startsWith("/uploads/")
      ? { storageType: "local_legacy", assetStatus: "missing" }
      : { storageType: "cloudinary_legacy_public", assetStatus: "unverified" },
  });
  assert.equal(report.records.find((item) => item.orderId === "missing").reviewStatus, "missing_asset");
  assert.equal(report.records.find((item) => item.orderId === "inaccessible").reviewStatus, "needs_review");
  assert.ok(report.records.find((item) => item.orderId === "no-reference").issueCodes.includes("missing_reference"));
});

test("reconciliation identifies inconsistent proof ownership and unbound uploads", async () => {
  const orderOwner = new mongoose.Types.ObjectId();
  const proofOwner = new mongoose.Types.ObjectId();
  const proofId = new mongoose.Types.ObjectId();
  const reference = `proof:payment-proofs/${proofOwner}/payment_123e4567-e89b-12d3-a456-426614174000.webp`;
  const order = { _id: "order-1", userID: orderOwner, paymentProof: { storageKey: reference, proofRecordId: proofId } };
  const report = await buildPaymentProofReconciliation({
    orders: [order],
    proofs: [{ _id: proofId, ownerId: proofOwner, orderId: "another-order", status: "associated", storageKey: reference }],
    inspectAsset: async () => ({ storageType: "local_private", assetStatus: "present" }),
  });
  assert.ok(report.records[0].issueCodes.includes("ambiguous_ownership"));

  const unbound = await buildPaymentProofReconciliation({
    orders: [],
    proofs: [{ _id: proofId, ownerId: proofOwner, orderId: null, status: "uploaded", storageKey: reference }],
    inspectAsset: async () => ({ storageType: "local_private", assetStatus: "unverified" }),
  });
  assert.equal(unbound.records[0].kind, "unbound_upload");
  assert.equal(unbound.records[0].reviewStatus, "needs_review");
});

test("audit command requires an explicit matching loopback database and refuses remote targets", async () => {
  assert.equal(validateLocalMongoTarget("mongodb://127.0.0.1:27017/yomart_test", "yomart_test"), "yomart_test");
  assert.throws(() => validateLocalMongoTarget("mongodb://localhost/yomart_test", "yomart_test"), /IP literal/);
  assert.throws(() => validateLocalMongoTarget("mongodb+srv://cluster.example/yomart_test", "yomart_test"), /loopback/);
  assert.throws(() => validateLocalMongoTarget("mongodb://example.com/yomart_test", "yomart_test"), /loopback/);
  assert.throws(() => validateLocalMongoTarget("mongodb://127.0.0.1/yomart_prod", "yomart_prod"), /production\/live/);
  assert.throws(() => validateLocalMongoTarget("mongodb://127.0.0.1/yomart_test?replicaSet=remote", "yomart_test"), /topology options/);
  assert.throws(() => validateLocalMongoTarget("mongodb://127.0.0.1/yomart_test?directConnection=false", "yomart_test"), /topology options/);
  let connections = 0;
  await assert.rejects(runAudit({
    env: { MONGODB_URL: "mongodb://db.example/yomart_test" },
    args: ["--allow-local-db=yomart_test"],
    connect: async () => { connections += 1; },
  }), /loopback/);
  assert.equal(connections, 0);
});

test("mock-backed audit keeps exact proof references in the private artifact and only prints counts", async () => {
  const reference = "https://res.cloudinary.com/example/image/upload/secret-receipt-reference.webp";
  const order = { _id: "sensitive-order-id", userID: "sensitive-customer-id", paymentMethod: "cbe", paymentProof: { imageUrl: reference } };
  let artifact;
  let connected = 0;
  let disconnected = 0;
  let connectionOptions;
  const logs = [];
  const models = {
    Order: { find: () => ({ select: () => ({ lean: async () => [order] }) }) },
    PaymentProof: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
  };
  const result = await runAudit({
    env: { MONGODB_URL: "mongodb://127.0.0.1:27017/yomart_test" },
    args: ["--allow-local-db=yomart_test"],
    connect: async (_url, options) => { connected += 1; connectionOptions = options; },
    disconnect: async () => { disconnected += 1; },
    models,
    inspectAsset: async () => ({ storageType: "cloudinary_legacy_public", assetStatus: "unverified" }),
    writeReport: async (report) => { artifact = report; return "/private/report.json"; },
    now: () => new Date("2026-10-22T00:00:00Z"),
    logger: { info: (line) => logs.push(line) },
  });
  assert.equal(connected, 1);
  assert.equal(disconnected, 1);
  assert.deepEqual(connectionOptions, {
    directConnection: true, readPreference: "primaryPreferred", autoIndex: false, autoCreate: false,
  });
  assert.equal(artifact.records[0].proofReference, reference);
  assert.equal(JSON.stringify(result).includes(reference), false);
  assert.equal(JSON.stringify(result).includes("sensitive-order-id"), false);
  assert.equal(JSON.stringify(logs).includes("sensitive-customer-id"), false);
  assert.equal(JSON.stringify(logs).includes("/private/report.json"), false);
  assert.equal(JSON.stringify(logs).includes("yomart_test"), false);
  assert.equal(result.total, 1);
});

test("private audit artifacts use restrictive directory and file permissions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yomart-proof-audit-"));
  try {
    const reportPath = await writePrivateReport({ readOnly: true, records: [] }, root, new Date("2026-10-21T00:00:00Z"));
    const directoryStat = await fs.stat(path.dirname(reportPath));
    const fileStat = await fs.stat(reportPath);
    assert.equal(directoryStat.mode & 0o777, 0o700);
    assert.equal(fileStat.mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await fs.readFile(reportPath, "utf8")).records, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("private proof presence stays unverified unless local storage is explicitly designated", async () => {
  const missingPrivateReference = `proof:payment-proofs/507f1f77bcf86cd799439011/payment_123e4567-e89b-12d3-a456-426614174000.webp`;
  const defaultResult = await inspectPaymentProofAsset(missingPrivateReference);
  assert.equal(defaultResult.assetStatus, "unverified");

  const localResult = await inspectPaymentProofAsset(missingPrivateReference, {
    assumeLocalPrivateStorage: true,
    localPrivateRoot: path.join(os.tmpdir(), `no-such-yomart-proof-root-${process.pid}`),
  });
  assert.equal(localResult.storageType, "local_private");
  assert.equal(localResult.assetStatus, "unverified");
});

test("private report writer refuses symlink roots and report directories without overwriting old reports", async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "yomart-report-links-"));
  const actualRoot = path.join(sandbox, "actual-root");
  const outside = path.join(sandbox, "outside");
  const rootLink = path.join(sandbox, "root-link");
  await fs.mkdir(actualRoot, { mode: 0o700 });
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.symlink(actualRoot, rootLink);
  try {
    await assert.rejects(writePrivateReport({ secret: "do-not-write" }, rootLink), /unsafe/);

    const rootWithReportLink = path.join(sandbox, "root-with-report-link");
    await fs.mkdir(rootWithReportLink, { mode: 0o700 });
    await fs.symlink(outside, path.join(rootWithReportLink, "reconciliation-reports"));
    await assert.rejects(writePrivateReport({ secret: "do-not-write" }, rootWithReportLink), /unsafe/);
    assert.deepEqual(await fs.readdir(outside), []);

    const first = await writePrivateReport({ sequence: 1 }, actualRoot, new Date("2026-10-22T00:00:00Z"));
    const second = await writePrivateReport({ sequence: 2 }, actualRoot, new Date("2026-10-22T00:00:00Z"));
    assert.notEqual(first, second);
    assert.equal(JSON.parse(await fs.readFile(first, "utf8")).sequence, 1);
    assert.equal(JSON.parse(await fs.readFile(second, "utf8")).sequence, 2);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});
