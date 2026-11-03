const crypto = require("node:crypto");

function idOf(value) {
  if (value == null) return null;
  return String(value?._id ?? value);
}

function fingerprint(reference) {
  return typeof reference === "string"
    ? crypto.createHash("sha256").update(reference).digest("hex")
    : null;
}

function classifyReference(reference, hasPrivateRecord) {
  if (typeof reference !== "string" || !reference) return "unknown";
  if (hasPrivateRecord) return "private_proof_record";
  if (reference.startsWith("/uploads/")) return "legacy_local_public_url";
  if (/^https:\/\/res\.cloudinary\.com\//i.test(reference)) return "legacy_cloudinary_public_url";
  if (reference.startsWith("proof:")) return "legacy_private_storage_key";
  return "malformed_or_unrecognized";
}

function embeddedOwnerId(reference) {
  if (typeof reference !== "string") return null;
  const match = reference.match(/(?:^proof:payment-proofs\/|^\/uploads\/payment-proofs\/|\/payment-proofs\/)([a-f\d]{24})\//i);
  return match?.[1]?.toLowerCase() || null;
}

async function buildPaymentProofReconciliation({ orders = [], proofs = [], inspectAsset }) {
  if (typeof inspectAsset !== "function") throw new TypeError("An asset inspection function is required.");
  const proofById = new Map(proofs.map((proof) => [idOf(proof._id), proof]));
  const referenceOrders = new Map();
  const orderInputs = orders.map((order) => {
    const paymentProof = order.paymentProof || {};
    const reference = typeof paymentProof.storageKey === "string" && paymentProof.storageKey
      ? paymentProof.storageKey
      : typeof paymentProof.imageUrl === "string" && paymentProof.imageUrl
        ? paymentProof.imageUrl
        : null;
    if (reference) referenceOrders.set(reference, [...(referenceOrders.get(reference) || []), order]);
    return { order, paymentProof, reference };
  });

  const inspectionCache = new Map();
  const inspect = async (reference) => {
    if (!reference) return { storageType: "unknown", assetStatus: "unverified" };
    if (!inspectionCache.has(reference)) {
      try {
        inspectionCache.set(reference, await inspectAsset(reference));
      } catch (_) {
        inspectionCache.set(reference, { storageType: "unknown", assetStatus: "unverified" });
      }
    }
    return inspectionCache.get(reference);
  };

  const records = [];
  for (const { order, paymentProof, reference } of orderInputs) {
    const orderId = idOf(order._id);
    const customerId = idOf(order.userID);
    const proofRecordId = idOf(paymentProof.proofRecordId);
    const linkedProof = proofRecordId ? proofById.get(proofRecordId) : null;
    const duplicateOrders = reference ? referenceOrders.get(reference) || [] : [];
    const asset = await inspect(reference);
    const malformed = !reference || (proofRecordId && (!paymentProof.storageKey || !linkedProof));
    const referencedOwnerId = embeddedOwnerId(reference);
    const ownershipMismatch = !customerId || duplicateOrders.length > 1 || Boolean(referencedOwnerId && referencedOwnerId !== customerId.toLowerCase()) || Boolean(linkedProof && (
      idOf(linkedProof.ownerId) !== customerId ||
      idOf(linkedProof.orderId) !== orderId ||
      linkedProof.status !== "associated" ||
      linkedProof.storageKey !== reference
    ));
    let reviewStatus = "ready_for_manual_decision";
    if (duplicateOrders.length > 1) reviewStatus = "duplicate_reference";
    else if (asset.assetStatus === "missing") reviewStatus = "missing_asset";
    else if (malformed || ownershipMismatch || asset.assetStatus !== "present") reviewStatus = "needs_review";
    records.push({
      kind: "order_proof",
      orderId,
      customerId,
      proofRecordId,
      proofReference: reference,
      proofFingerprint: fingerprint(reference),
      storageType: classifyReference(reference, Boolean(proofRecordId)),
      assetStatus: asset.assetStatus || "unverified",
      sharedOrderIds: duplicateOrders.length > 1 ? duplicateOrders.map((item) => idOf(item._id)) : [],
      ownershipStatus: ownershipMismatch ? "ambiguous" : linkedProof ? "matched" : reference ? "legacy_unbound" : "missing",
      issueCodes: [
        ...(!reference ? ["missing_reference"] : []),
        ...(malformed ? ["malformed_record"] : []),
        ...(ownershipMismatch ? ["ambiguous_ownership"] : []),
        ...(duplicateOrders.length > 1 ? ["duplicate_reference"] : []),
        ...(asset.assetStatus === "missing" ? ["missing_asset"] : []),
        ...(asset.assetStatus !== "present" && asset.assetStatus !== "missing" ? ["asset_unverified"] : []),
      ],
      reviewStatus,
    });
  }

  const orderReferences = new Set(orderInputs.map(({ reference }) => reference).filter(Boolean));
  for (const proof of proofs) {
    if (proof.status !== "uploaded" || proof.orderId != null) continue;
    const reference = typeof proof.storageKey === "string" ? proof.storageKey : null;
    const asset = await inspect(reference);
    const relatedOrderRecords = reference ? referenceOrders.get(reference) || [] : [];
    const differentOwner = relatedOrderRecords.some((order) => idOf(order.userID) !== idOf(proof.ownerId));
    const reviewStatus = !reference || differentOwner || orderReferences.has(reference)
      ? "needs_review"
      : asset.assetStatus === "missing"
        ? "missing_asset"
        : "needs_review";
    records.push({
      kind: "unbound_upload",
      orderId: null,
      customerId: idOf(proof.ownerId),
      proofRecordId: idOf(proof._id),
      proofReference: reference,
      proofFingerprint: fingerprint(reference),
      storageType: classifyReference(reference, true),
      assetStatus: asset.assetStatus || "unverified",
      sharedOrderIds: relatedOrderRecords.map((item) => idOf(item._id)),
      ownershipStatus: differentOwner ? "ambiguous" : "unbound",
      issueCodes: [
        "unbound_upload",
        ...(!reference ? ["missing_reference"] : []),
        ...(differentOwner ? ["ambiguous_ownership"] : []),
        ...(relatedOrderRecords.length ? ["reference_also_on_order"] : []),
        ...(relatedOrderRecords.length > 1 ? ["duplicate_reference"] : []),
        ...(asset.assetStatus === "missing" ? ["missing_asset"] : []),
        ...(asset.assetStatus !== "present" && asset.assetStatus !== "missing" ? ["asset_unverified"] : []),
      ],
      reviewStatus,
    });
  }

  const counts = { total: records.length, byReviewStatus: {}, byKind: {}, byAssetStatus: {} };
  for (const record of records) {
    counts.byReviewStatus[record.reviewStatus] = (counts.byReviewStatus[record.reviewStatus] || 0) + 1;
    counts.byKind[record.kind] = (counts.byKind[record.kind] || 0) + 1;
    counts.byAssetStatus[record.assetStatus] = (counts.byAssetStatus[record.assetStatus] || 0) + 1;
  }
  return {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    records,
    summary: counts,
    limitations: [
      "Cloudinary assets are not contacted or verified; those references are reported as unverified.",
      "Filesystem checks inspect metadata only and do not validate receipt image contents.",
      "The report does not infer the correct owner or associate proofs; every ambiguous record requires a recorded owner decision.",
    ],
  };
}

module.exports = { buildPaymentProofReconciliation, fingerprint, classifyReference };
