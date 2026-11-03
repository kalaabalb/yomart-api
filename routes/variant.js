const express = require("express");
const sendRouteError = require("../utils/sendRouteError");
const router = express.Router();
const Variant = require("../model/variant");
const Product = require("../model/product");
const asyncHandler = require("express-async-handler");
const {
  buildOwnedQuery,
  canAccessOwnedDocument,
  loadAdmin,
  requireAdminAuth,
} = require("../middleware/adminAccess");

// Get all variants
router.get(
  "/",
  loadAdmin,
  asyncHandler(async (req, res) => {
    try {
      const variants = await Variant.find(buildOwnedQuery(req, {}))
        .populate("variantTypeId")
        .sort({ _id: -1 });

      res.json({
        success: true,
        message: "Variants retrieved successfully.",
        data: variants,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Get a variant by ID
router.get(
  "/:id",
  loadAdmin,
  asyncHandler(async (req, res) => {
    try {
      const variantID = req.params.id;
      const variant =
        await Variant.findById(variantID).populate("variantTypeId");

      if (!variant) {
        return res
          .status(404)
          .json({ success: false, message: "Variant not found." });
      }
      if (!canAccessOwnedDocument(req, variant)) {
        return res.status(403).json({
          success: false,
          message: "You can only access variants you created.",
        });
      }
      res.json({
        success: true,
        message: "Variant retrieved successfully.",
        data: variant,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Create a new variant
router.post(
  "/",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const { name, variantTypeId } = req.body;

    if (!name || !variantTypeId) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Name and VariantType ID are required.",
        });
    }

    try {
      const variant = new Variant({
        name,
        variantTypeId,
        createdBy: req.adminUser._id,
      });
      const newVariant = await variant.save();
      res.json({
        success: true,
        message: "Variant created successfully.",
        data: newVariant,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Update a variant
router.put(
  "/:id",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const variantID = req.params.id;
    const { name, variantTypeId } = req.body;

    if (!name || !variantTypeId) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Name and VariantType ID are required.",
        });
    }

    try {
      const variant = await Variant.findById(variantID);
      if (!variant) {
        return res
          .status(404)
          .json({ success: false, message: "Variant not found." });
      }
      if (!canAccessOwnedDocument(req, variant)) {
        return res.status(403).json({
          success: false,
          message: "You can only edit variants you created.",
        });
      }

      const updatedVariant = await Variant.findByIdAndUpdate(
        variantID,
        {
          name,
          variantTypeId,
          createdBy: variant.createdBy || req.adminUser._id,
        },
        { new: true },
      );

      res.json({
        success: true,
        message: "Variant updated successfully.",
        data: updatedVariant,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Delete a variant
router.delete(
  "/:id",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const variantID = req.params.id;

    try {
      const variant = await Variant.findById(variantID);
      if (!variant) {
        return res
          .status(404)
          .json({ success: false, message: "Variant not found." });
      }
      if (!canAccessOwnedDocument(req, variant)) {
        return res.status(403).json({
          success: false,
          message: "You can only delete variants you created.",
        });
      }

      // Check if any products reference this variant
      const products = await Product.find({ proVariantId: variantID });
      if (products.length > 0) {
        return res
          .status(400)
          .json({
            success: false,
            message: "Cannot delete variant. Products are referencing it.",
          });
      }

      await Variant.findByIdAndDelete(variantID);
      res.json({ success: true, message: "Variant deleted successfully." });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

module.exports = router;
