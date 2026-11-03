const crypto = require("node:crypto");
const express = require("express");
const asyncHandler = require("express-async-handler");
const StoreSettings = require("../model/storeSettings");
const Order = require("../model/order");
const { requireAdminAuth, requireSuperAdmin } = require("../middleware/adminAccess");
const { normalizePaymentMethod, paymentMethodSnapshot, toCustomerPaymentMethod } = require("../utils/paymentMethods");

const router = express.Router();
const superAdminOnly = [requireAdminAuth, requireSuperAdmin];
const defaultSettings = {
  key: "storefront",
  supportPhone: "",
  supportTelegram: "",
  supportInstagram: "",
  deliveryFee: 0,
  paymentMethods: [],
};

function normalizeSupportInstagram(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") return null;
  const username = value.trim().replace(/^@/, "");
  return username.length <= 30 && /^[A-Za-z0-9._]{1,30}$/.test(username) ? username : null;
}

function adminPaymentMethod(method) {
  const snapshot = paymentMethodSnapshot(method);
  if (!snapshot) return null;
  return {
    ...snapshot,
    title: snapshot.name,
    subtitle: snapshot.description,
    enabled: method.enabled === true,
    displayOrder: Number.isInteger(method.displayOrder) ? method.displayOrder : 0,
  };
}

async function findOrCreateSettingsForAdminMutation() {
  let settings = await StoreSettings.findOne({ key: "storefront" });
  if (!settings) {
    settings = await StoreSettings.findOneAndUpdate(
      { key: "storefront" },
      { $setOnInsert: defaultSettings },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
  }
  return settings;
}

// Read-only customer checkout configuration. It exposes active payment
// instructions/details only and never creates a settings document.
router.get("/checkout", asyncHandler(async (_req, res) => {
  const settings = await StoreSettings.findOne({ key: "storefront" }).lean();
  const methods = (settings?.paymentMethods || [])
    .filter((method) => method.enabled === true)
    .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0) || String(a.code).localeCompare(String(b.code)))
    .map(toCustomerPaymentMethod)
    .filter(Boolean);
  res.set("Cache-Control", "no-store");
  return res.json({
    success: true,
    message: "Checkout settings retrieved successfully.",
    data: { deliveryFee: 0, paymentMethods: methods },
  });
}));

// Active administrators can manage the payment configuration. This endpoint
// is a pure read and is limited to the super-admin role used for store settings.
router.get("/payment-methods", ...superAdminOnly, asyncHandler(async (_req, res) => {
  const settings = await StoreSettings.findOne({ key: "storefront" }).lean();
  const methods = (settings?.paymentMethods || [])
    .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0) || String(a.code).localeCompare(String(b.code)))
    .map(adminPaymentMethod)
    .filter(Boolean);
  res.set("Cache-Control", "no-store");
  return res.json({ success: true, message: "Payment methods retrieved successfully.", data: methods });
}));

router.post("/payment-methods", ...superAdminOnly, asyncHandler(async (req, res) => {
  const code = `pm_${crypto.randomUUID().replace(/-/g, "")}`;
  const parsed = normalizePaymentMethod(req.body, { code });
  if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
  const settings = await findOrCreateSettingsForAdminMutation();
  if (settings.paymentMethods.some((method) => method.code === code)) {
    return res.status(503).json({ success: false, message: "Could not allocate a unique payment method identifier." });
  }
  settings.paymentMethods.push(parsed.value);
  await settings.save();
  const created = settings.paymentMethods.find((method) => method.code === code);
  return res.status(201).json({ success: true, message: "Payment method created successfully.", data: adminPaymentMethod(created) });
}));

