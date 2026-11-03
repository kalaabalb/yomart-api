const express = require("express");
const sendRouteError = require("../utils/sendRouteError");
const logSafeError = require("../utils/logSafeError");
const router = express.Router();
const asyncHandler = require("express-async-handler");
const Notification = require("../model/notification");
const axios = require("axios");
const {
  buildOwnedQuery,
  requireAdminAuth,
  requireSuperAdmin,
} = require("../middleware/adminAccess");

const ONE_SIGNAL_APP_ID = process.env.ONE_SIGNAL_APP_ID;
const ONE_SIGNAL_REST_API_KEY = process.env.ONE_SIGNAL_REST_API_KEY;

// Send notification
router.post(
  "/send-notification",
  requireAdminAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { title, description, imageUrl } = req.body;

    const notificationBody = {
      app_id: ONE_SIGNAL_APP_ID,
      headings: { en: title },
      contents: { en: description },
      included_segments: ["All"],
      ...(imageUrl && { big_picture: imageUrl }),
    };

    try {
      const response = await axios.post(
        "https://onesignal.com/api/v1/notifications",
        notificationBody,
        {
          headers: {
            Authorization: `Basic ${ONE_SIGNAL_REST_API_KEY}`,
            "Content-Type": "application/json",
          },
        },
      );

      const notificationId = response.data.id;

      const notification = new Notification({
        notificationId,
        title,
        description,
        imageUrl,
        createdBy: req.adminUser._id,
      });
      await notification.save();

      res.json({
        success: true,
        message: "Notification sent successfully",
        data: null,
      });
    } catch (error) {
      logSafeError("Error sending notification:", error);
      res.status(500).json({
        success: false,
        message: "Failed to send notification",
        data: null,
      });
    }
  }),
);

// Track notification
router.get(
  "/track-notification/:id",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const notificationId = req.params.id;

    try {
      const response = await axios.get(
        `https://onesignal.com/api/v1/notifications/${notificationId}?app_id=${ONE_SIGNAL_APP_ID}`,
        {
          headers: {
            Authorization: `Basic ${ONE_SIGNAL_REST_API_KEY}`,
          },
        },
      );

      const androidStats = response.data.platform_delivery_stats;
      const result = {
        platform: "Android",
        success_delivery: androidStats.android.successful,
        failed_delivery: androidStats.android.failed,
        errored_delivery: androidStats.android.errored,
        opened_notification: androidStats.android.converted,
      };

      res.json({ success: true, message: "Success", data: result });
    } catch (error) {
      logSafeError("Error tracking notification:", error);
      res.status(500).json({
        success: false,
        message: "Failed to track notification",
        data: null,
      });
    }
  }),
);

// Get all notifications
router.get(
  "/all-notification",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    try {
      const notifications = await Notification.find(
        buildOwnedQuery(req, {}),
      ).sort({ _id: -1 });
      res.json({
        success: true,
        message: "Notifications retrieved successfully.",
        data: notifications,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Delete notification
router.delete(
  "/delete-notification/:id",
  requireAdminAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const notificationID = req.params.id;
    try {
      const notification = await Notification.findByIdAndDelete(notificationID);
      if (!notification) {
        return res.status(404).json({
          success: false,
          message: "Notification not found.",
          data: null,
        });
      }
      res.json({
        success: true,
        message: "Notification deleted successfully.",
        data: null,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

module.exports = router;
