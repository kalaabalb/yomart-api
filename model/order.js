const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema(
  {
    userID: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    orderDate: {
      type: Date,
      default: Date.now,
    },
    orderStatus: {
      type: String,
      enum: [
        "pending",
        "processing",
        "shipped",
        "delivered",
        "cancelled",
        "payment_pending",
        "payment_verified",
        "ready_for_collection",
        "collected",
      ],
      default: "pending",
    },
    items: [
      {
        productID: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Product",
          required: true,
        },
        productName: {
          type: String,
          required: true,
        },
        quantity: {
          type: Number,
          required: true,
          min: 1,
        },
        price: {
          type: Number,
          required: true,
          min: 0,
        },
        variant: {
          type: String,
        },
      },
    ],
    // Additive reservation evidence for orders created after this feature.
    // Historical orders without this marker are intentionally left unknown.
    inventoryReservation: {
      state: {
        type: String,
        enum: ["reserved", "released", "consumed"],
      },
      items: [{
        productID: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
        quantity: { type: Number, required: true, min: 1 },
      }],
      reservedAt: Date,
      releasedAt: Date,
      releaseReason: { type: String, enum: ["cancelled", "payment_rejected"] },
      consumedAt: Date,
    },
    totalPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    shippingAddress: {
      phone: String,
      street: String,
      city: String,
      state: String,
      postalCode: String,
      country: String,
      latitude: Number,
      longitude: Number,
    },
    // Staff-coordinated collection details; distinct from the customer's destination.
    collectionPoint: {
      name: { type: String, trim: true, maxlength: 120 },
      address: { type: String, trim: true, maxlength: 240 },
      city: { type: String, trim: true, maxlength: 100 },
      agreedAt: Date,
    },
    paymentMethod: {
      type: String,
      trim: true,
      maxlength: 80,
      match: /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,79}$/,
      required: true,
    },
    // Captures the customer-facing payment details selected at order time.
    // Optional so existing orders retain their original schema and values.
    paymentMethodSnapshot: {
      type: new mongoose.Schema({
        code: String,
        name: String,
        description: String,
        category: String,
        logoUrl: String,
        providerName: String,
        accountHolder: String,
        accountIdentifier: String,
        additionalDetails: String,
        instructions: String,
        requiresProof: Boolean,
      }, { _id: false }),
      immutable: true,
    },
    paymentStatus: {
      type: String,
      enum: ["pending", "verified", "failed"],
      default: "pending",
    },
    paymentProof: {
      storageKey: String,
      proofRecordId: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentProof" },
      imageUrl: String,
      uploadedAt: Date,
      verified: Boolean,
      verifiedAt: Date,
    },
    orderTotal: {
      subtotal: Number,
      delivery: { type: Number, min: 0 },
      total: Number,
    },
    trackingUrl: {
      type: String,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        if (ret.paymentProof) {
          ret.paymentProof.available = Boolean(ret.paymentProof.storageKey || ret.paymentProof.imageUrl);
          delete ret.paymentProof.storageKey;
          delete ret.paymentProof.imageUrl;
          delete ret.paymentProof.proofRecordId;
        }
        return ret;
      },
    },
  },
);

const Order = mongoose.model("Order", orderSchema);

module.exports = Order;
