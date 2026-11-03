const express = require("express");
const sendRouteError = require("../utils/sendRouteError");
const router = express.Router();
const Brand = require("../model/brand");
const Product = require("../model/product");
const asyncHandler = require("express-async-handler");
const { uploadBrand, uploadLimiter, deleteUploadedImage } = require("../uploadFile");
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

const validLogoUrl = (value) =>
  typeof value === "string" && value.length <= 500 &&
  (!value.trim() || /^https:\/\//i.test(value.trim()) ||
    /^\/uploads\/(?:catalog\/)?brands\/[A-Za-z0-9_-]+\.webp$/i.test(value.trim()));

// Get all brands
router.get(
  "/",
  loadAdmin,
  asyncHandler(async (req, res) => {
    try {
      const query = req.adminUser
        ? buildOwnedQuery(req, {})
        : { isActive: { $ne: false } };
      const brands = await Brand.find(query)
        .populate("subcategoryId")
        .sort({ sortOrder: 1, name: 1 });

      res.json({
        success: true,
        message: "Brands retrieved successfully.",
        data: brands,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Get a brand by ID
router.get(
  "/:id",
  loadAdmin,
  asyncHandler(async (req, res) => {
    try {
      const brandID = req.params.id;
      const brand = await Brand.findById(brandID).populate("subcategoryId");

      if (!brand) {
        return res
          .status(404)
          .json({ success: false, message: "Brand not found." });
      }
      if (!req.adminUser && brand.isActive === false) {
        return res.status(404).json({ success: false, message: "Brand not found." });
      }
      if (!canAccessOwnedDocument(req, brand)) {
        return res.status(403).json({
          success: false,
          message: "You can only access brands you created.",
        });
      }
      res.json({
        success: true,
        message: "Brand retrieved successfully.",
        data: brand,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Create a new brand
router.post(
  "/",
  requireAdminAuth,
  uploadLimiter,
  uploadBrand.single("logo"),
  asyncHandler(async (req, res) => {
    const { name, subcategoryId = "", sortOrder = 0, isActive = true } = req.body || {};
    const logoUrl = req.file?.path || req.body?.logoUrl || "";
    const parsedSortOrder = Number(sortOrder);
    const parsedActive = parseBoolean(isActive);

    if (
      typeof name !== "string" || !name.trim() || name.trim().length > 80 ||
      typeof subcategoryId !== "string" || (subcategoryId && !/^[a-f\d]{24}$/i.test(subcategoryId)) ||
      !validLogoUrl(logoUrl) || !Number.isInteger(parsedSortOrder) ||
      parsedSortOrder < 0 || parsedActive === null
    ) {
      return res
        .status(400)
        .json({
          success: false,
          message: "A valid brand name and optional subcategory are required.",
        });
    }

    try {
      const brand = new Brand({
        name: name.trim(),
        ...(subcategoryId ? { subcategoryId } : {}),
        logoUrl: logoUrl.trim(),
        sortOrder: parsedSortOrder,
        isActive: parsedActive,
        createdBy: req.adminUser._id,
      });
      const newBrand = await brand.save();
      res.json({
        success: true,
        message: "Brand created successfully.",
        data: newBrand,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Update a brand
router.put(
  "/:id",
  requireAdminAuth,
  uploadLimiter,
  uploadBrand.single("logo"),
  asyncHandler(async (req, res) => {
    const brandID = req.params.id;
    const { name, subcategoryId, sortOrder, isActive } = req.body || {};
    const logoUrl = req.file?.path || req.body?.logoUrl;

    if (
      typeof name !== "string" || !name.trim() || name.trim().length > 80 ||
      (subcategoryId !== undefined && (typeof subcategoryId !== "string" || (subcategoryId && !/^[a-f\d]{24}$/i.test(subcategoryId)))) ||
      (logoUrl !== undefined && !validLogoUrl(logoUrl)) ||
      (sortOrder !== undefined && (!Number.isInteger(Number(sortOrder)) || Number(sortOrder) < 0)) ||
      (isActive !== undefined && parseBoolean(isActive) === null)
    ) {
      return res
        .status(400)
        .json({
          success: false,
          message: "A valid brand name and optional subcategory are required.",
        });
    }

    try {
      const brand = await Brand.findById(brandID);
      if (!brand) {
        return res
          .status(404)
          .json({ success: false, message: "Brand not found." });
      }
      if (!canAccessOwnedDocument(req, brand)) {
        return res.status(403).json({
          success: false,
          message: "You can only edit brands you created.",
        });
      }

      const updatedBrand = await Brand.findByIdAndUpdate(
        brandID,
        {
          name: name.trim(),
          ...(subcategoryId !== undefined ? { subcategoryId: subcategoryId || null } : {}),
          ...(logoUrl !== undefined ? { logoUrl: logoUrl.trim() } : {}),
          ...(sortOrder !== undefined ? { sortOrder: Number(sortOrder) } : {}),
          ...(isActive !== undefined ? { isActive: parseBoolean(isActive) } : {}),
          createdBy: brand.createdBy || req.adminUser._id,
        },
        { new: true, runValidators: true },
      );

      if (req.file && brand.logoUrl && brand.logoUrl !== req.file.path) {
        await deleteUploadedImage(brand.logoUrl);
      }

      res.json({
        success: true,
        message: "Brand updated successfully.",
        data: updatedBrand,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Delete a brand
router.delete(
  "/:id",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const brandID = req.params.id;

    try {
      const brand = await Brand.findById(brandID);
      if (!brand) {
        return res
          .status(404)
          .json({ success: false, message: "Brand not found." });
      }
      if (!canAccessOwnedDocument(req, brand)) {
        return res.status(403).json({
          success: false,
          message: "You can only delete brands you created.",
        });
      }

      // Check if any products reference this brand
      const products = await Product.find({ proBrandId: brandID });
      if (products.length > 0) {
        return res
          .status(400)
          .json({
            success: false,
            message: "Cannot delete brand. Products are referencing it.",
          });
      }

      await Brand.findByIdAndDelete(brandID);
      res.json({ success: true, message: "Brand deleted successfully." });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

module.exports = router;
