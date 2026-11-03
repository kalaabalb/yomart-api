const express = require("express");
const sendRouteError = require("../utils/sendRouteError");
const router = express.Router();
const Category = require("../model/category");
const SubCategory = require("../model/subCategory");
const Product = require("../model/product");
const { uploadCategory, uploadLimiter, deleteUploadedImage } = require("../uploadFile");
const asyncHandler = require("express-async-handler");
const {
  buildOwnedQuery,
  canAccessOwnedDocument,
  loadAdmin,
  requireAdminAuth,
} = require("../middleware/adminAccess");

const parseBoolean = (value) => {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
};

// Get all categories
router.get(
  "/",
  loadAdmin,
  asyncHandler(async (req, res) => {
    try {
      const query = req.adminUser
        ? buildOwnedQuery(req, {})
        : { isActive: { $ne: false } };
      const categories = await Category.find(query).sort({ sortOrder: 1, name: 1 });
      res.json({
        success: true,
        message: "Categories retrieved successfully.",
        data: categories,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Get a category by ID
router.get(
  "/:id",
  loadAdmin,
  asyncHandler(async (req, res) => {
    try {
      const categoryID = req.params.id;
      const category = await Category.findById(categoryID);

      if (!category) {
        return res
          .status(404)
          .json({ success: false, message: "Category not found." });
      }

      if (!req.adminUser && category.isActive === false) {
        return res.status(404).json({ success: false, message: "Category not found." });
      }

      if (!canAccessOwnedDocument(req, category)) {
        return res.status(403).json({
          success: false,
          message: "You can only access categories you created.",
        });
      }

      res.json({
        success: true,
        message: "Category retrieved successfully.",
        data: category,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Create a new category
router.post(
  "/",
  requireAdminAuth,
  uploadLimiter,
  asyncHandler(async (req, res) => {
    try {
      uploadCategory.single("img")(req, res, async function (err) {
        if (err) return sendRouteError(res, err);

        const body = req.body || {};
        const { name } = body;
        const sortOrder = Number(body.sortOrder ?? 0);
        const isActive = body.isActive === undefined ? true : parseBoolean(body.isActive);
        let imageUrl = "";

        if (req.file) {
          imageUrl = req.file.path;
        }

        if (typeof name !== "string" || !name.trim() || name.trim().length > 80) {
          return res
            .status(400)
            .json({ success: false, message: "Name is required." });
        }
        if (!Number.isInteger(sortOrder) || sortOrder < 0 || isActive === null) {
          return res.status(400).json({ success: false, message: "Sort order or visibility is invalid." });
        }

        if (!imageUrl) {
          return res
            .status(400)
            .json({ success: false, message: "Image is required." });
        }

        try {
          const newCategory = new Category({
            name: name.trim(),
            image: imageUrl,
            sortOrder,
            isActive,
            createdBy: req.adminUser._id,
          });

          await newCategory.save();
          res.json({
            success: true,
            message: "Category created successfully.",
            data: newCategory,
          });
        } catch (error) {
          sendRouteError(res, error);
        }
      });
    } catch (err) {
      return sendRouteError(res, err);
    }
  }),
);

// Update a category
router.put(
  "/:id",
  requireAdminAuth,
  uploadLimiter,
  asyncHandler(async (req, res) => {
    try {
      const categoryID = req.params.id;
      uploadCategory.single("img")(req, res, async function (err) {
        if (err) return sendRouteError(res, err);

        const body = req.body || {};
        const { name } = body;
        let image = body.image;

        if (req.file) {
          image = req.file.path;
        }

        if (typeof name !== "string" || !name.trim() || name.trim().length > 80 || !image) {
          return res
            .status(400)
            .json({ success: false, message: "Name and image are required." });
        }

        try {
          const category = await Category.findById(categoryID);
          if (!category) {
            return res
              .status(404)
              .json({ success: false, message: "Category not found." });
          }

          if (!canAccessOwnedDocument(req, category)) {
            return res.status(403).json({
              success: false,
              message: "You can only edit categories you created.",
            });
          }

          const sortOrder = body.sortOrder === undefined
            ? category.sortOrder
            : Number(body.sortOrder);
          const isActive = body.isActive === undefined
            ? category.isActive
            : parseBoolean(body.isActive);
          if (!Number.isInteger(sortOrder) || sortOrder < 0 || isActive === null) {
            return res.status(400).json({ success: false, message: "Sort order or visibility is invalid." });
          }

          const updatedCategory = await Category.findByIdAndUpdate(
            categoryID,
            {
              name: name.trim(),
              image: image,
              sortOrder,
              isActive,
              createdBy: category.createdBy || req.adminUser._id,
            },
            { new: true, runValidators: true },
          );
          if (category.image !== image) await deleteUploadedImage(category.image);

          res.json({
            success: true,
            message: "Category updated successfully.",
            data: updatedCategory,
          });
        } catch (error) {
          sendRouteError(res, error);
        }
      });
    } catch (err) {
      return sendRouteError(res, err);
    }
  }),
);

// Delete a category
router.delete(
  "/:id",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    try {
      const categoryID = req.params.id;

      const category = await Category.findById(categoryID);
      if (!category) {
        return res
          .status(404)
          .json({ success: false, message: "Category not found." });
      }

      if (!canAccessOwnedDocument(req, category)) {
        return res.status(403).json({
          success: false,
          message: "You can only delete categories you created.",
        });
      }

      // Check if any subcategories reference this category
      const subcategories = await SubCategory.find({ categoryId: categoryID });
      if (subcategories.length > 0) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Cannot delete category. Subcategories are referencing it.",
          });
      }

      // Check if any products reference this category
      const products = await Product.find({ proCategoryId: categoryID });
      if (products.length > 0) {
        return res
          .status(400)
          .json({
            success: false,
            message: "Cannot delete category. Products are referencing it.",
          });
      }

      await Category.findByIdAndDelete(categoryID);
      await deleteUploadedImage(category.image);
      res.json({ success: true, message: "Category deleted successfully." });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

module.exports = router;
