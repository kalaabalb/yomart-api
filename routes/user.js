const express = require("express");
const sendRouteError = require("../utils/sendRouteError");
const logSafeError = require("../utils/logSafeError");
const asyncHandler = require("express-async-handler");
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");
const { isProductionLike } = require("../config/environment");
const router = express.Router();
const User = require("../model/user");
const Order = require("../model/order");
const Rating = require("../model/rating");
const PaymentProof = require("../model/paymentProof");
const AdminUser = require("../model/adminUser");
const {
  uploadProfileImage,
  uploadLimiter,
  savePrivateProfileImage,
  profileImageLocation,
  deliverPrivateProfileImage,
  deletePrivateProfileImage,
} = require("../uploadFile");
const { hasStrongPassword, passwordPolicyMessage } = require("../utils/passwordPolicy");
const {
  issueUserToken,
  requireAdminAuth,
  requireUserAuth,
  toPublicUser,
  requireCapability,
} = require("../middleware/adminAccess");

const externalAccountDeletionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => !isProductionLike(),
  message: {
    success: false,
    message: "Too many account deletion attempts. Please try again later.",
  },
});

function parseProfileImage(req, res, next) {
  uploadProfileImage.single("image")(req, res, (error) => {
    if (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.code === "LIMIT_FILE_SIZE"
          ? "Profile images must be 10 MB or smaller."
          : error.message || "Choose a valid JPG, PNG, or WebP image.",
      });
    }
    next();
  });
}

async function deleteAccountData(user) {
  const userId = user._id;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Retain order/payment evidence without direct customer identifiers.
      // Access through the deleted customer's prior JWT is revoked by status.
      await Order.updateMany({ userID: userId }, {
        $set: {
          "shippingAddress.phone": "",
          "shippingAddress.street": "",
          "shippingAddress.city": "",
          "shippingAddress.state": "",
          "shippingAddress.postalCode": "",
          "shippingAddress.country": "",
        },
        $unset: { "shippingAddress.latitude": 1, "shippingAddress.longitude": 1 },
      }, { session });
      await PaymentProof.updateMany({ ownerId: userId }, { $set: { accessRevokedAt: new Date() } }, { session });
      await Rating.deleteMany({ userId }, { session });
      await User.updateOne({ _id: userId }, {
        $set: {
          name: "Deleted customer",
          email: `deleted+${userId}@deleted.invalid`,
          phone: `deleted-${userId}`,
          password: require("crypto").randomBytes(48).toString("hex"),
          accountStatus: "deleted",
          emailVerified: false,
          phoneVerified: false,
        },
        $unset: { recoveryEmail: 1, verificationCode: 1, codeExpires: 1 },
      }, { session });
    });
  } finally {
    await session.endSession();
  }
}

async function deleteAccountWithPassword(user, password, res) {
  if (typeof password !== "string" || !password) {
    return res.status(400).json({
      success: false,
      message: "Enter your password to confirm account deletion.",
    });
  }
  if (!(await user.correctPassword(password))) {
    return res.status(400).json({
      success: false,
      message: "The password is incorrect.",
    });
  }

  await deleteAccountData(user);
  return res.json({
    success: true,
    message: "Your account access and direct contact details have been removed. Order and payment evidence is retained in anonymized form for business records.",
  });
}

// External web deletion resource: the user verifies ownership with their
// account email and password, so this works without reinstalling the app.
router.post(
  "/account-deletion",
  externalAccountDeletionLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({
        success: false,
        message: "Enter the email and password for your YoMart account.",
      });
    }

    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "The email or password is incorrect.",
      });
    }
    if (user.accountStatus === "deleted") {
      return res.status(401).json({ success: false, message: "The email or password is incorrect." });
    }
    return deleteAccountWithPassword(user, password, res);
  }),
);

// In-app account deletion, requiring a valid session and a fresh password.
router.delete(
  "/account",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.authUser._id);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }
    return deleteAccountWithPassword(user, req.body?.currentPassword, res);
  }),
);

// Get all users
router.get(
  "/",
  requireAdminAuth,
  requireCapability("customers.read"),
  asyncHandler(async (req, res) => {
    try {
      // The admin customer list supports customer contact and account lookup.
      // Do not return verification codes, recovery addresses, or other internal fields.
      const users = await User.find().select("_id name email phone createdAt accountStatus");
      res.json({
        success: true,
        message: "Users retrieved successfully.",
        data: users,
      });
    } catch (error) {
      logSafeError("Could not load users:", error);
      res.status(503).json({
        success: false,
        message: "We could not load users right now. Please try again later.",
      });
    }
  }),
);

