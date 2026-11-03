const express = require("express");
const sendRouteError = require("../utils/sendRouteError");
const logSafeError = require("../utils/logSafeError");
const asyncHandler = require("express-async-handler");
const router = express.Router();
const Rating = require("../model/rating");
const mongoose = require("mongoose");
const {
  requireUserAuth,
} = require("../middleware/adminAccess");

// Get ratings for a product with pagination
router.get(
  "/product/:productId",
  asyncHandler(async (req, res) => {
    try {
      const { productId } = req.params;
      const { page = 1, limit = 10 } = req.query;

      const ratings = await Rating.find({ productId })
        .sort({ createdAt: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit);

      const count = await Rating.countDocuments({ productId });

      res.json({
        success: true,
        message: "Ratings retrieved successfully.",
        data: {
          ratings,
          totalPages: Math.ceil(count / limit),
          currentPage: parseInt(page),
          ratingCount: count,
        },
      });
    } catch (error) {
      logSafeError("Error getting ratings:", error);
      sendRouteError(res, error);
    }
  }),
);

// Get rating stats for a product
router.get(
  "/product/:productId/stats",
  asyncHandler(async (req, res) => {
    try {
      const { productId } = req.params;

      const stats = await Rating.aggregate([
        { $match: { productId: new mongoose.Types.ObjectId(productId) } },
        {
          $group: {
            _id: "$productId",
            averageRating: { $avg: "$rating" },
            ratingCount: { $sum: 1 },
            distribution: {
              $push: "$rating",
            },
          },
        },
      ]);

      if (stats.length === 0) {
        return res.json({
          success: true,
          message: "No ratings found.",
          data: {
            averageRating: 0,
            ratingCount: 0,
            distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
          },
        });
      }

      // Calculate distribution
      const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      stats[0].distribution.forEach((rating) => {
        distribution[rating.toString()]++;
      });

      res.json({
        success: true,
        message: "Rating stats retrieved successfully.",
        data: {
          averageRating: parseFloat(stats[0].averageRating.toFixed(1)),
          ratingCount: stats[0].ratingCount,
          distribution,
        },
      });
    } catch (error) {
      logSafeError("Error getting rating stats:", error);
      sendRouteError(res, error);
    }
  }),
);

// Get user's rating for a product
router.get(
  "/product/:productId/user/:userId",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    try {
      const { productId, userId } = req.params;

      if (req.authUser._id.toString() !== userId) {
        return res.status(403).json({
          success: false,
          message: "You can only view your own rating.",
        });
      }

      const rating = await Rating.findOne({
        productId,
        userId,
      });

      // Return 200 with null data instead of 404
      res.json({
        success: true,
        message: rating
          ? "User rating retrieved successfully."
          : "No rating found.",
        data: rating || null,
      });
    } catch (error) {
      logSafeError("Error getting user rating:", error);
      sendRouteError(res, error);
    }
  }),
);

// Create or update rating
router.post(
  "/",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    try {
      const { productId, userId, userName, rating, review } = req.body;

      if (!productId || !rating) {
        return res.status(400).json({
          success: false,
          message: "Product ID and Rating are required.",
        });
      }

      if (userId && userId !== req.authUser._id.toString()) {
        return res.status(403).json({
          success: false,
          message: "You can only submit ratings for your own account.",
        });
      }

      // Check if user already rated this product
      const currentUserId = req.authUser._id.toString();
      const existingRating = await Rating.findOne({
        productId,
        userId: currentUserId,
      });

      if (existingRating) {
        // Update existing rating
        existingRating.rating = rating;
        existingRating.review = review || existingRating.review;
        await existingRating.save();

        res.json({
          success: true,
          message: "Rating updated successfully.",
          data: existingRating,
        });
      } else {
        // Create new rating
        const newRating = new Rating({
          productId,
          userId: currentUserId,
          userName: userName || req.authUser.name,
          rating,
          review: review || "",
        });

        await newRating.save();

        res.json({
          success: true,
          message: "Rating created successfully.",
          data: newRating,
        });
      }
    } catch (error) {
      logSafeError("Error creating rating:", error);
      if (error.code === 11000) {
        return res.status(400).json({
          success: false,
          message: "You have already rated this product.",
        });
      }
      sendRouteError(res, error);
    }
  }),
);

// Update a rating
router.put(
  "/:id",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    try {
      const ratingId = req.params.id;
      const { rating, review } = req.body;

      const existingRating = await Rating.findById(ratingId);
      if (!existingRating) {
        return res.status(404).json({
          success: false,
          message: "Rating not found.",
        });
      }

      if (existingRating.userId.toString() !== req.authUser._id.toString()) {
        return res.status(403).json({
          success: false,
          message: "You can only update your own rating.",
        });
      }

      const updatedRating = await Rating.findByIdAndUpdate(
        ratingId,
        { rating, review },
        { new: true },
      );

      res.json({
        success: true,
        message: "Rating updated successfully.",
        data: updatedRating,
      });
    } catch (error) {
      logSafeError("Error updating rating:", error);
      sendRouteError(res, error);
    }
  }),
);

// Delete a rating
router.delete(
  "/:id",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    try {
      const ratingId = req.params.id;

      const rating = await Rating.findById(ratingId);
      if (!rating) {
        return res.status(404).json({
          success: false,
          message: "Rating not found.",
        });
      }

      if (rating.userId.toString() !== req.authUser._id.toString()) {
        return res.status(403).json({
          success: false,
          message: "You can only delete your own rating.",
        });
      }

      const deletedRating = await Rating.findByIdAndDelete(ratingId);

      res.json({
        success: true,
        message: "Rating deleted successfully.",
      });
    } catch (error) {
      logSafeError("Error deleting rating:", error);
      sendRouteError(res, error);
    }
  }),
);

module.exports = router;
