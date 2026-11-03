const express = require("express");
const sendRouteError = require("../utils/sendRouteError");
const router = express.Router();
const VariantType = require("../model/variantType");
const Product = require("../model/product");
const Variant = require("../model/variant");
const asyncHandler = require("express-async-handler");
const {
  buildOwnedQuery,
  canAccessOwnedDocument,
  loadAdmin,
  requireAdminAuth,
} = require("../middleware/adminAccess");

// Get all variant types
router.get(
  "/",
  loadAdmin,
  asyncHandler(async (req, res) => {
    try {
      const variantTypes = await VariantType.find(buildOwnedQuery(req, {})).sort({
        _id: -1,
      });

      res.json({
        success: true,
        message: "VariantTypes retrieved successfully.",
        data: variantTypes,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Get a variant type by ID
router.get(
  "/:id",
  loadAdmin,
  asyncHandler(async (req, res) => {
    try {
      const variantTypeID = req.params.id;
      const variantType = await VariantType.findById(variantTypeID);

      if (!variantType) {
        return res
          .status(404)
          .json({ success: false, message: "VariantType not found." });
      }
      if (!canAccessOwnedDocument(req, variantType)) {
        return res.status(403).json({
          success: false,
          message: "You can only access variant types you created.",
        });
      }
      res.json({
        success: true,
        message: "VariantType retrieved successfully.",
        data: variantType,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Create a new variant type
router.post(
  "/",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const { name, type } = req.body;

    if (!name) {
      return res
        .status(400)
        .json({ success: false, message: "Name is required." });
    }

    try {
      const variantType = new VariantType({
        name,
        type,
        createdBy: req.adminUser._id,
      });
      const newVariantType = await variantType.save();
      res.json({
        success: true,
        message: "VariantType created successfully.",
        data: newVariantType,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Update a variant type
router.put(
  "/:id",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const variantTypeID = req.params.id;
    const { name, type } = req.body;

    if (!name) {
      return res
        .status(400)
        .json({ success: false, message: "Name is required." });
    }

    try {
      const variantType = await VariantType.findById(variantTypeID);
      if (!variantType) {
        return res
          .status(404)
          .json({ success: false, message: "VariantType not found." });
      }
      if (!canAccessOwnedDocument(req, variantType)) {
        return res.status(403).json({
          success: false,
          message: "You can only edit variant types you created.",
        });
      }

      const updatedVariantType = await VariantType.findByIdAndUpdate(
        variantTypeID,
        {
          name,
          type,
          createdBy: variantType.createdBy || req.adminUser._id,
        },
        { new: true },
      );

      res.json({
        success: true,
        message: "VariantType updated successfully.",
        data: updatedVariantType,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Delete a variant type
router.delete(
  "/:id",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const variantTypeID = req.params.id;

    try {
      const variantType = await VariantType.findById(variantTypeID);
      if (!variantType) {
        return res
          .status(404)
          .json({ success: false, message: "Variant type not found." });
      }
      if (!canAccessOwnedDocument(req, variantType)) {
        return res.status(403).json({
          success: false,
          message: "You can only delete variant types you created.",
        });
      }

      // Check if any variant is associated with this variant type
      const variantCount = await Variant.countDocuments({
        variantTypeId: variantTypeID,
      });
      if (variantCount > 0) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Cannot delete variant type. It is associated with one or more variants.",
          });
      }

      // Check if any products reference this variant type
      const products = await Product.find({ proVariantTypeId: variantTypeID });
      if (products.length > 0) {
        return res
          .status(400)
          .json({
            success: false,
            message: "Cannot delete variant type. Products are referencing it.",
          });
      }

      await VariantType.findByIdAndDelete(variantTypeID);
      res.json({
        success: true,
        message: "Variant type deleted successfully.",
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

module.exports = router;
