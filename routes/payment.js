const express = require("express");
const sendRouteError = require("../utils/sendRouteError");
const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const Order = require("../model/order");
const Product = require("../model/product");
const PaymentProof = require("../model/paymentProof");
const SecurityAudit = require("../model/securityAudit");
const { isProofRequired } = require("../utils/paymentMethods");
const { releaseInventoryReservation } = require("../utils/inventoryReservation");
const { privateProofLocation, deliverPrivatePaymentProof, deliverLegacyPaymentProof, savePrivatePaymentProof, deletePrivatePaymentProof } = require("../uploadFile");
const router = express.Router();
const { uploadPaymentProof, uploadLimiter } = require("../uploadFile");
const {
  requireAdminAuth,
  requireCapability,
  requireUserAuth,
  loadAdmin,
  loadUser,
} = require("../middleware/adminAccess");

router.post(
  "/upload-proof",
  requireUserAuth,
  uploadLimiter,
  uploadPaymentProof.single("proofImage"),
  asyncHandler(async (req, res) => {
    let registered = false;
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, message: "No file uploaded." });
      }

      const proof = await PaymentProof.create({
        ownerId: req.authUser._id,
        storageKey: req.file.path,
      });
      registered = true;

      res.json({
        success: true,
        message: "Payment proof uploaded successfully.",
        data: {
          proofRecordId: proof._id,
        },
      });
    } catch (error) {
      if (req.file?.path && !registered) {
        try { await deletePrivatePaymentProof(req.file.path); }
        catch (_) { console.error("Unregistered payment proof cleanup needs operator review."); }
      }
      console.error("Payment proof upload failed.");
      sendRouteError(res, error, { safeResponse: true });
    }
  }),
);

// Alternative endpoint for base64 image upload to Cloudinary
router.post(
  "/upload-proof-base64",
  requireUserAuth,
  uploadLimiter,
  express.json({ limit: "14mb" }),
  asyncHandler(async (req, res) => {
    let proofId;
    let registered = false;
    try {
      const { image } = req.body;

      if (
        typeof image !== "string" ||
        !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image)
      ) {
        return res.status(400).json({
          success: false,
          message: "A valid image data URL is required.",
        });
      }

      const base64Data = image.split(",", 2)[1];
      const imageBytes = Buffer.from(base64Data, "base64");
      if (!imageBytes.length || imageBytes.length > 10 * 1024 * 1024) {
        return res.status(400).json({
          success: false,
          message: "Payment proof images must be 10 MB or smaller.",
        });
      }

      proofId = await savePrivatePaymentProof(imageBytes, req.authUser._id);
      const proof = await PaymentProof.create({ ownerId: req.authUser._id, storageKey: proofId });
      registered = true;

      res.json({
          success: true,
          message: "Payment proof uploaded successfully.",
          data: {
            proofRecordId: proof._id,
            verified: false,
            verifiedAt: null,
          },
        });
    } catch (error) {
      if (proofId && !registered) {
        try { await deletePrivatePaymentProof(proofId); }
        catch (_) { console.error("Unregistered payment proof cleanup needs operator review."); }
      }
      console.error("Payment proof upload failed.");
      res.status(error.statusCode || 500).json({ success: false, message: "Could not upload the payment proof." });
    }
  }),
);

