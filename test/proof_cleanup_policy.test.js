const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const {
  loadRetentionPolicy,
  getCutoff,
  isEligibleForCleanup,
  buildCleanupProofQuery,
  buildReplacementAuditQuery,
  buildCleanupJobClaimFilter,
  claimCleanupJob,
  processProofCleanupJob,
} = require("../utils/proofCleanupJob");
const { runCleanup, parseArgs, finalizeProofCleanup, transitionProofForCleanup } = require("../scripts/cleanup_payment_proofs");

const now = new Date("2026-10-21T00:00:00.000Z");
const config = (orphan = "10", superseded = "30") => ({
  MONGODB_URL: "mongodb://127.0.0.1:27017/yomart_test",
  PAYMENT_PROOF_ORPHAN_RETENTION_DAYS: orphan,
  PAYMENT_PROOF_SUPERSEDED_RETENTION_DAYS: superseded,
});

test("separate retention values are required and the legacy shared value is refused", () => {
  assert.deepEqual(loadRetentionPolicy(config()), { orphaned_upload: 10, superseded: 30 });
  assert.throws(() => loadRetentionPolicy(config("", "30")), /PAYMENT_PROOF_ORPHAN_RETENTION_DAYS/);
  assert.throws(() => loadRetentionPolicy(config("10", "-1")), /PAYMENT_PROOF_SUPERSEDED_RETENTION_DAYS/);
  assert.throws(() => loadRetentionPolicy({ ...config(), PAYMENT_PROOF_RETENTION_DAYS: "1" }), /no longer supported/);
  assert.throws(() => loadRetentionPolicy(config("900000000000", "30")), /safe date range/);
});

test("safe cutoffs use independent timestamps and reject malformed or future timestamps", () => {
  assert.equal(getCutoff(now, 10).toISOString(), "2026-10-11T00:00:00.000Z");
  const oldUpload = { status: "uploaded", orderId: null, createdAt: new Date("2026-10-01T00:00:00Z") };
  const oldSuperseded = { status: "superseded", orderId: null, supersededAt: new Date("2026-10-01T00:00:00Z") };
  assert.equal(isEligibleForCleanup(oldUpload, "orphaned_upload", 10, now), true);
  assert.equal(isEligibleForCleanup(oldSuperseded, "superseded", 30, now), false);
  assert.equal(isEligibleForCleanup(oldSuperseded, "superseded", 5, now, true), true);
  assert.equal(isEligibleForCleanup({ ...oldUpload, createdAt: "2020-01-01" }, "orphaned_upload", 1, now), false);
  assert.equal(isEligibleForCleanup({ ...oldUpload, createdAt: new Date("2027-01-01") }, "orphaned_upload", 1, now), false);
  assert.equal(isEligibleForCleanup({ ...oldSuperseded }, "superseded", 1, now, false), false);
  assert.equal(isEligibleForCleanup({ ...oldUpload, orderId: new mongoose.Types.ObjectId() }, "orphaned_upload", 1, now), false);
});

test("category queries exclude active proofs and distinguish orphan from superseded records", () => {
  assert.deepEqual(buildCleanupProofQuery("orphaned_upload"), { orderId: null, status: { $in: ["uploaded", "cleanup_pending"] } });
  assert.deepEqual(buildCleanupProofQuery("superseded"), { orderId: null, status: { $in: ["superseded", "cleanup_pending"] } });
  assert.throws(() => buildCleanupProofQuery("associated"), /Unknown/);
});

test("superseded cleanup requires replacement audit evidence tied to the proof owner", () => {
  assert.deepEqual(buildReplacementAuditQuery({ _id: "old-proof", ownerId: "owner-1" }), {
    action: "proof_replaced", oldProofId: "old-proof", orderId: { $exists: true },
    actorId: "owner-1", actorRole: "user", newProofId: { $exists: true },
  });
});

