const express = require("express");
const mongoose = require("mongoose");
const asyncHandler = require("express-async-handler");
const Collection = require("../model/collection");
const Product = require("../model/product");
const {
  buildOwnedQuery,
  canAccessOwnedDocument,
  loadAdmin,
  requireAdminAuth,
} = require("../middleware/adminAccess");

const router = express.Router();

function validatePayload(body, partial = false) {
  const errors = [];
  if (!partial || body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim()) {
      errors.push("A collection title is required.");
    }
  }
  if (!partial || body.subtitle !== undefined) {
    if (typeof body.subtitle !== "string" || !body.subtitle.trim()) {
      errors.push("A collection subtitle is required.");
    }
  }
  if (body.productIds !== undefined) {
    if (
      !Array.isArray(body.productIds) ||
      body.productIds.some((id) => !mongoose.isValidObjectId(id))
    ) {
      errors.push("Product IDs must be a list of valid IDs.");
    }
  }
  if (
    body.sortOrder !== undefined &&
    (!Number.isInteger(Number(body.sortOrder)) || Number(body.sortOrder) < 0)
  ) {
    errors.push("Sort order must be a non-negative integer.");
  }
  if (body.isActive !== undefined && typeof body.isActive !== "boolean") {
    errors.push("Active status must be true or false.");
  }
  return errors;
}

router.get("/", loadAdmin, asyncHandler(async (req, res) => {
  const query = req.adminUser
    ? buildOwnedQuery(req, {})
    : { isActive: true };
  const collections = await Collection.find(query)
    .sort({ sortOrder: 1, createdAt: 1 })
    .lean();
  return res.json({ success: true, message: "Collections retrieved successfully.", data: collections });
}));

router.get("/:id", loadAdmin, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid collection ID." });
  }
  const collection = await Collection.findById(req.params.id);
  if (!collection || (!req.adminUser && !collection.isActive)) {
    return res.status(404).json({ success: false, message: "Collection not found." });
  }
  if (req.adminUser && !canAccessOwnedDocument(req, collection)) {
    return res.status(403).json({ success: false, message: "You cannot access this collection." });
  }
  return res.json({ success: true, message: "Collection retrieved successfully.", data: collection });
}));

router.post("/", requireAdminAuth, asyncHandler(async (req, res) => {
  const errors = validatePayload(req.body);
  if (errors.length) return res.status(400).json({ success: false, message: errors.join(" ") });
  const productIds = [...new Set((req.body.productIds || []).map(String))];
  if (
    productIds.length &&
    (await Product.countDocuments({ _id: { $in: productIds } })) !==
      productIds.length
  ) {
    return res.status(400).json({
      success: false,
      message: "One or more selected products do not exist.",
    });
  }
  const collection = await Collection.create({
    title: req.body.title.trim(),
    subtitle: req.body.subtitle.trim(),
    productIds,
    sortOrder: Number(req.body.sortOrder || 0),
    isActive: req.body.isActive ?? true,
    createdBy: req.adminUser._id,
  });
  return res.status(201).json({
    success: true,
    message: "Collection created successfully.",
    data: collection,
  });
}));

router.put("/:id", requireAdminAuth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid collection ID." });
  }
  const errors = validatePayload(req.body, true);
  if (errors.length) return res.status(400).json({ success: false, message: errors.join(" ") });
  const collection = await Collection.findById(req.params.id);
  if (!collection) {
    return res.status(404).json({
      success: false,
      message: "Collection not found.",
    });
  }
  if (!canAccessOwnedDocument(req, collection)) {
    return res.status(403).json({ success: false, message: "You cannot edit this collection." });
  }
  if (req.body.productIds) {
    const uniqueIds = [...new Set(req.body.productIds.map(String))];
    if (await Product.countDocuments({ _id: { $in: uniqueIds } }) !== uniqueIds.length) {
        return res.status(400).json({
        success: false,
        message: "One or more selected products do not exist.",
      });
    }
  }
  for (const key of ["title", "subtitle", "productIds", "sortOrder", "isActive"]) {
    if (req.body[key] !== undefined) collection[key] = req.body[key];
  }
  await collection.save();
  return res.json({
    success: true,
    message: "Collection updated successfully.",
    data: collection,
  });
}));

router.delete("/:id", requireAdminAuth, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid collection ID." });
  }
  const collection = await Collection.findById(req.params.id);
  if (!collection) {
    return res.status(404).json({
      success: false,
      message: "Collection not found.",
    });
  }
  if (!canAccessOwnedDocument(req, collection)) {
    return res.status(403).json({ success: false, message: "You cannot delete this collection." });
  }
  await collection.deleteOne();
  return res.json({
    success: true,
    message: "Collection deleted successfully.",
  });
}));

module.exports = router;
