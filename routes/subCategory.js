const express = require("express");
const sendRouteError = require("../utils/sendRouteError");
const router = express.Router();
const SubCategory = require("../model/subCategory");
const Brand = require("../model/brand");
const Product = require("../model/product");
const asyncHandler = require("express-async-handler");
const {
  buildOwnedQuery,
  canAccessOwnedDocument,
  loadAdmin,
  requireAdminAuth,
} = require("../middleware/adminAccess");

// Get all sub-categories
router.get(
  "/",
  loadAdmin,
  asyncHandler(async (req, res) => {
    try {
      const subCategories = await SubCategory.find(buildOwnedQuery(req, {}))
        .populate("categoryId")
        .sort({ _id: -1 });

      res.json({
        success: true,
        message: "Sub-categories retrieved successfully.",
        data: subCategories,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Get a sub-category by ID
router.get(
  "/:id",
  loadAdmin,
  asyncHandler(async (req, res) => {
    try {
      const subCategoryID = req.params.id;
      const subCategory =
        await SubCategory.findById(subCategoryID).populate("categoryId");

      if (!subCategory) {
        return res
          .status(404)
          .json({ success: false, message: "Sub-category not found." });
      }
      if (!canAccessOwnedDocument(req, subCategory)) {
        return res.status(403).json({
          success: false,
          message: "You can only access sub-categories you created.",
        });
      }
      res.json({
        success: true,
        message: "Sub-category retrieved successfully.",
        data: subCategory,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Create a new sub-category
router.post(
  "/",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const { name, categoryId } = req.body;

    if (!name || !categoryId) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Name and category ID are required.",
        });
    }

    try {
      const subCategory = new SubCategory({
        name,
        categoryId,
        createdBy: req.adminUser._id,
      });
      const newSubCategory = await subCategory.save();
      res.json({
        success: true,
        message: "Sub-category created successfully.",
        data: newSubCategory,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Update a sub-category
router.put(
  "/:id",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const subCategoryID = req.params.id;
    const { name, categoryId } = req.body;

    if (!name || !categoryId) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Name and category ID are required.",
        });
    }

    try {
      const subCategory = await SubCategory.findById(subCategoryID);
      if (!subCategory) {
        return res
          .status(404)
          .json({ success: false, message: "Sub-category not found." });
      }
      if (!canAccessOwnedDocument(req, subCategory)) {
        return res.status(403).json({
          success: false,
          message: "You can only edit sub-categories you created.",
        });
      }

      const updatedSubCategory = await SubCategory.findByIdAndUpdate(
        subCategoryID,
        {
          name,
          categoryId,
          createdBy: subCategory.createdBy || req.adminUser._id,
        },
        { new: true },
      );

      res.json({
        success: true,
        message: "Sub-category updated successfully.",
        data: updatedSubCategory,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Delete a sub-category
router.delete(
  "/:id",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const subCategoryID = req.params.id;

    try {
      const subCategory = await SubCategory.findById(subCategoryID);
      if (!subCategory) {
        return res
          .status(404)
          .json({ success: false, message: "Sub-category not found." });
      }
      if (!canAccessOwnedDocument(req, subCategory)) {
        return res.status(403).json({
          success: false,
          message: "You can only delete sub-categories you created.",
        });
      }

      // Check if any brand is associated with the sub-category
      const brandCount = await Brand.countDocuments({
        subcategoryId: subCategoryID,
      });
      if (brandCount > 0) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Cannot delete sub-category. It is associated with one or more brands.",
          });
      }

      // Check if any products reference this sub-category
      const products = await Product.find({ proSubCategoryId: subCategoryID });
      if (products.length > 0) {
        return res
          .status(400)
          .json({
            success: false,
            message: "Cannot delete sub-category. Products are referencing it.",
          });
      }

      await SubCategory.findByIdAndDelete(subCategoryID);
      res.json({
        success: true,
        message: "Sub-category deleted successfully.",
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

module.exports = router;