test("cleanup dry-run is the default and performs no writes or asset deletion", async () => {
  const proof = { _id: "proof-1", ownerId: "customer-1", orderId: null, status: "uploaded", createdAt: new Date("2026-10-01T00:00:00Z"), storageKey: "private-key" };
  let writes = 0;
  let deletes = 0;
  const logs = [];
  const models = {
    PaymentProof: {
      find: () => ({ select: async () => [proof] }),
    },
    ProofCleanupJob: {
      findOne: async () => null,
      updateOne: async () => { writes += 1; },
      findOneAndUpdate: async () => { writes += 1; },
    },
    SecurityAudit: { exists: async () => false },
  };
  const result = await runCleanup({
    env: config(), models, now: () => now,
    connect: async () => {}, disconnect: async () => {},
    deleteAsset: async () => { deletes += 1; },
    logger: { info: (line) => logs.push(line) },
  });
  assert.equal(result.mode, "dry_run");
  assert.equal(result.categories.orphaned_upload.candidateCount, 1);
  assert.equal(writes, 0);
  assert.equal(deletes, 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].includes("private-key"), false);
});

test("orphaned cleanup never infers a retention category for cleanup_pending records without a matching job", async () => {
  const proof = { _id: "proof-pending", ownerId: "customer", orderId: null, status: "cleanup_pending", createdAt: new Date("2026-10-01T00:00:00Z"), supersededAt: new Date("2026-10-01T00:00:00Z"), storageKey: "private-key" };
  const report = await runCleanup({
    env: config("1", "90"), models: {
      PaymentProof: { find: () => ({ select: async () => [proof] }) },
      ProofCleanupJob: { findOne: async () => null },
      SecurityAudit: { exists: async () => true },
    },
    connect: async () => {}, disconnect: async () => {}, now: () => now,
    logger: { info: () => {} }, deleteAsset: async () => { assert.fail("dry run must not delete"); },
  });
  assert.equal(report.categories.orphaned_upload.candidateCount, 0);
  assert.equal(report.categories.superseded.candidateCount, 0);
  assert.equal(report.categories.orphaned_upload.skippedCount, 1);
  assert.equal(report.categories.superseded.skippedCount, 1);
});

test("missing or invalid retention settings fail before connecting or deleting", async () => {
  let connections = 0;
  let deletes = 0;
  for (const env of [config("", "5"), config("5", "not-a-number")]) {
    await assert.rejects(runCleanup({
      env,
      args: ["--confirm-delete"],
      connect: async () => { connections += 1; },
      deleteAsset: async () => { deletes += 1; },
    }));
  }
  assert.equal(connections, 0);
  assert.equal(deletes, 0);
});

test("actual deletion requires the explicit confirmation flag", () => {
  assert.equal(parseArgs([]).confirmDelete, false);
  assert.equal(parseArgs(["--confirm-delete"]).confirmDelete, true);
  assert.throws(() => parseArgs(["--yes"]), /Unsupported/);
  assert.throws(() => parseArgs(["--confirm-delete-now"]), /Unsupported/);
  assert.throws(() => parseArgs(["--confirm-delete=false"]), /Unsupported/);
});

test("confirmed cleanup deletes an eligible proof and records completion", async () => {
  const proof = {
    _id: "proof-confirmed", ownerId: "customer-internal-id", orderId: null,
    status: "uploaded", createdAt: new Date("2026-10-01T00:00:00Z"), storageKey: "private-reference",
  };
  let job = null;
  let deleteCount = 0;
  const models = {
    PaymentProof: {
      find: (filter) => ({ select: async () => filter.status.$in.includes(proof.status) ? [proof] : [] }),
      findOne: () => ({ select: async () => proof }),
      findOneAndUpdate: (_filter, update) => ({ select: async () => { Object.assign(proof, update.$set); return proof; } }),
      updateOne: async (_filter, update) => { Object.assign(proof, update.$set); return { modifiedCount: 1 }; },
    },
    ProofCleanupJob: {
      findOne: async () => job,
      updateOne: async (filter, update, options = {}) => {
        if (options.upsert && !job) {
          job = { _id: "job-confirmed", proofId: filter.proofId, ...update.$setOnInsert, attempts: 0 };
          return { upsertedCount: 1, modifiedCount: 0 };
        }
        if (filter.state === "processing" && job?.leaseId === filter.leaseId) {
          Object.assign(job, update.$set);
          return { modifiedCount: 1 };
        }
        return { modifiedCount: 0 };
      },
      findOneAndUpdate: async (filter, update) => {
        if (job?.state !== "pending" || filter.reason !== job.reason) return null;
        Object.assign(job, update.$set);
        job.attempts += update.$inc.attempts;
        return job;
      },
    },
    SecurityAudit: { exists: async () => false },
  };
  const report = await runCleanup({
    env: config(), args: ["--confirm-delete"], models, now: () => now,
    connect: async () => {}, disconnect: async () => {},
    withTransaction: async (callback) => callback({}),
    deleteAsset: async (reference) => { assert.equal(reference, "private-reference"); deleteCount += 1; },
    logger: { info: () => {} },
  });
  assert.equal(deleteCount, 1);
  assert.equal(proof.status, "deleted");
  assert.equal(job.state, "complete");
  assert.equal(report.mode, "delete");
  assert.equal(report.categories.orphaned_upload.processedCount, 1);
});

