const express = require("express");
const asyncHandler = require("express-async-handler");
const RetailerContact = require("../model/retailerContact");
const { requireAdminAuth, requireCapability } = require("../middleware/adminAccess");
const { normalizeAndValidateContact, toPublicContact } = require("../utils/retailerContact");

const router = express.Router();
const manageContacts = [requireAdminAuth, requireCapability("contacts.manage")];

// Customer endpoint is a pure read: it neither creates defaults nor updates settings.
router.get("/", asyncHandler(async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const contacts = await RetailerContact.find({ isActive: true })
    .select("label description type value placement displayOrder -_id")
    .sort({ displayOrder: 1, _id: 1 })
    .lean();
  return res.json({ success: true, message: "Retailer contacts retrieved successfully.", data: contacts.map(toPublicContact).filter(Boolean) });
}));

router.get("/admin", ...manageContacts, asyncHandler(async (_req, res) => {
  const contacts = await RetailerContact.find({}).sort({ displayOrder: 1, _id: 1 }).lean();
  return res.json({ success: true, message: "Retailer contacts retrieved successfully.", data: contacts });
}));

router.post("/", ...manageContacts, asyncHandler(async (req, res) => {
  const parsed = normalizeAndValidateContact(req.body);
  if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
  const contact = await RetailerContact.create(parsed.value);
  return res.status(201).json({ success: true, message: "Retailer contact created successfully.", data: contact });
}));

router.put("/:id", ...manageContacts, asyncHandler(async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(400).json({ success: false, message: "A valid contact ID is required." });
  const parsed = normalizeAndValidateContact(req.body);
  if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
  const contact = await RetailerContact.findByIdAndUpdate(req.params.id, { $set: parsed.value }, { new: true, runValidators: true });
  if (!contact) return res.status(404).json({ success: false, message: "Retailer contact not found." });
  return res.json({ success: true, message: "Retailer contact updated successfully.", data: contact });
}));

router.delete("/:id", ...manageContacts, asyncHandler(async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(400).json({ success: false, message: "A valid contact ID is required." });
  const contact = await RetailerContact.findByIdAndDelete(req.params.id);
  if (!contact) return res.status(404).json({ success: false, message: "Retailer contact not found." });
  return res.json({ success: true, message: "Retailer contact deleted successfully." });
}));

module.exports = router;