router.put("/payment-methods/:code", ...superAdminOnly, asyncHandler(async (req, res) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,79}$/.test(req.params.code)) {
    return res.status(400).json({ success: false, message: "A valid payment method identifier is required." });
  }
  const parsed = normalizePaymentMethod(req.body, { code: req.params.code });
  if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
  const settings = await StoreSettings.findOne({ key: "storefront" });
  if (!settings) return res.status(404).json({ success: false, message: "Payment method not found." });
  const existing = settings.paymentMethods.find((method) => method.code === req.params.code);
  if (!existing) return res.status(404).json({ success: false, message: "Payment method not found." });
  existing.set(parsed.value);
  await settings.save();
  return res.json({ success: true, message: "Payment method updated successfully.", data: adminPaymentMethod(existing) });
}));

router.delete("/payment-methods/:code", ...superAdminOnly, asyncHandler(async (req, res) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,79}$/.test(req.params.code)) {
    return res.status(400).json({ success: false, message: "A valid payment method identifier is required." });
  }
  const legacyOrder = await Order.exists({
    paymentMethod: req.params.code,
    $or: [
      { paymentMethodSnapshot: { $exists: false } },
      { paymentMethodSnapshot: null },
    ],
  });
  if (legacyOrder) {
    return res.status(409).json({ success: false, message: "This method is referenced by a historical order without a saved payment snapshot and cannot be deleted safely." });
  }
  const settings = await StoreSettings.findOne({ key: "storefront" });
  if (!settings) return res.status(404).json({ success: false, message: "Payment method not found." });
  const index = settings.paymentMethods.findIndex((method) => method.code === req.params.code);
  if (index < 0) return res.status(404).json({ success: false, message: "Payment method not found." });
  settings.paymentMethods.splice(index, 1);
  await settings.save();
  return res.json({ success: true, message: "Payment method deleted successfully." });
}));

// Retain the existing settings API for older admin clients. Payment method
// codes are no longer restricted to a provider allowlist; new methods should
// use the individual management endpoints above so codes remain stable.
router.get("/", ...superAdminOnly, asyncHandler(async (_req, res) => {
  const settings = await StoreSettings.findOne({ key: "storefront" }).lean();
  return res.json({ success: true, message: "Store settings retrieved successfully.", data: settings || { ...defaultSettings } });
}));

router.put("/", ...superAdminOnly, asyncHandler(async (req, res) => {
  const { supportPhone, supportTelegram, deliveryFee } = req.body;
  if (req.body.paymentMethods !== undefined) {
    return res.status(400).json({ success: false, message: "Manage payment methods through the payment-methods endpoints." });
  }
  if (deliveryFee !== undefined && (!Number.isFinite(Number(deliveryFee)) || Number(deliveryFee) < 0 || Number(deliveryFee) > 1000000)) {
    return res.status(400).json({ success: false, message: "A valid delivery fee is required." });
  }
  const supportInstagram = req.body.supportInstagram === undefined
    ? undefined
    : normalizeSupportInstagram(req.body.supportInstagram);
  if (supportInstagram === null || (supportPhone !== undefined && typeof supportPhone !== "string") || (supportTelegram !== undefined && typeof supportTelegram !== "string")) {
    return res.status(400).json({ success: false, message: "Instagram must be a username without @ or a URL." });
  }

  const setFields = {};
  if (deliveryFee !== undefined) setFields.deliveryFee = Number(deliveryFee);
  if (supportPhone !== undefined) setFields.supportPhone = supportPhone.trim();
  if (supportTelegram !== undefined) setFields.supportTelegram = supportTelegram.trim().replace(/^@/, "");
  if (supportInstagram !== undefined) setFields.supportInstagram = supportInstagram;
  const settings = await StoreSettings.findOneAndUpdate(
    { key: "storefront" },
    { $set: setFields, $setOnInsert: { key: "storefront" } },
    { new: true, upsert: true, runValidators: true },
  );
  return res.json({ success: true, message: "Store settings updated successfully.", data: settings });
}));

module.exports = router;
module.exports.normalizeSupportInstagram = normalizeSupportInstagram;