test("a tombstoned proof from an interrupted prior run completes its cleanup job without another asset delete", async () => {
  const proof = { _id: "proof-already-deleted", ownerId: "owner", orderId: null, status: "deleted", storageKey: "deleted:proof-already-deleted" };
  const job = { _id: "job-interrupted", proofId: proof._id, reason: "orphaned_upload", state: "processing", leaseId: "new-lease", attempts: 2 };
  let deleteCount = 0;
  let claimed = false;
  const models = {
    PaymentProof: {
      find: () => ({ select: async () => [] }),
      findOne: () => ({ select: async () => proof }),
    },
    ProofCleanupJob: {
      findOne: async () => job,
      updateOne: async (filter, update, options) => {
        if (options?.upsert) return { upsertedCount: 0 };
        if (filter.state === "processing" && filter.leaseId === job.leaseId) {
          Object.assign(job, update.$set);
          return { modifiedCount: 1 };
        }
        return { modifiedCount: 0 };
      },
      findOneAndUpdate: async (filter, update) => {
        if (filter.reason !== job.reason || claimed) return null;
        claimed = true;
        Object.assign(job, update.$set);
        job.attempts += update.$inc.attempts;
        return job;
      },
    },
    SecurityAudit: { exists: async () => false },
  };
  const result = await runCleanup({
    env: config(), args: ["--confirm-delete"], models,
    connect: async () => {}, disconnect: async () => {}, now: () => now,
    deleteAsset: async () => { deleteCount += 1; },
    logger: { info: () => {} },
  });
  assert.equal(job.state, "complete");
  assert.equal(deleteCount, 0);
  assert.equal(result.categories.orphaned_upload.processedCount, 1);
});