// Login
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { name, password } = req.body || {};
    if (typeof name !== "string" || typeof password !== "string") {
      return res.status(400).json({
        success: false,
        message: "Username and password are required.",
      });
    }

    try {
      // Check if the user exists
      const identifier = name.trim().toLowerCase();
      const user = await User.findOne({
        $or: [{ name: identifier }, { email: identifier }],
      });

      if (!user) {
        return res
          .status(401)
          .json({ success: false, message: "Invalid name or password." });
      }
      if (user.accountStatus === "deleted") {
        return res.status(401).json({ success: false, message: "Invalid name or password." });
      }

      // SECURE password comparison with bcrypt
      if (!(await user.correctPassword(password))) {
        return res
          .status(401)
          .json({ success: false, message: "Invalid name or password." });
      }

      // Authentication successful
      const token = issueUserToken(user);

      res
        .status(200)
        .json({
          success: true,
          message: "Login successful.",
          data: {
            token,
            user: toPublicUser(user),
          },
        });
    } catch (error) {
      logSafeError("Login failed:", error);
      res.status(503).json({
        success: false,
        message: "We could not sign you in right now. Please try again later.",
      });
    }
  }),
);

// Get current authenticated user profile
router.get(
  "/profile",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    return res.json({
      success: true,
      message: "Profile retrieved successfully.",
      data: toPublicUser(req.authUser),
    });
  }),
);

router.put(
  "/profile",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    const { name, currentPassword, password } = req.body || {};

    if (typeof name !== "string" || !name.trim() || name.trim().length > 80) {
      return res.status(400).json({
        success: false,
        message: "Name is required.",
      });
    }

    const user = await User.findById(req.authUser._id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    if (password) {
      if (!hasStrongPassword(password)) {
        return res.status(400).json({ success: false, message: passwordPolicyMessage });
      }
      if (!currentPassword) {
        return res.status(400).json({
          success: false,
          message: "Current password is required to set new password.",
        });
      }

      if (!(await user.correctPassword(currentPassword))) {
        return res.status(400).json({
          success: false,
          message: "Current password is incorrect.",
        });
      }

      user.password = password;
    }

    user.name = name;
    await user.save();

    return res.json({
      success: true,
      message: "Profile updated successfully.",
      data: toPublicUser(user),
    });
  }),
);

router.post("/profile/image", requireUserAuth, uploadLimiter, parseProfileImage, asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "Choose a profile image to upload." });
  const user = await User.findById(req.authUser._id).select("+profileImageKey");
  if (!user) return res.status(404).json({ success: false, message: "User not found." });
  const previous = user.profileImageKey;
  const next = await savePrivateProfileImage(req.file.buffer, user._id);
  if (!profileImageLocation(next, user._id)) {
    await deletePrivateProfileImage(next, user._id).catch(() => {});
    return res.status(503).json({ success: false, message: "Profile image storage did not return a valid private reference." });
  }
  user.profileImageKey = next;
  user.profileImageAvailable = true;
  try {
    await user.save();
  } catch (error) {
    await deletePrivateProfileImage(next, user._id).catch(() => {});
    throw error;
  }
  if (previous && previous !== next) {
    await deletePrivateProfileImage(previous, user._id).catch(() => {
      // The old image is no longer addressable through the account; cleanup is best effort.
      console.warn("Could not remove replaced private profile media.");
    });
  }
  return res.json({ success: true, message: "Profile image updated.", data: toPublicUser(user) });
}));

router.get("/profile/image", requireUserAuth, asyncHandler(async (req, res) => {
  const user = await User.findById(req.authUser._id).select("+profileImageKey");
  if (!user || !user.profileImageKey || !profileImageLocation(user.profileImageKey, user._id)) {
    return res.status(404).json({ success: false, message: "No profile image is available." });
  }
  const delivered = await deliverPrivateProfileImage(user.profileImageKey, user._id, res);
  if (!delivered && !res.headersSent) return res.status(404).json({ success: false, message: "Profile image is unavailable." });
  return undefined;
}));

router.delete("/profile/image", requireUserAuth, asyncHandler(async (req, res) => {
  const user = await User.findById(req.authUser._id).select("+profileImageKey");
  if (!user) return res.status(404).json({ success: false, message: "User not found." });
  const previous = user.profileImageKey;
  if (previous) {
    user.profileImageKey = undefined;
    user.profileImageAvailable = false;
    await user.save();
    await deletePrivateProfileImage(previous, user._id).catch(() => {
      console.warn("Could not remove private profile media after account update.");
    });
  }
  return res.json({ success: true, message: "Profile image removed.", data: toPublicUser(user) });
}));

