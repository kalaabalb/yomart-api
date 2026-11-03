const mongoose = require("mongoose");

const paymentMethodSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      trim: true,
      maxlength: 80,
      match: /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,79}$/,
      required: true,
    },
    // title/subtitle remain for clients and settings records created before
    // payment methods became fully configurable.
    title: { type: String, required: true, trim: true, maxlength: 80 },
    subtitle: { type: String, trim: true, maxlength: 240, default: "" },
    name: { type: String, trim: true, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 240, default: "" },
    category: { type: String, enum: ["cash_collection", "bank_transfer", "mobile_wallet", "other"] },
    logoUrl: { type: String, trim: true, maxlength: 500 },
    providerName: { type: String, trim: true, maxlength: 100 },
    accountHolder: { type: String, trim: true, maxlength: 120 },
    accountIdentifier: { type: String, trim: true, maxlength: 160 },
    additionalDetails: { type: String, trim: true, maxlength: 500 },
    enabled: { type: Boolean, default: false },
    instructions: { type: String, trim: true, maxlength: 500, default: "" },
    // Omitted only on legacy records; consumers infer the old behavior from
    // their historical code (cod versus cbe/telebirr).
    requiresProof: { type: Boolean },
    displayOrder: { type: Number, min: 0, max: 100000, default: 0 },
  },
  { _id: false },
);

const storeSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, default: "storefront" },
    supportPhone: { type: String, trim: true, maxlength: 40, default: "" },
    supportTelegram: { type: String, trim: true, maxlength: 80, default: "" },
    supportInstagram: { type: String, trim: true, maxlength: 30, default: "" },
    deliveryFee: { type: Number, min: 0, default: 0 },
    paymentMethods: {
      type: [paymentMethodSchema],
      default: [],
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("StoreSettings", storeSettingsSchema);
