const DAY_MS = 24 * 60 * 60 * 1000;
const LEGACY_RETENTION_VARIABLE = "PAYMENT_PROOF_RETENTION_DAYS";
const RETENTION_VARIABLES = Object.freeze({
  orphaned_upload: "PAYMENT_PROOF_ORPHAN_RETENTION_DAYS",
  superseded: "PAYMENT_PROOF_SUPERSEDED_RETENTION_DAYS",
});

function parseRetentionDays(value, variableName) {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    throw new Error(`${variableName} must be set to a positive whole number of days.`);
  }
  const days = Number(value.trim());
  const duration = days * DAY_MS;
  if (!Number.isSafeInteger(days) || days < 1 || !Number.isSafeInteger(duration) || duration > 8.64e15) {
    throw new Error(`${variableName} is outside the safe date range.`);
  }
  return days;
}

function loadRetentionPolicy(env = process.env) {
  if (env[LEGACY_RETENTION_VARIABLE] != null && String(env[LEGACY_RETENTION_VARIABLE]).trim() !== "") {
    throw new Error(`${LEGACY_RETENTION_VARIABLE} is no longer supported. Set both category-specific retention variables.`);
  }
  return Object.freeze({
    orphaned_upload: parseRetentionDays(env[RETENTION_VARIABLES.orphaned_upload], RETENTION_VARIABLES.orphaned_upload),
    superseded: parseRetentionDays(env[RETENTION_VARIABLES.superseded], RETENTION_VARIABLES.superseded),
  });
}

function getCutoff(now, retentionDays) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Cleanup clock must be a valid date.");
  const cutoffTime = now.getTime() - retentionDays * DAY_MS;
  const cutoff = new Date(cutoffTime);
  if (!Number.isFinite(cutoff.getTime()) || cutoff.getTime() > now.getTime()) {
    throw new Error("Cleanup cutoff is outside the safe date range.");
  }
  return cutoff;
}

function getRetentionTimestamp(proof, category) {
  if (category === "orphaned_upload" && ["uploaded", "cleanup_pending"].includes(proof?.status)) return proof.createdAt;
  if (category === "superseded" && ["superseded", "cleanup_pending"].includes(proof?.status)) return proof.supersededAt;
  return null;
}

function isEligibleForCleanup(proof, category, retentionDays, now = new Date(), hasReplacementAudit = true) {
  if (!proof || proof.orderId != null) return false;
  if (category === "orphaned_upload" && !["uploaded", "cleanup_pending"].includes(proof.status)) return false;
  if (category === "superseded" && (!["superseded", "cleanup_pending"].includes(proof.status) || !hasReplacementAudit)) return false;
  const timestamp = getRetentionTimestamp(proof, category);
  if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime()) || timestamp.getTime() > now.getTime()) return false;
  return timestamp.getTime() <= getCutoff(now, retentionDays).getTime();
}

function buildCleanupProofQuery(category) {
  if (!Object.hasOwn(RETENTION_VARIABLES, category)) throw new Error("Unknown payment proof cleanup category.");
  return {
    orderId: null,
    status: { $in: [category === "orphaned_upload" ? "uploaded" : "superseded", "cleanup_pending"] },
  };
}

function buildReplacementAuditQuery(proof) {
  return {
    action: "proof_replaced",
    oldProofId: proof?._id,
    orderId: { $exists: true },
    actorId: proof?.ownerId,
    actorRole: "user",
    newProofId: { $exists: true },
  };
}

function buildCleanupJobClaimFilter(now) {
  return {
    $or: [
      { state: { $in: ["pending", "retry"] }, nextAttemptAt: { $lte: now } },
      { state: "processing", leaseExpiresAt: { $lte: now } },
    ],
  };
}

async function claimCleanupJob(Model, category, now, leaseId, leaseMs) {
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  if (!Number.isFinite(leaseExpiresAt.getTime()) || leaseExpiresAt.getTime() <= now.getTime()) {
    throw new Error("Cleanup lease time is outside the safe date range.");
  }
  return Model.findOneAndUpdate(
    { reason: category, ...buildCleanupJobClaimFilter(now) },
    {
      $set: { state: "processing", leaseId, leaseExpiresAt, nextAttemptAt: leaseExpiresAt },
      $inc: { attempts: 1 },
    },
    { new: true, sort: { nextAttemptAt: 1, createdAt: 1 } },
  );
}

function nextRetryTime(now, attempt) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Retry clock must be a valid date.");
  const delayHours = Math.min(24, 2 ** Math.min(Math.max(1, attempt), 5));
  const result = new Date(now.getTime() + delayHours * 60 * 60 * 1000);
  if (!Number.isFinite(result.getTime()) || result.getTime() < now.getTime()) throw new Error("Retry time is outside the safe date range.");
  return result;
}

async function processProofCleanupJob({ job, proof, deleteAsset, finalizeDeletedProof, persistJob, leaseId, now = new Date() }) {
  if (!job || job.state !== "processing" || !leaseId || job.leaseId !== leaseId) {
    return { state: "lease_lost" };
  }
  if (!proof) {
    const updated = await persistJob({
      state: "complete", leaseId: null, leaseExpiresAt: null, nextAttemptAt: null,
      lastErrorCode: null, lastAttemptAt: now,
    }, { _id: job._id, state: "processing", leaseId });
    return { state: updated ? "complete" : "lease_lost" };
  }

  try {
    await deleteAsset(proof.storageKey);
    const updated = await finalizeDeletedProof(proof);
    return { state: updated ? "complete" : "lease_lost" };
  } catch (error) {
    const code = /^[A-Z0-9_]+$/.test(error?.code || "") ? error.code : "STORAGE_CLEANUP_FAILED";
    const updated = await persistJob({
      state: "retry", leaseId: null, leaseExpiresAt: null,
      nextAttemptAt: nextRetryTime(now, job.attempts || 1),
      lastErrorCode: code, lastAttemptAt: now,
    }, { _id: job._id, state: "processing", leaseId });
    return { state: updated ? "retry" : "lease_lost", errorCode: updated ? code : undefined };
  }
}

module.exports = {
  DAY_MS,
  RETENTION_VARIABLES,
  loadRetentionPolicy,
  getCutoff,
  getRetentionTimestamp,
  isEligibleForCleanup,
  buildCleanupProofQuery,
  buildReplacementAuditQuery,
  buildCleanupJobClaimFilter,
  claimCleanupJob,
  nextRetryTime,
  processProofCleanupJob,
};
