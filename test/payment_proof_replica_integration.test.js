const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const PaymentProof = require("../model/paymentProof");
const ProofCleanupJob = require("../model/proofCleanupJob");
const { claimUploadedProof } = require("../utils/paymentProofPolicy");
const { finalizeProofCleanup, transitionProofForCleanup } = require("../scripts/cleanup_payment_proofs");

const replicaUrl = process.env.MONGODB_REPLICA_TEST_URL;
test("replica-set transactions allow only one concurrent order claim", { skip: !replicaUrl }, async () => {
  const dbName = `yomart_proof_test_${process.pid}`;
  await mongoose.connect(replicaUrl, { dbName });
  try {
    await PaymentProof.syncIndexes();
    const ownerId = new mongoose.Types.ObjectId();
    const proofRecordId = new mongoose.Types.ObjectId();
    const orderIds = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
    const proofId = `proof:payment-proofs/${ownerId}/payment_123e4567-e89b-12d3-a456-426614174000.webp`;
    await PaymentProof.create({ _id: proofRecordId, ownerId, storageKey: proofId, status: "uploaded" });

    const outcomes = await Promise.allSettled(orderIds.map(async (orderId) => {
      const session = await mongoose.startSession();
      try {
        let claimed;
        await session.withTransaction(async () => {
          claimed = await claimUploadedProof({ proofRecordId, proofId, ownerId, orderId, session });
        });
        return claimed;
      } finally { await session.endSession(); }
    }));
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
    const stored = await PaymentProof.findById(proofRecordId).select("+storageKey");
    assert.ok(orderIds.some((id) => id.toString() === stored.orderId.toString()));
    assert.equal(stored.status, "associated");
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test("replica-set cleanup transactions fence leases and commit proof/job state together", { skip: !replicaUrl }, async () => {
  const dbName = `yomart_cleanup_test_${process.pid}`;
  await mongoose.connect(replicaUrl, { dbName });
  try {
    const ownerId = new mongoose.Types.ObjectId();
    const proofRecordId = new mongoose.Types.ObjectId();
    const jobId = new mongoose.Types.ObjectId();
    const proofId = `proof:payment-proofs/${ownerId}/payment_123e4567-e89b-12d3-a456-426614174099.webp`;
    const leaseId = "current-cleanup-lease";
    const leaseExpiresAt = new Date(Date.now() + 60_000);
    await PaymentProof.create({ _id: proofRecordId, ownerId, storageKey: proofId, status: "cleanup_pending" });
    await ProofCleanupJob.create({ _id: jobId, proofId: proofRecordId, reason: "orphaned_upload", state: "processing", leaseId, leaseExpiresAt });
    const proof = await PaymentProof.findById(proofRecordId).select("+storageKey");
    const job = await ProofCleanupJob.findById(jobId);

    const completed = await finalizeProofCleanup({
      models: { PaymentProof, ProofCleanupJob }, job, proof, leaseId, now: new Date(),
    });
    assert.equal(completed, true);
    const savedProof = await PaymentProof.findById(proofRecordId).select("+storageKey");
    const savedJob = await ProofCleanupJob.findById(jobId);
    assert.equal(savedProof.status, "deleted");
    assert.equal(savedProof.storageKey, `deleted:${proofRecordId}`);
    assert.equal(savedJob.state, "complete");
    assert.equal(savedJob.leaseId, null);

    const activeProofId = new mongoose.Types.ObjectId();
    const activeJobId = new mongoose.Types.ObjectId();
    const activeOrderId = new mongoose.Types.ObjectId();
    const activeLeaseId = "stale-worker-lease";
    await PaymentProof.create({ _id: activeProofId, ownerId, storageKey: `${proofId}-active`, status: "associated", orderId: activeOrderId });
    await ProofCleanupJob.create({ _id: activeJobId, proofId: activeProofId, reason: "orphaned_upload", state: "processing", leaseId: "new-worker-lease", leaseExpiresAt: new Date(Date.now() + 60_000) });
    const activeProof = await PaymentProof.findById(activeProofId).select("+storageKey");
    const activeJob = await ProofCleanupJob.findById(activeJobId);
    const transitioned = await transitionProofForCleanup({
      models: { PaymentProof, ProofCleanupJob }, job: activeJob, proof: activeProof,
      category: "orphaned_upload", retentionDays: 1, leaseId: activeLeaseId, now: new Date(),
    });
    assert.equal(transitioned.state, "lease_lost");
    const unchangedActiveProof = await PaymentProof.findById(activeProofId);
    assert.equal(unchangedActiveProof.status, "associated");
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
