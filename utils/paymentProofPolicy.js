const PaymentProof = require("../model/paymentProof");
const { isProofRequired } = require("./paymentMethods");

function isEligibleForProofReplacement(order, customerId) {
  const ownerId = order?.userID?._id?.toString?.() ?? order?.userID?.toString?.();
  return Boolean(
    order && ownerId === customerId?.toString() &&
    isProofRequired(order) && order.paymentStatus === "pending" &&
    ["pending", "payment_pending"].includes(order.orderStatus),
  );
}

async function claimUploadedProof({ proofRecordId, ownerId, orderId, session }) {
  let query = PaymentProof.findOneAndUpdate(
    { _id: proofRecordId, ownerId, orderId: null, status: "uploaded" },
    { $set: { orderId, status: "associated" } },
    { new: true, session },
  );
  // storageKey is intentionally hidden from ordinary model reads and API
  // serialization. Select it only for this server-side transactional claim.
  if (typeof query?.select === "function") query = query.select("+storageKey");
  const proof = await query;
  if (proof?.storageKey) return proof;
  const error = new Error("This payment proof was already used or is unavailable.");
  error.statusCode = 409;
  throw error;
}

module.exports = { isEligibleForProofReplacement, claimUploadedProof };
