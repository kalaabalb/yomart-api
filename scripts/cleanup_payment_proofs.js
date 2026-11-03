require("dotenv").config();
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const PaymentProof = require("../model/paymentProof");
const ProofCleanupJob = require("../model/proofCleanupJob");
const SecurityAudit = require("../model/securityAudit");
const { deletePrivatePaymentProof } = require("../uploadFile");
const {
  RETENTION_VARIABLES,
  loadRetentionPolicy,
  isEligibleForCleanup,
  getCutoff,
  buildCleanupProofQuery,
  buildReplacementAuditQuery,
  claimCleanupJob,
  processProofCleanupJob,
} = require("../utils/proofCleanupJob");

const LEASE_MS = 30 * 60 * 1000;
const PAGE_SIZE = 100;

async function withMongoTransaction(callback) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await callback(session); });
    return result;
  } finally {
    await session.endSession();
  }
}

function activeLeaseFilter(job, leaseId) {
  return {
    _id: job._id,
    state: "processing",
    leaseId,
    $expr: { $gt: ["$leaseExpiresAt", "$$NOW"] },
  };
}

async function transitionProofForCleanup({ models, job, proof, category, retentionDays, leaseId, now, withTransaction = withMongoTransaction }) {
  const timestampField = category === "orphaned_upload" ? "createdAt" : "supersededAt";
  const allowedStatuses = category === "orphaned_upload" ? ["uploaded", "cleanup_pending"] : ["superseded", "cleanup_pending"];
  const cutoff = getCutoff(now, retentionDays);
  return withTransaction(async (session) => {
    // The lease check and proof transition share a transaction so a stale worker
    // cannot mark a proof cleanup_pending after another worker reclaimed its job.
    const lease = await models.ProofCleanupJob.updateOne(
      activeLeaseFilter(job, leaseId),
      { $set: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) } },
      { session },
    );
    if (lease.modifiedCount !== 1) return { state: "lease_lost" };

    const currentProof = await models.PaymentProof.findOneAndUpdate(
      {
        _id: proof._id,
        ownerId: proof.ownerId,
        storageKey: proof.storageKey,
        orderId: null,
        status: { $in: allowedStatuses },
        [timestampField]: { $lte: cutoff },
      },
      { $set: { status: "cleanup_pending" } },
      { new: true, session },
    ).select("+storageKey _id ownerId orderId status createdAt supersededAt");

    if (!currentProof) {
      await models.ProofCleanupJob.updateOne(
        activeLeaseFilter(job, leaseId),
        { $set: { state: "retained", leaseId: null, leaseExpiresAt: null, nextAttemptAt: null, lastAttemptAt: now } },
        { session },
      );
      return { state: "skipped" };
    }
    return { state: "ready", proof: currentProof };
  });
}

async function finalizeProofCleanup({ models, job, proof, leaseId, now, withTransaction = withMongoTransaction }) {
  return withTransaction(async (session) => {
    const completedJob = await models.ProofCleanupJob.updateOne(
      activeLeaseFilter(job, leaseId),
      { $set: {
        state: "complete", leaseId: null, leaseExpiresAt: null, nextAttemptAt: null,
        lastErrorCode: null, lastAttemptAt: now,
      } },
      { session },
    );
    if (completedJob.modifiedCount !== 1) return false;

    const deletedProof = await models.PaymentProof.updateOne(
      { _id: proof._id, ownerId: proof.ownerId, orderId: null, status: "cleanup_pending", storageKey: proof.storageKey },
      { $set: { status: "deleted", storageKey: `deleted:${proof._id}` } },
      { session },
    );
    if (deletedProof.modifiedCount !== 1) {
      throw Object.assign(new Error("Proof state changed during cleanup."), { code: "PROOF_STATE_CHANGED" });
    }
    return true;
  });
}

function parseArgs(args = []) {
  const unknown = args.filter((arg) => arg !== "--confirm-delete");
  if (unknown.length) throw new Error(`Unsupported cleanup option: ${unknown[0]}`);
  return { confirmDelete: args.includes("--confirm-delete") };
}

function selected(query) {
  return query.select("+storageKey _id ownerId orderId status createdAt supersededAt");
}

function createReport(mode) {
  return {
    mode,
    categories: Object.fromEntries(Object.keys(RETENTION_VARIABLES).map((category) => [category, {
      candidateCount: 0,
      skippedCount: 0,
      processedCount: 0,
      failureCount: 0,
    }])),
  };
}

