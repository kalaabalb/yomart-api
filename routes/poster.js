const express = require("express");
const sendRouteError = require("../utils/sendRouteError");
const router = express.Router();
const Poster = require("../model/poster");
const { uploadPosters, uploadLimiter, deleteUploadedImage } = require("../uploadFile");
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

// Get all posters
router.get(
  "/",
  loadAdmin,
  asyncHandler(async (req, res) => {
    try {
      const query = req.adminUser
        ? buildOwnedQuery(req, {})
        : { isActive: { $ne: false } };
      const posters = await Poster.find(query).sort({ sortOrder: 1, createdAt: -1 });

      res.json({
        success: true,
        message: "Posters retrieved successfully.",
        data: posters,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Get a poster by ID
router.get(
  "/:id",
  loadAdmin,
  asyncHandler(async (req, res) => {
    try {
      const posterID = req.params.id;
      const poster = await Poster.findById(posterID);

      if (!poster) {
        return res
          .status(404)
          .json({ success: false, message: "Poster not found." });
      }
      if (!req.adminUser && poster.isActive === false) {
        return res.status(404).json({ success: false, message: "Poster not found." });
      }
      if (!canAccessOwnedDocument(req, poster)) {
        return res.status(403).json({
          success: false,
          message: "You can only access posters you created.",
        });
      }
      res.json({
        success: true,
        message: "Poster retrieved successfully.",
        data: poster,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Create a new poster
router.post(
  "/",
  requireAdminAuth,
  uploadLimiter,
  asyncHandler(async (req, res) => {
    try {
      uploadPosters.single("img")(req, res, async function (err) {
        if (err) return sendRouteError(res, err);
        const body = req.body || {};
        const { posterName } = body;
        const subtitle = typeof body.subtitle === "string" ? body.subtitle.trim() : "";
        const sortOrder = Number(body.sortOrder ?? 0);
        const isActive = body.isActive === undefined ? true : parseBoolean(body.isActive);
        let imageUrl = "";

        if (req.file) {
          imageUrl = req.file.path;
        }

        if (typeof posterName !== "string" || !posterName.trim() || posterName.trim().length > 100) {
          return res
            .status(400)
            .json({ success: false, message: "Name is required." });
        }
        if (subtitle.length > 160 || !Number.isInteger(sortOrder) || sortOrder < 0 || isActive === null) {
          return res.status(400).json({ success: false, message: "Poster subtitle, order, or visibility is invalid." });
        }

        if (!imageUrl) {
          return res
            .status(400)
            .json({ success: false, message: "Image is required." });
        }

        try {
          const newPoster = new Poster({
            posterName: posterName.trim(),
            subtitle,
            sortOrder,
            isActive,
            imageUrl: imageUrl,
            createdBy: req.adminUser._id,
          });
          await newPoster.save();
          res.json({
            success: true,
            message: "Poster created successfully.",
            data: newPoster,
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

// Update a poster
router.put(
  "/:id",
  requireAdminAuth,
  uploadLimiter,
  asyncHandler(async (req, res) => {
    try {
      const posterID = req.params.id;
      uploadPosters.single("img")(req, res, async function (err) {
        if (err) return sendRouteError(res, err);

        const body = req.body || {};
        const { posterName } = body;
        let image = body.image;

        if (req.file) {
          image = req.file.path;
        }

        if (typeof posterName !== "string" || !posterName.trim() || posterName.trim().length > 100 || !image) {
          return res
            .status(400)
            .json({ success: false, message: "Name and image are required." });
        }

        try {
          const poster = await Poster.findById(posterID);
          if (!poster) {
            return res
              .status(404)
              .json({ success: false, message: "Poster not found." });
          }
          if (!canAccessOwnedDocument(req, poster)) {
            return res.status(403).json({
              success: false,
              message: "You can only edit posters you created.",
            });
          }

          const subtitle = body.subtitle === undefined
            ? poster.subtitle
            : typeof body.subtitle === "string" ? body.subtitle.trim() : null;
          const sortOrder = body.sortOrder === undefined
            ? poster.sortOrder
            : Number(body.sortOrder);
          const isActive = body.isActive === undefined
            ? poster.isActive
            : parseBoolean(body.isActive);
          if (subtitle == null || subtitle.length > 160 || !Number.isInteger(sortOrder) || sortOrder < 0 || isActive === null) {
            return res.status(400).json({ success: false, message: "Poster subtitle, order, or visibility is invalid." });
          }

          const updatedPoster = await Poster.findByIdAndUpdate(
            posterID,
            {
              posterName: posterName.trim(),
              imageUrl: image,
              subtitle,
              sortOrder,
              isActive,
              createdBy: poster.createdBy || req.adminUser._id,
            },
            { new: true, runValidators: true },
          );
          if (poster.imageUrl !== image) await deleteUploadedImage(poster.imageUrl);

          res.json({
            success: true,
            message: "Poster updated successfully.",
            data: updatedPoster,
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

// Delete a poster
router.delete(
  "/:id",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const posterID = req.params.id;

    try {
      const poster = await Poster.findById(posterID);
      if (!poster) {
        return res
          .status(404)
          .json({ success: false, message: "Poster not found." });
      }
      if (!canAccessOwnedDocument(req, poster)) {
        return res.status(403).json({
          success: false,
          message: "You can only delete posters you created.",
        });
      }

      await Poster.findByIdAndDelete(posterID);
      await deleteUploadedImage(poster.imageUrl);
      res.json({ success: true, message: "Poster deleted successfully." });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

module.exports = router;
