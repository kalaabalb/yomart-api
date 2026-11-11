const express = require("express");
const sendRouteError = require("../utils/sendRouteError");
const mongoose = require("mongoose");
const asyncHandler = require("express-async-handler");
const router = express.Router();
const Order = require("../model/order");
const OrderIdempotency = require("../model/orderIdempotency");
const PaymentProof = require("../model/paymentProof");
const SecurityAudit = require("../model/securityAudit");
const ProofCleanupJob = require("../model/proofCleanupJob");
const { isEligibleForProofReplacement, claimUploadedProof } = require("../utils/paymentProofPolicy");
const StoreSettings = require("../model/storeSettings");
const Product = require("../model/product");
const User = require("../model/user");
const {
  normalizeIdempotencyKey,
  createOrderRequestFingerprint,
  ensureOrderIdempotencyIndex,
  findIdempotentOrder,
  isDuplicateKeyError,
} = require("../utils/orderIdempotency");
const { privateProofLocation } = require("../uploadFile");
const { ORDER_STATUSES, normalizeCollectionPoint, canTransitionOrderStatus } = require("../utils/orderFulfillment");
const { paymentMethodSnapshot, isProofRequired, isCashCollection } = require("../utils/paymentMethods");
const { releaseInventoryReservation, consumeInventoryReservation } = require("../utils/inventoryReservation");
const {
  requireAdminAuth,
  requireUserAuth,
  loadAdmin,
  loadUser,
  requireCapability,
} = require("../middleware/adminAccess");