// Get a user by ID
router.get(
  "/:id",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    try {
      const userID = req.params.id;
      if (req.authUser._id.toString() !== userID) {
        return res.status(403).json({
          success: false,
          message: "You can only view your own profile.",
        });
      }

      const user = await User.findById(userID).select("-password");
      if (!user) {
        return res
          .status(404)
          .json({ success: false, message: "User not found." });
      }
      res.json({
        success: true,
        message: "User retrieved successfully.",
        data: user,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Register
router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    if (typeof body.name !== "string" || typeof body.email !== "string") {
      return res.status(400).json({
        success: false,
        message: "A username and valid email address are required.",
      });
    }
    const name = body.name.trim().toLowerCase();
    const email = body.email.trim().toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";

    if (name.length < 3 || name.length > 32 || !/^[a-z0-9_.-]+$/.test(name)) {
      return res.status(400).json({
        success: false,
        message: "Choose a username with 3–32 letters, numbers, dots, dashes, or underscores.",
      });
    }

    if (!/^[A-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z]{2,63}$/i.test(email)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid email address.",
      });
    }

    if (!hasStrongPassword(password)) {
      return res.status(400).json({
        success: false,
        message: passwordPolicyMessage,
      });
    }

    try {
      const existingUser = await User.findOne({ email });
      if (existingUser) {
        return res.status(409).json({
          success: false,
          message: "That email already has an account. Sign in or use a different email.",
        });
      }

      const user = new User({
        name,
        email,
        password,
        emailVerified: false,
      });
      const newUser = await user.save();

      const userResponse = {
        _id: newUser._id,
        name: newUser.name,
        email: newUser.email,
        emailVerified: newUser.emailVerified,
        createdAt: newUser.createdAt,
      };

      const token = issueUserToken(newUser);
      res.status(201).json({
        success: true,
        message: "Your account has been created.",
        data: {
          token,
          user: userResponse,
        },
      });
    } catch (error) {
      if (error.code === 11000) {
        return res
          .status(400)
          .json({ success: false, message: "Email already exists." });
      }
      logSafeError("Registration failed:", error);
      res.status(500).json({
        success: false,
        message: "We could not create your account right now. Please try again later.",
      });
    }
  }),
);

// Update a user
router.put(
  "/:id",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    try {
      const userID = req.params.id;
      const { name, password, currentPassword } = req.body || {};
      if (req.authUser._id.toString() !== userID) {
        return res.status(403).json({
          success: false,
          message: "You can only update your own profile.",
        });
      }
      if (typeof name !== "string" || !name.trim() || name.trim().length > 80) {
        return res
          .status(400)
          .json({ success: false, message: "Name is required." });
      }

      const user = await User.findById(userID);
      if (!user) {
        return res
          .status(404)
          .json({ success: false, message: "User not found." });
      }

      // If changing password, verify current password first
      if (password) {
        if (!hasStrongPassword(password)) {
          return res.status(400).json({ success: false, message: passwordPolicyMessage });
        }
        if (!currentPassword) {
          return res
            .status(400)
            .json({
              success: false,
              message: "Current password is required to set new password.",
            });
        }
        if (!(await user.correctPassword(currentPassword))) {
          return res
            .status(400)
            .json({
              success: false,
              message: "Current password is incorrect.",
            });
        }
        user.password = password; // Will be hashed automatically
      }

      user.name = name;
      await user.save();

      const userResponse = {
        _id: user._id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        updatedAt: user.updatedAt,
      };

      res.json({
        success: true,
        message: "User updated successfully.",
        data: userResponse,
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

// Delete a user
router.delete(
  "/:id",
  requireUserAuth,
  asyncHandler(async (req, res) => {
    try {
      const userID = req.params.id;
      if (req.authUser._id.toString() !== userID) {
        return res.status(403).json({
          success: false,
          message: "You can only delete your own account.",
        });
      }
      const user = await User.findById(userID);
      if (!user) {
        return res
          .status(404)
          .json({ success: false, message: "User not found." });
      }
      return deleteAccountWithPassword(user, req.body?.currentPassword, res);
    } catch (error) {
      sendRouteError(res, error);
    }
  }),
);

module.exports = router;