async function runCleanup({
  env = process.env,
  args = [],
  connect = (url) => mongoose.connect(url),
  disconnect = () => mongoose.disconnect(),
  models = { PaymentProof, ProofCleanupJob, SecurityAudit },
  deleteAsset = deletePrivatePaymentProof,
  logger = console,
  now = () => new Date(),
  withTransaction = withMongoTransaction,
} = {}) {
  // Validate every destructive control before connecting or touching a job.
  const policy = loadRetentionPolicy(env);
  const { confirmDelete } = parseArgs(args);
  const mongoUrl = env.MONGODB_URL || env.MONGO_URL;
  if (!mongoUrl) throw new Error("MONGODB_URL or MONGO_URL is required.");

  await connect(mongoUrl);
  const report = createReport(confirmDelete ? "delete" : "dry_run");
  try {
    const startedAt = now();
    const eligibleProofs = new Map();
    for (const [category, retentionDays] of Object.entries(policy)) {
      const query = buildCleanupProofQuery(category);
      const records = await selected(models.PaymentProof.find(query));
      for (const proof of records) {
        let auditExists = true;
        const existingJob = await models.ProofCleanupJob.findOne({ proofId: proof._id });
        // cleanup_pending alone cannot identify which independent retention
        // clock was applied. Never infer a category if its durable job is absent.
        if (proof.status === "cleanup_pending" && existingJob?.reason !== category) {
          report.categories[category].skippedCount += 1;
          continue;
        }
        if (category === "superseded") {
          auditExists = Boolean(await models.SecurityAudit.exists(buildReplacementAuditQuery(proof)));
        }
        if (!isEligibleForCleanup(proof, category, retentionDays, startedAt, auditExists)) {
          report.categories[category].skippedCount += 1;
          continue;
        }
        report.categories[category].candidateCount += 1;
        if (existingJob && (
          existingJob.reason !== category ||
          existingJob.state === "complete" ||
          (existingJob.state === "retained" && category !== "superseded") ||
          (existingJob.state === "processing" && existingJob.leaseExpiresAt instanceof Date && existingJob.leaseExpiresAt > startedAt) ||
          (existingJob.state === "retry" && existingJob.nextAttemptAt instanceof Date && existingJob.nextAttemptAt > startedAt)
        )) {
          report.categories[category].skippedCount += 1;
          continue;
        }
        eligibleProofs.set(`${category}:${proof._id}`, { category, proof });
      }
    }

    if (!confirmDelete) {
      logger.info(JSON.stringify(report));
      return report;
    }

    for (const { category, proof } of eligibleProofs.values()) {
      const jobValues = {
        reason: category,
        nextAttemptAt: startedAt,
      };
      const inserted = await models.ProofCleanupJob.updateOne(
        { proofId: proof._id },
        { $setOnInsert: { ...jobValues, state: "pending" } },
        { upsert: true },
      );
      if (inserted.upsertedCount === 0 && category === "superseded") {
        await models.ProofCleanupJob.updateOne(
          { proofId: proof._id, state: "retained", reason: category },
          { $set: { state: "pending", nextAttemptAt: startedAt, leaseId: null, leaseExpiresAt: null } },
        );
      }
    }

    for (const category of Object.keys(RETENTION_VARIABLES)) {
      const stats = report.categories[category];
      for (let page = 0; page < PAGE_SIZE; page += 1) {
        const leaseId = crypto.randomUUID();
        const leaseStart = now();
        const job = await claimCleanupJob(models.ProofCleanupJob, category, leaseStart, leaseId, LEASE_MS);
        if (!job) break;

        const jobProof = await models.PaymentProof.findOne({ _id: job.proofId }).select("+storageKey _id ownerId orderId status createdAt supersededAt");
        const persistJob = (set, filter) => models.ProofCleanupJob.updateOne(
          { ...filter, $expr: { $gt: ["$leaseExpiresAt", "$$NOW"] } },
          { $set: set },
        ).then((r) => r.modifiedCount === 1);

        if (!jobProof) {
          const outcome = await processProofCleanupJob({
            job, proof: null, deleteAsset, leaseId, now: leaseStart,
            persistJob,
          });
          if (outcome.state === "complete") stats.processedCount += 1;
          else stats.skippedCount += 1;
          continue;
        }

        // Recover jobs left by older versions or a process interruption after
        // the proof record was already tombstoned.
        if (jobProof.status === "deleted" && jobProof.storageKey === `deleted:${jobProof._id}`) {
          const recovered = await persistJob({
            state: "complete", leaseId: null, leaseExpiresAt: null, nextAttemptAt: null,
            lastErrorCode: null, lastAttemptAt: leaseStart,
          }, { _id: job._id, state: "processing", leaseId });
          if (recovered) stats.processedCount += 1;
          else stats.skippedCount += 1;
          continue;
        }

        const hasAudit = category !== "superseded" || Boolean(await models.SecurityAudit.exists(buildReplacementAuditQuery(jobProof)));
        if (!isEligibleForCleanup(jobProof, category, policy[category], leaseStart, hasAudit)) {
          await persistJob(
            { state: "retained", leaseId: null, leaseExpiresAt: null, nextAttemptAt: null, lastAttemptAt: leaseStart },
            { _id: job._id, state: "processing", leaseId },
          );
          stats.skippedCount += 1;
          continue;
        }

        const transition = await transitionProofForCleanup({
          models, job, proof: jobProof, category, retentionDays: policy[category], leaseId,
          now: leaseStart, withTransaction,
        });
        if (transition.state !== "ready") {
          stats.skippedCount += 1;
          continue;
        }

        const cleanupPending = transition.proof;
        const outcome = await processProofCleanupJob({
          job, proof: cleanupPending, deleteAsset, leaseId, now: leaseStart,
          finalizeDeletedProof: (proof) => finalizeProofCleanup({ models, job, proof, leaseId, now: leaseStart, withTransaction }),
          persistJob,
        });
        if (outcome.state === "complete") stats.processedCount += 1;
        else if (outcome.state === "retry") stats.failureCount += 1;
        else stats.skippedCount += 1;
      }
    }

    logger.info(JSON.stringify(report));
    return report;
  } finally {
    await disconnect();
  }
}

if (require.main === module) {
  runCleanup({ args: process.argv.slice(2) }).catch((error) => {
    const safeMessage = /^(PAYMENT_PROOF_[A-Z_]+|MONGODB_URL or MONGO_URL|Cleanup |Unsupported cleanup option)/.test(error.message || "");
    console.error(safeMessage ? error.message : "Payment-proof cleanup failed; check sanitized service logs.");
    process.exitCode = 1;
  });
}

module.exports = { runCleanup, parseArgs, transitionProofForCleanup, finalizeProofCleanup };
