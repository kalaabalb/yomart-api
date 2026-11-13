const express = require("express");
const asyncHandler = require("express-async-handler");
const SupportContent = require("../model/supportContent");
const { requireAdminAuth, requireCapability } = require("../middleware/adminAccess");
const { parseSupportContent, publicSupportContent } = require("../utils/supportContent");

const router = express.Router();
const manageSupport = [requireAdminAuth, requireCapability("contacts.manage")];

router.get("/", asyncHandler(async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const items = await SupportContent.find({ isActive: true })
    .select("title body sortOrder -_id")
    .sort({ sortOrder: 1, _id: 1 })
    .lean();
  return res.json({ success: true, message: "Support information retrieved successfully.", data: items.map(publicSupportContent) });
}));

router.get("/admin", ...manageSupport, asyncHandler(async (_req, res) => {
  const items = await SupportContent.find({}).sort({ sortOrder: 1, _id: 1 }).lean();
  return res.json({ success: true, message: "Support information retrieved successfully.", data: items });
}));

router.post("/", ...manageSupport, asyncHandler(async (req, res) => {
  const parsed = parseSupportContent(req.body);
  if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
  const item = await SupportContent.create(parsed.value);
  return res.status(201).json({ success: true, message: "Support information created successfully.", data: item });
}));

router.put("/:id", ...manageSupport, asyncHandler(async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(400).json({ success: false, message: "A valid support content ID is required." });
  const parsed = parseSupportContent(req.body);
  if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
  const item = await SupportContent.findByIdAndUpdate(req.params.id, { $set: parsed.value }, { new: true, runValidators: true });
  if (!item) return res.status(404).json({ success: false, message: "Support content not found." });
  return res.json({ success: true, message: "Support information updated successfully.", data: item });
}));

router.delete("/:id", ...manageSupport, asyncHandler(async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(400).json({ success: false, message: "A valid support content ID is required." });
  const item = await SupportContent.findByIdAndDelete(req.params.id);
  if (!item) return res.status(404).json({ success: false, message: "Support content not found." });
  return res.json({ success: true, message: "Support information deleted successfully." });
}));

module.exports = router;