test("database lease lets only one concurrent cleanup worker claim a job", async () => {
  const job = { _id: "job-1", reason: "orphaned_upload", state: "pending", attempts: 0, nextAttemptAt: new Date("2026-10-20T00:00:00Z") };
  let claimed = false;
  const model = {
    async findOneAndUpdate(filter, update) {
      assert.equal(filter.reason, "orphaned_upload");
      assert.ok(filter.$or.some((condition) => condition.state === "processing"));
      if (claimed) return null;
      claimed = true;
      Object.assign(job, update.$set);
      job.attempts += update.$inc.attempts;
      await new Promise((resolve) => setImmediate(resolve));
      return job;
    },
  };
  const claims = await Promise.all([
    claimCleanupJob(model, "orphaned_upload", now, "lease-a", 60000),
    claimCleanupJob(model, "orphaned_upload", now, "lease-b", 60000),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.ok(buildCleanupJobClaimFilter(now).$or.some((condition) => condition.state === "processing"));
});

test("storage failure leaves a leased proof retryable, while a lost lease cannot commit", async () => {
  const job = { _id: "job-1", state: "processing", leaseId: "lease-a", attempts: 1 };
  const proof = { _id: "proof-1", storageKey: "private-key" };
  let persisted;
  const outcome = await processProofCleanupJob({
    job, proof, leaseId: "lease-a", now,
    deleteAsset: async () => { throw Object.assign(new Error("provider details"), { code: "ETIMEDOUT" }); },
    saveDeletedProof: async () => {},
    persistJob: async (set, filter) => { persisted = { set, filter }; return true; },
  });
  assert.equal(outcome.state, "retry");
  assert.equal(outcome.errorCode, "ETIMEDOUT");
  assert.equal(persisted.set.state, "retry");
  assert.equal(persisted.filter.leaseId, "lease-a");
  assert.equal(persisted.set.lastErrorCode.includes("provider details"), false);

  const lost = await processProofCleanupJob({
    job, proof, leaseId: "other-worker", now,
    deleteAsset: async () => { throw new Error("must not run"); },
    saveDeletedProof: async () => {}, persistJob: async () => true,
  });
  assert.equal(lost.state, "lease_lost");
});

test("successful deletion marks proof and job complete only after storage deletion", async () => {
  const job = { _id: "job-2", state: "processing", leaseId: "lease-b", attempts: 1 };
  let order = [];
  const result = await processProofCleanupJob({
    job, proof: { _id: "proof-2" }, leaseId: "lease-b", now,
    deleteAsset: async () => { order.push("asset"); },
    finalizeDeletedProof: async () => { order.push("atomic proof+job completion"); return true; },
    persistJob: async (set) => { order.push(set.state); return true; },
  });
  assert.deepEqual(order, ["asset", "atomic proof+job completion"]);
  assert.equal(result.state, "complete");
});

test("proof tombstone and job completion are lease-fenced in one transaction", async () => {
  const job = { _id: "job-fenced", state: "processing", leaseId: "lease-current" };
  const proof = { _id: "proof-fenced", ownerId: "owner", orderId: null, status: "cleanup_pending", storageKey: "private" };
  const calls = [];
  const session = { marker: "same-session" };
  const models = {
    ProofCleanupJob: { updateOne: async (filter, update, options) => {
      calls.push({ kind: "job", filter, update, session: options.session });
      return { modifiedCount: 1 };
    } },
    PaymentProof: { updateOne: async (filter, update, options) => {
      calls.push({ kind: "proof", filter, update, session: options.session });
      return { modifiedCount: 1 };
    } },
  };
  const result = await finalizeProofCleanup({
    models, job, proof, leaseId: "lease-current", now,
    withTransaction: async (callback) => callback(session),
  });
  assert.equal(result, true);
  assert.deepEqual(calls.map((call) => call.kind), ["job", "proof"]);
  assert.equal(calls[0].filter.$expr.$gt[1], "$$NOW");
  assert.equal(calls[0].session, session);
  assert.equal(calls[1].session, session);
  assert.equal(calls[1].filter.status, "cleanup_pending");
});

test("expired lease cannot transition a proof after a second worker may have reclaimed the job", async () => {
  let proofWrites = 0;
  const result = await transitionProofForCleanup({
    models: {
      ProofCleanupJob: { updateOne: async () => ({ modifiedCount: 0 }) },
      PaymentProof: { findOneAndUpdate: () => { proofWrites += 1; throw new Error("must not update without lease"); } },
    },
    job: { _id: "job-expired" },
    proof: { _id: "proof-expired", ownerId: "owner", storageKey: "key" },
    category: "orphaned_upload", retentionDays: 1, leaseId: "old-lease", now,
    withTransaction: async (callback) => callback({}),
  });
  assert.deepEqual(result, { state: "lease_lost" });
  assert.equal(proofWrites, 0);
});

test("proof becoming associated before the cleanup transition is not marked pending", async () => {
  let jobWrites = 0;
  let proofFilter;
  const result = await transitionProofForCleanup({
    models: {
      ProofCleanupJob: { updateOne: async () => { jobWrites += 1; return { modifiedCount: 1 }; } },
      PaymentProof: { findOneAndUpdate: (filter) => {
        proofFilter = filter;
        return { select: async () => null };
      } },
    },
    job: { _id: "job-active-proof" },
    proof: { _id: "proof-now-associated", ownerId: "owner", storageKey: "key" },
    category: "orphaned_upload", retentionDays: 1, leaseId: "valid-lease", now,
    withTransaction: async (callback) => callback({}),
  });
  assert.equal(result.state, "skipped");
  assert.equal(proofFilter.orderId, null);
  assert.deepEqual(proofFilter.status.$in, ["uploaded", "cleanup_pending"]);
  assert.equal(proofFilter.createdAt.$lte.toISOString(), "2026-10-20T00:00:00.000Z");
  assert.equal(jobWrites, 2);
});
