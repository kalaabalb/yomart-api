const mongoose = require("mongoose");

const retailerContactSchema = new mongoose.Schema({
  label: { type: String, required: true, trim: true, maxlength: 80 },
  description: { type: String, trim: true, maxlength: 240, default: "" },
  type: { type: String, required: true, enum: ["phone", "telegram", "whatsapp", "email", "website", "other"] },
  value: { type: String, required: true, trim: true, maxlength: 500 },
  placement: { type: String, required: true, enum: ["product_details", "support_page", "storefront_footer", "all"], default: "all" },
  displayOrder: { type: Number, min: 0, max: 100000, default: 0 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

retailerContactSchema.index({ isActive: 1, displayOrder: 1, _id: 1 });

module.exports = mongoose.model("RetailerContact", retailerContactSchema);