// Receipt bytes are only returned after checking the associated order owner
// or an authenticated administrator. Never accept a storage key from callers.
router.get(
  "/proofs/:orderId",
  asyncHandler(async (req, res) => {
    let order;
    let orderOwnerId;
    await loadUser(req, res, () => {});
    if (req.authUser) {
      order = await Order.findById(req.params.orderId);
      orderOwnerId = order?.userID?._id?.toString?.() ?? order?.userID?.toString?.();
      if (!order || !orderOwnerId || orderOwnerId !== req.authUser._id.toString()) {
        return res.status(404).json({ success: false, message: "Payment proof not found." });
      }
    } else {
      await loadAdmin(req, res, () => {});
      if (!req.adminUser) return res.status(401).json({ success: false, message: "Authentication required." });
      if (!["admin", "super_admin"].includes(req.adminUser.clearanceLevel)) {
        return res.status(403).json({ success: false, message: "You are not authorized to review payment proofs." });
      }
      order = await Order.findById(req.params.orderId);
      orderOwnerId = order?.userID?._id?.toString?.() ?? order?.userID?.toString?.();
    }
    if (!order || !orderOwnerId) return res.status(404).json({ success: false, message: "Payment proof not found." });
    const proofId = order.paymentProof?.storageKey;
    const proofRecordId = order.paymentProof?.proofRecordId;
    if (proofId || proofRecordId) {
      // New private proofs must be backed by their owned, associated record.
      // A storage key without that association is ambiguous and fails closed.
      if (!proofId || !mongoose.isValidObjectId(proofRecordId)) {
        return res.status(404).json({ success: false, message: "Payment proof is unavailable." });
      }
      const proof = await PaymentProof.findOne({
        _id: proofRecordId,
        ownerId: orderOwnerId,
        orderId: order._id,
        status: "associated",
      }).select("+storageKey");
      if (!proof || proof.storageKey !== proofId) {
        return res.status(404).json({ success: false, message: "Payment proof is unavailable." });
      }
      const location = privateProofLocation(proofId);
      if (!location || location.userId !== orderOwnerId) {
        return res.status(404).json({ success: false, message: "Payment proof is unavailable." });
      }
      res.set("Cache-Control", "private, no-store");
      if (!await deliverPrivatePaymentProof(proofId, res)) {
        return res.status(404).json({ success: false, message: "Payment proof is unavailable." });
      }
      return;
    }

    // Only validated, owner-matched legacy local paths remain serviceable.
    // Legacy Cloudinary public URLs are deliberately not fetched.
    if (order.paymentProof?.imageUrl && await deliverLegacyPaymentProof(order.paymentProof.imageUrl, orderOwnerId, res)) return;
    return res.status(404).json({ success: false, message: "Payment proof is unavailable." });
  }),
);

// Verify payment (admin endpoint)
router.post(
  "/verify-payment/:orderId",
  requireAdminAuth,
  requireCapability("payments.review"),
  asyncHandler(async (req, res) => {
    try {
      const orderId = req.params.orderId;
      const { verified } = req.body;
      if (typeof verified !== "boolean") return res.status(400).json({ success: false, message: "Verification status must be boolean." });

      const session = await mongoose.startSession();
      let updatedOrder;
      try {
        await session.withTransaction(async () => {
          updatedOrder = await Order.findById(orderId).session(session);
          if (!updatedOrder) { const error = new Error("Order not found."); error.statusCode = 404; throw error; }
          const proofAvailable = Boolean(updatedOrder.paymentProof?.storageKey || updatedOrder.paymentProof?.imageUrl);
          if (isProofRequired(updatedOrder) && !proofAvailable) { const error = new Error("This order has no payment proof to review."); error.statusCode = 409; throw error; }
          if (updatedOrder.paymentStatus !== "pending" || ["cancelled", "delivered", "ready_for_collection", "collected"].includes(updatedOrder.orderStatus)) { const error = new Error("This order is no longer eligible for payment review."); error.statusCode = 409; throw error; }
          updatedOrder.paymentStatus = verified ? "verified" : "failed";
          updatedOrder.orderStatus = verified ? "processing" : "cancelled";
          if (!verified) {
            await releaseInventoryReservation(updatedOrder, { Product, session, reason: "payment_rejected" });
          }
          if (proofAvailable) {
            updatedOrder.paymentProof.verified = verified;
            updatedOrder.paymentProof.verifiedAt = verified ? new Date() : null;
          }
          await updatedOrder.save({ session });
          await SecurityAudit.create([{
            action: verified ? "payment_verified" : "payment_rejected",
            orderId: updatedOrder._id,
            actorId: req.adminUser._id,
            actorRole: req.adminUser.clearanceLevel,
          }], { session });
        });
      } finally { await session.endSession(); }

      res.json({
        success: true,
        message: `Payment ${verified ? "verified" : "rejected"} successfully.`,
        data: updatedOrder,
      });
    } catch (error) {
      sendRouteError(res, error, { safeResponse: true });
    }
  }),
);

module.exports = router;
