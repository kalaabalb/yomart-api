const express = require("express");
const asyncHandler = require("express-async-handler");
const router = express.Router();
const AdminUser = require("../model/adminUser");
const { hasStrongPassword, passwordPolicyMessage } = require("../utils/passwordPolicy");
const {
  issueAdminToken,
  requireAdminAuth,
  requireSuperAdmin,
  toPublicAdminUser,
} = require("../middleware/adminAccess");

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};

    if (
      typeof username !== "string" ||
      typeof password !== "string" ||
      !username.trim() ||
      !password
    ) {
      return res.status(400).json({
        success: false,
        message: "Username and password are required.",
      });
    }

    const adminUser = await AdminUser.findOne({ username, isActive: true });

    if (!adminUser) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password.",
      });
    }

    const passwordOk = await adminUser.correctPassword(password);
    if (!passwordOk) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password.",
      });
    }

    const token = issueAdminToken(adminUser);

    return res.json({
      success: true,
      message: "Login successful.",
      data: {
        token,
        user: toPublicAdminUser(adminUser),
      },
    });
  }),
);

router.get(
  "/profile",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    return res.json({
      success: true,
      message: "Profile retrieved successfully.",
      data: toPublicAdminUser(req.adminUser),
    });
  }),
);

router.get(
  "/",
  requireAdminAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const adminUsers = await AdminUser.find().sort({ createdAt: -1 });

    return res.json({
      success: true,
      message: "Admin users retrieved successfully.",
      data: adminUsers.map(toPublicAdminUser),
    });
  }),
);

router.get(
  "/:id",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const adminUser = await AdminUser.findById(req.params.id);

    if (!adminUser) {
      return res.status(404).json({
        success: false,
        message: "Admin user not found.",
      });
    }

    if (
      req.adminUser.clearanceLevel !== "super_admin" &&
      req.adminUser._id.toString() !== adminUser._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "You can only view your own profile.",
      });
    }

    return res.json({
      success: true,
      message: "Admin user retrieved successfully.",
      data: toPublicAdminUser(adminUser),
    });
  }),
);

router.post(
  "/",
  requireAdminAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { username, name, email, password, clearanceLevel } = req.body || {};

    if (
      typeof username !== "string" ||
      typeof name !== "string" ||
      typeof email !== "string" ||
      typeof password !== "string" ||
      !username.trim() ||
      !name.trim() ||
      !email.trim() ||
      !password
    ) {
      return res.status(400).json({
        success: false,
        message: "Username, name, email, and password are required.",
      });
    }
    if (!hasStrongPassword(password)) {
      return res.status(400).json({ success: false, message: passwordPolicyMessage });
    }

    const existingUser = await AdminUser.findOne({
      $or: [{ username }, { email }],
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: "Username or email already exists.",
      });
    }

    const adminUser = await AdminUser.create({
      username,
      name,
      email,
      password,
      clearanceLevel: clearanceLevel || "admin",
      createdBy: req.adminUser._id,
    });

    return res.status(201).json({
      success: true,
      message: "Admin user created successfully.",
      data: toPublicAdminUser(adminUser),
    });
  }),
);

router.put(
  "/:id",
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const { name, email, clearanceLevel, isActive, password } = req.body;
    const targetUser = await AdminUser.findById(req.params.id);

    if (!targetUser) {
      return res.status(404).json({
        success: false,
        message: "Admin user not found.",
      });
    }

    const isSelf = req.adminUser._id.toString() === targetUser._id.toString();
    const canEditAll = req.adminUser.clearanceLevel === "super_admin";

    if (!canEditAll && !isSelf) {
      return res.status(403).json({
        success: false,
        message: "You can only edit your own profile.",
      });
    }

    if (name) targetUser.name = name;
    if (email) targetUser.email = email;
    if (password) {
      if (!hasStrongPassword(password)) {
        return res.status(400).json({ success: false, message: passwordPolicyMessage });
      }
      targetUser.password = password;
    }

    if (canEditAll) {
      if (clearanceLevel) targetUser.clearanceLevel = clearanceLevel;
      if (typeof isActive === "boolean") targetUser.isActive = isActive;
    }

    await targetUser.save();

    return res.json({
      success: true,
      message: "Admin user updated successfully.",
      data: toPublicAdminUser(targetUser),
    });
  }),
);

router.delete(
  "/:id",
  requireAdminAuth,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    if (req.adminUser._id.toString() === req.params.id) {
      return res.status(400).json({
        success: false,
        message: "You cannot delete your own account.",
      });
    }

    const deletedUser = await AdminUser.findByIdAndDelete(req.params.id);

    if (!deletedUser) {
      return res.status(404).json({
        success: false,
        message: "Admin user not found.",
      });
    }

    return res.json({
      success: true,
      message: "Admin user deleted successfully.",
    });
  }),
);

module.exports = router;