// Get all orders
router.get(
  "/",
  asyncHandler(async (req, res) => {
    try {
      await loadUser(req, res, () => {});
      if (req.authUser) {
        const orders = await Order.find({ userID: req.authUser._id })
          .populate("userID", "id name")
          .sort({ _id: -1 });
        return res.json({
          success: true,
          message: "Orders retrieved successfully.",
          data: orders,
        });
      }

      await loadAdmin(req, res, () => {});
      if (!req.adminUser) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized. Please login again.",
        });
      }
      if (!["admin", "super_admin"].includes(req.adminUser.clearanceLevel)) {
        return res.status(403).json({ success: false, message: "You are not authorized to view customer orders." });
      }

      const orders = await Order.find()
        .populate("userID", "id name")
        .sort({ _id: -1 });
      res.json({
        success: true,
        message: "Orders retrieved successfully.",
        data: orders,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Get orders by user ID
router.get(
  "/orderByUserId/:userId",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    try {
      const userId = req.params.userId;
      if (req.authUser._id.toString() !== userId) {
        return res.status(403).json({
          success: false,
          message: "You can only view your own orders.",
        });
      }
      const orders = await Order.find({ userID: userId })
        .populate("userID", "id name")
        .sort({ _id: -1 });
      res.json({
        success: true,
        message: "Orders retrieved successfully.",
        data: orders,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Get an order by ID
router.get(
  "/:id",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    try {
      const orderID = req.params.id;
      const order = await Order.findById(orderID).populate("userID", "id name");
      if (!order) {
        return res
          .status(404)
          .json({ success: false, message: "Order not found." });
      }

      // Never treat an order with a missing/deleted owner as visible to any
      // signed-in customer. Historical malformed records must fail closed.
      const orderOwnerId = order.userID?._id?.toString?.() ?? order.userID?.toString?.();
      if (!orderOwnerId || orderOwnerId !== req.authUser._id.toString()) {
        return res.status(403).json({
          success: false,
          message: "You can only view your own orders.",
        });
      }
      res.json({
        success: true,
        message: "Order retrieved successfully.",
        data: order,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Create a new order
router.post(
  "/",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const { userID, items, shippingAddress, paymentMethod, paymentProof } = req.body;
    const idempotencyKey = normalizeIdempotencyKey(req.get("Idempotency-Key"));

    if (
      !Array.isArray(items) ||
      items.length === 0 ||
      items.length > 50 ||
      !shippingAddress ||
      typeof shippingAddress !== "object" ||
      Array.isArray(shippingAddress) ||
      !paymentMethod
    ) {
      return res.status(400).json({
        success: false,
        message: "A valid item list, customer destination, and payment method are required.",
      });
    }

    const hasLatitude = shippingAddress.latitude != null &&
      !(typeof shippingAddress.latitude === "string" && !shippingAddress.latitude.trim());
    const hasLongitude = shippingAddress.longitude != null &&
      !(typeof shippingAddress.longitude === "string" && !shippingAddress.longitude.trim());
    const latitude = hasLatitude ? Number(shippingAddress.latitude) : undefined;
    const longitude = hasLongitude ? Number(shippingAddress.longitude) : undefined;
    if (
      hasLatitude !== hasLongitude ||
      (hasLatitude && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180))
    ) {
      return res.status(400).json({ success: false, message: "Map coordinates must include a valid latitude and longitude." });
    }
    const address = {
      phone: typeof shippingAddress.phone === "string" ? shippingAddress.phone.trim().slice(0, 40) : "",
      street: typeof shippingAddress.street === "string" ? shippingAddress.street.trim().slice(0, 200) : "",
      city: typeof shippingAddress.city === "string" ? shippingAddress.city.trim().slice(0, 100) : "",
      state: typeof shippingAddress.state === "string" ? shippingAddress.state.trim().slice(0, 100) : "",
      country: typeof shippingAddress.country === "string" ? shippingAddress.country.trim().slice(0, 100) : "",
      latitude,
      longitude,
    };
    if (!address.phone || !address.city) {
      return res.status(400).json({
        success: false,
        message: "Phone and destination city are required.",
      });
    }

    if (!idempotencyKey) {
      return res.status(400).json({
        success: false,
        message: "A valid Idempotency-Key header is required to place an order.",
      });
    }

    if (typeof paymentMethod !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,79}$/.test(paymentMethod)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid payment method." });
    }

    if (userID && userID !== req.authUser._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "You can only create orders for your own account.",
      });
    }

    const proofRecordId = paymentProof?.proofRecordId;

    const requestedItems = items.map((item) => ({
      productID: item?.productID,
      quantity: Number(item?.quantity),
      variant: typeof item?.variant === "string" ? item.variant.trim().slice(0, 120) : "",
    }));
    if (
      requestedItems.some((item) =>
        !mongoose.isValidObjectId(item.productID) ||
        !Number.isInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > 100
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Each order item needs a valid product and quantity between 1 and 100.",
      });
    }

    let requestFingerprint;
    try {
      requestFingerprint = createOrderRequestFingerprint({
        items: requestedItems,
        shippingAddress: address,
        paymentMethod,
        paymentProof,
      });
      // Make the unique constraint effective before any order transaction can
      // reserve stock. This is safe on repeated calls and fails closed if the
      // database cannot establish the required concurrency guarantee.
      await ensureOrderIdempotencyIndex(OrderIdempotency);
      const previousOrder = await findIdempotentOrder({
        OrderIdempotency,
        Order,
        userId: req.authUser._id,
        key: idempotencyKey,
        requestFingerprint,
      });
      if (previousOrder) {
        return res.json({
          success: true,
          message: "Order created successfully.",
          data: previousOrder,
        });
      }
    } catch (error) {
      const status = error.statusCode || 503;
      return res.status(status).json({
        success: false,
        message: status === 409
          ? error.message
          : "Could not safely prepare this checkout. Please try again.",
      });
    }

    // A retry must return its committed order even if payment settings changed
    // after the original request. New attempts still require current settings.
    const storeSettings = await StoreSettings.findOne({ key: "storefront" });
    const configuredMethod = storeSettings?.paymentMethods.find(
      (method) => method.code === paymentMethod,
    );
    if (!storeSettings || !configuredMethod || !configuredMethod.enabled) {
      return res.status(400).json({
        success: false,
        message: "This payment method is currently unavailable.",
      });
    }
    const methodSnapshot = paymentMethodSnapshot(configuredMethod);
    if (!methodSnapshot) {
      return res.status(409).json({ success: false, message: "This payment method is not configured safely." });
    }
    if (methodSnapshot.requiresProof && !mongoose.isValidObjectId(proofRecordId)) {
      return res.status(400).json({ success: false, message: "Upload your payment proof before placing this order." });
    }
    if (!methodSnapshot.requiresProof && proofRecordId) {
      return res.status(400).json({ success: false, message: "This payment method does not accept a payment proof." });
    }

    let session;
    try {
      session = await mongoose.startSession();
      let createdOrder;
      const reservedOrderId = new mongoose.Types.ObjectId();
      await session.withTransaction(async () => {
        await OrderIdempotency.create([{
          userId: req.authUser._id,
          key: idempotencyKey,
          requestFingerprint,
          orderId: reservedOrderId,
        }], { session });

        let currentSettingsQuery = StoreSettings.findOne({ key: "storefront" });
        if (typeof currentSettingsQuery.session === "function") currentSettingsQuery = currentSettingsQuery.session(session);
        const currentSettings = await currentSettingsQuery;
        const currentMethod = currentSettings?.paymentMethods?.find((method) => method.code === paymentMethod && method.enabled);
        const currentMethodSnapshot = paymentMethodSnapshot(currentMethod);
        if (!currentMethod || !currentMethodSnapshot) {
          const error = new Error("This payment method is currently unavailable.");
          error.statusCode = 409;
          throw error;
        }
        if (currentMethodSnapshot.requiresProof && !mongoose.isValidObjectId(proofRecordId)) {
          const error = new Error("Upload your payment proof before placing this order.");
          error.statusCode = 400;
          throw error;
        }
        if (!currentMethodSnapshot.requiresProof && proofRecordId) {
          const error = new Error("This payment method does not accept a payment proof.");
          error.statusCode = 400;
          throw error;
        }

        const activeCustomer = await User.findOne({ _id: req.authUser._id, accountStatus: { $ne: "deleted" } }).session(session);
        if (!activeCustomer) {
          const error = new Error("Your account is no longer active.");
          error.statusCode = 401;
          throw error;
        }
        const trustedItems = [];
        for (const requested of requestedItems) {
          const product = await Product.findOneAndUpdate(
            {
              _id: requested.productID,
              isActive: { $ne: false },
              quantity: { $gte: requested.quantity },
            },
            { $inc: { quantity: -requested.quantity } },
            { new: true, session },
          );
          if (!product) {
            const error = new Error("A product is unavailable or has insufficient stock.");
            error.statusCode = 409;
            throw error;
          }

          const price = product.offerPrice != null && product.offerPrice < product.price
            ? product.offerPrice
            : product.price;
          trustedItems.push({
            productID: product._id,
            productName: product.name,
            quantity: requested.quantity,
            price,
            ...(requested.variant ? { variant: requested.variant } : {}),
          });
        }

        const total = Math.round(
          trustedItems.reduce((sum, item) => sum + item.price * item.quantity, 0) * 100,
        ) / 100;
        const deliveryFee = 0;
        const grandTotal = total;
        let proofRecord = null;
        if (currentMethodSnapshot.requiresProof) {
          proofRecord = await claimUploadedProof({ proofRecordId, ownerId: req.authUser._id, orderId: reservedOrderId, session });
          const proofLocation = privateProofLocation(proofRecord.storageKey);
          if (!proofLocation || proofLocation.userId !== req.authUser._id.toString()) {
            const error = new Error("This payment proof is unavailable.");
            error.statusCode = 409;
            throw error;
          }
        }
        const [order] = await Order.create([{
          _id: reservedOrderId,
          userID: req.authUser._id,
          orderStatus: isCashCollection({ paymentMethod, paymentMethodSnapshot: currentMethodSnapshot }) ? "pending" : "payment_pending",
          items: trustedItems,
          totalPrice: grandTotal,
          shippingAddress: address,
          paymentMethod,
          paymentMethodSnapshot: currentMethodSnapshot,
          paymentStatus: "pending",
          inventoryReservation: {
            state: "reserved",
            items: trustedItems.map((item) => ({ productID: item.productID, quantity: item.quantity })),
            reservedAt: new Date(),
          },
          ...(currentMethodSnapshot.requiresProof
            ? { paymentProof: { storageKey: proofRecord.storageKey, proofRecordId: proofRecord._id, uploadedAt: new Date(), verified: false } }
            : {}),
          orderTotal: { subtotal: total, delivery: deliveryFee, total: grandTotal },
        }], { session });
        if (proofRecord) {
          await SecurityAudit.create([{
            action: "proof_associated",
            orderId: order._id,
            actorId: req.authUser._id,
            actorRole: "user",
            newProofId: proofRecord._id,
          }], { session });
        }
        createdOrder = order;
      });
      res.json({
        success: true,
        message: "Order created successfully.",
        data: createdOrder,
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        try {
          const previousOrder = await findIdempotentOrder({
            OrderIdempotency,
            Order,
            userId: req.authUser._id,
            key: idempotencyKey,
            requestFingerprint,
          });
          if (previousOrder) {
            return res.json({
              success: true,
              message: "Order created successfully.",
              data: previousOrder,
            });
          }
        } catch (idempotencyError) {
          const status = idempotencyError.statusCode || 503;
          return res.status(status).json({
            success: false,
            message: status === 409
              ? idempotencyError.message
              : "Could not safely confirm the previous checkout. Please try again.",
          });
        }
      }
      const status = error.statusCode || (error.name === "ValidationError" ? 400 : 500);
      res.status(status).json({
        success: false,
        message: status >= 500
          ? "Could not create the order right now. Please try again."
          : error.message,
      });
    } finally {
      await session?.endSession();
    }
  }),
);

// Update an order status
router.put(
  "/:id",
  requireAdminAuth,
  requireCapability("orders.fulfill"),
  asyncHandler(async (req, res) => {
    try {
      const orderID = req.params.id;
      const { orderStatus, trackingUrl, collectionPoint: requestedCollectionPoint } = req.body;
      if (!orderStatus) {
        return res
          .status(400)
          .json({ success: false, message: "Order Status required." });
      }
      if (!ORDER_STATUSES.includes(orderStatus)) {
        return res.status(400).json({ success: false, message: "Unsupported order status." });
      }
      if (trackingUrl !== undefined && typeof trackingUrl !== "string") {
        return res.status(400).json({
          success: false,
          message: "Tracking URL must be a string.",
        });
      }
      const normalizedTrackingUrl = trackingUrl?.trim();
      if (normalizedTrackingUrl) {
        try {
          const url = new URL(normalizedTrackingUrl);
          if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
        } catch (_) {
          return res.status(400).json({
            success: false,
            message: "Tracking URL must use HTTP or HTTPS.",
          });
        }
      }

      const session = await mongoose.startSession();
      let updatedOrder;
      try {
        await session.withTransaction(async () => {
          updatedOrder = await Order.findById(orderID).session(session);
          if (!updatedOrder) {
            const error = new Error("Order not found.");
            error.statusCode = 404;
            throw error;
          }

          if (!canTransitionOrderStatus(updatedOrder.orderStatus, orderStatus)) {
            const error = new Error("This order status transition is not allowed.");
            error.statusCode = 409;
            throw error;
          }
          if (["shipped", "ready_for_collection", "collected"].includes(orderStatus) &&
              !isCashCollection(updatedOrder) && updatedOrder.paymentStatus !== "verified") {
            const error = new Error("Payment must be verified before fulfillment.");
            error.statusCode = 409;
            throw error;
          }
          if (requestedCollectionPoint !== undefined) {
            if (requestedCollectionPoint === null) {
              if (["ready_for_collection", "collected"].includes(orderStatus)) {
                const error = new Error("A collection point is required for this status.");
                error.statusCode = 400;
                throw error;
              }
              updatedOrder.collectionPoint = undefined;
            } else {
              const point = normalizeCollectionPoint(requestedCollectionPoint);
              if (!point) {
                const error = new Error("Collection point name, address, and city are required.");
                error.statusCode = 400;
                throw error;
              }
              updatedOrder.collectionPoint = { ...point, agreedAt: new Date() };
            }
          }
          if (["ready_for_collection", "collected"].includes(orderStatus) && !normalizeCollectionPoint(updatedOrder.collectionPoint)) {
            const error = new Error("Record the agreed collection point before using a collection status.");
            error.statusCode = 400;
            throw error;
          }
          if (orderStatus === "collected" && !["ready_for_collection", "collected"].includes(updatedOrder.orderStatus)) {
            const error = new Error("Only an order ready for collection can be marked collected.");
            error.statusCode = 409;
            throw error;
          }

          if (orderStatus === "cancelled") {
            await releaseInventoryReservation(updatedOrder, { Product, session, reason: "cancelled" });
          } else if (["collected", "delivered"].includes(orderStatus)) {
            consumeInventoryReservation(updatedOrder);
          }
          updatedOrder.orderStatus = orderStatus;
          if (trackingUrl !== undefined) updatedOrder.trackingUrl = normalizedTrackingUrl.slice(0, 500);
          await updatedOrder.save({ session });
        });
      } finally {
        await session.endSession();
      }

      res.json({
        success: true,
        message: "Order updated successfully.",
        data: updatedOrder,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Verify payment (admin endpoint)
router.put(
  "/:id/verify-payment",
  requireAdminAuth,
  requireCapability("payments.review"),
  asyncHandler(async (req, res) => {
    try {
      const orderID = req.params.id;
      const { verified } = req.body;

      if (typeof verified !== "boolean") {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Verification status (verified) is required and must be boolean.",
          });
      }

      const session = await mongoose.startSession();
      let updatedOrder;
      try {
        await session.withTransaction(async () => {
          const order = await Order.findById(orderID).session(session);
          if (!order) { const error = new Error("Order not found."); error.statusCode = 404; throw error; }
          const proofAvailable = Boolean(order.paymentProof?.storageKey || order.paymentProof?.imageUrl);
          if (isProofRequired(order) && !proofAvailable) { const error = new Error("This order has no payment proof to review."); error.statusCode = 409; throw error; }
          if (order.paymentStatus !== "pending" || ["cancelled", "delivered", "ready_for_collection", "collected"].includes(order.orderStatus)) { const error = new Error("This order is no longer eligible for payment review."); error.statusCode = 409; throw error; }
          order.paymentStatus = verified ? "verified" : "failed";
          order.orderStatus = verified ? "processing" : "cancelled";
          if (!verified) {
            await releaseInventoryReservation(order, { Product, session, reason: "payment_rejected" });
          }
          if (proofAvailable) {
            order.paymentProof.verified = verified;
            order.paymentProof.verifiedAt = verified ? new Date() : null;
          }
          updatedOrder = await order.save({ session });
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
      sendRouteError(res, error);
    }
  }),
);

// Update payment proof
router.put(
  "/:id/payment-proof",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    try {
      const orderID = req.params.id;
      const proofRecordId = req.body?.proofRecordId;

      if (!mongoose.isValidObjectId(proofRecordId)) {
        return res
          .status(400)
          .json({ success: false, message: "Upload a valid payment proof first." });
      }

      const order = await Order.findById(orderID);
      if (!order) {
        return res
          .status(404)
          .json({ success: false, message: "Order not found." });
      }

      if (order.userID.toString() !== req.authUser._id.toString()) {
        return res.status(403).json({
          success: false,
          message: "You can only update your own order payment proof.",
        });
      }

      if (!isEligibleForProofReplacement(order, req.authUser._id)) {
        return res.status(409).json({ success: false, message: "This order is no longer eligible for proof replacement." });
      }
      if (order.paymentProof?.storageKey && !order.paymentProof?.proofRecordId) {
        return res.status(409).json({ success: false, message: "This legacy proof must be reconciled before it can be replaced." });
      }

      const session = await mongoose.startSession();
      let updatedOrder;
      try {
        await session.withTransaction(async () => {
          const activeCustomer = await User.findOne({ _id: req.authUser._id, accountStatus: { $ne: "deleted" } }).session(session);
          if (!activeCustomer) { const error = new Error("Your account is no longer active."); error.statusCode = 401; throw error; }
          const currentOrder = await Order.findById(orderID).session(session);
          if (!currentOrder || currentOrder.userID.toString() !== req.authUser._id.toString()) { const error = new Error("Order not found."); error.statusCode = 404; throw error; }
          if (!isEligibleForProofReplacement(currentOrder, req.authUser._id) || (currentOrder.paymentProof?.storageKey && !currentOrder.paymentProof?.proofRecordId)) {
            const error = new Error("This order is no longer eligible for proof replacement.");
            error.statusCode = 409;
            throw error;
          }
          const oldProofId = currentOrder.paymentProof?.proofRecordId;
          if (oldProofId) {
            const detached = await PaymentProof.findOneAndUpdate(
              { _id: oldProofId, orderId: order._id, status: "associated" },
              { $set: { status: "superseded", orderId: null, supersededAt: new Date() } },
              { new: true, session },
            );
            if (!detached) {
              const error = new Error("The current payment proof association is inconsistent.");
              error.statusCode = 409;
              throw error;
            }
            await ProofCleanupJob.updateOne(
              { proofId: oldProofId },
              { $setOnInsert: { reason: "superseded", state: "retained", nextAttemptAt: new Date(8640000000000000) } },
              { upsert: true, session },
            );
          }
          const newProof = await claimUploadedProof({ proofRecordId, ownerId: req.authUser._id, orderId: order._id, session });
          const proofLocation = privateProofLocation(newProof.storageKey);
          if (!proofLocation || proofLocation.userId !== req.authUser._id.toString()) {
            const error = new Error("This payment proof is unavailable.");
            error.statusCode = 409;
            throw error;
          }
          currentOrder.paymentProof = {
            storageKey: newProof.storageKey,
            proofRecordId: newProof._id,
            uploadedAt: new Date(),
            verified: false,
            verifiedAt: null,
          };
          currentOrder.paymentStatus = "pending";
          currentOrder.orderStatus = "payment_pending";
          updatedOrder = await currentOrder.save({ session });
          await SecurityAudit.create([{
            action: oldProofId ? "proof_replaced" : "proof_associated",
            orderId: order._id,
            actorId: req.authUser._id,
            actorRole: "user",
            ...(oldProofId ? { oldProofId } : {}),
            newProofId: newProof._id,
          }], { session });
        });
      } finally {
        await session.endSession();
      }

      res.json({
        success: true,
        message: "Payment proof updated successfully.",
        data: updatedOrder,
      });
    } catch (error) {
      sendRouteError(res, error, { safeResponse: true });
    }
  }),
);

// Get orders by payment status
router.get(
  "/payment-status/:status",
  requireAdminAuth,
  requireCapability("orders.read"),
  asyncHandler(async (req, res) => {
    try {
      const paymentStatus = req.params.status;
      const validStatuses = ["pending", "verified", "failed"];

      if (!validStatuses.includes(paymentStatus)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid payment status." });
      }

      const orders = await Order.find({ paymentStatus: paymentStatus })
        .populate("userID", "id name")
        .sort({ _id: -1 });

      res.json({
        success: true,
        message: "Orders retrieved successfully.",
        data: orders,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Get orders requiring payment verification (admin endpoint)
router.get(
  "/admin/pending-verification",
  requireAdminAuth,
  requireCapability("payments.review"),
  asyncHandler(async (req, res) => {
    try {
      const orders = await Order.find({
        paymentStatus: "pending",
        $or: [
          { "paymentMethodSnapshot.requiresProof": false },
          {
            $and: [
              { $or: [
                { "paymentMethodSnapshot.requiresProof": true },
                { paymentMethod: { $in: ["cbe", "telebirr"] }, "paymentMethodSnapshot.requiresProof": { $exists: false } },
              ] },
              { $or: [
                { "paymentProof.storageKey": { $exists: true, $ne: null } },
                { "paymentProof.imageUrl": { $exists: true, $ne: null } },
              ] },
            ],
          },
        ],
      })
        .populate("userID", "id name")
        .sort({ _id: -1 });

      res.json({
        success: true,
        message: "Orders pending payment verification retrieved successfully.",
        data: orders,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Delete an order
router.delete(
  "/:id",
  requireAdminAuth,
  requireCapability("orders.delete"),
  asyncHandler(async (req, res) => {
    try {
      const orderID = req.params.id;
      const existing = await Order.findById(orderID);
      if (existing?.paymentProof?.storageKey || existing?.paymentProof?.imageUrl) {
        return res.status(409).json({ success: false, message: "Orders with payment evidence cannot be deleted. Cancel or close the order to preserve its audit history." });
      }
      const deletedOrder = await Order.findByIdAndDelete(orderID);
      if (!deletedOrder) {
        return res
          .status(404)
          .json({ success: false, message: "Order not found." });
      }
      res.json({ success: true, message: "Order deleted successfully." });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

module.exports = router;
