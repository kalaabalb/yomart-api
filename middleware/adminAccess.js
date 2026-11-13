const jwt = require("jsonwebtoken");
const AdminUser = require("../model/adminUser");
const User = require("../model/user");
const { isProductionLike } = require("../config/environment");

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
// Admin sessions should be shorter lived than customer access tokens. Can be
// adjusted for the deployment environment without changing the API contract.
const ADMIN_JWT_EXPIRES_IN = process.env.ADMIN_JWT_EXPIRES_IN || "8h";

if (isProductionLike()) {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET environment variable is required in production");
  }
  if (Buffer.byteLength(process.env.JWT_SECRET, "utf8") < 32) {
    throw new Error("JWT_SECRET must be at least 32 bytes in production");
  }
}

const getJwtSecret = () => {
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    throw new Error("JWT_SECRET environment variable is required");
  }

  return jwtSecret;
};

const getTokenFromRequest = (req) => {
  const authHeader = req.headers.authorization || "";

  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }

  return null;
};

const getCurrentAdmin = async (req) => {
  const token = getTokenFromRequest(req);

  if (!token) {
    return null;
  }

  const payload = verifyAccessToken(token);

  if (payload.role !== "admin" || payload.tokenType !== "access") {
    return null;
  }

  return AdminUser.findById(payload.sub);
};

const signAccessToken = (payload, expiresIn = JWT_EXPIRES_IN) =>
  jwt.sign({ ...payload, tokenType: "access" }, getJwtSecret(), { expiresIn });

const issueUserToken = (user) =>
  signAccessToken({
    sub: user._id.toString(),
    role: "user",
  });

const issueAdminToken = (adminUser) =>
  signAccessToken(
    {
      sub: adminUser._id.toString(),
      role: "admin",
      clearanceLevel: adminUser.clearanceLevel,
    },
    ADMIN_JWT_EXPIRES_IN,
  );

const verifyAccessToken = (token) => jwt.verify(token, getJwtSecret());

const toPublicUser = (user) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  phone: user.phone,
  emailVerified: user.emailVerified,
  phoneVerified: user.phoneVerified,
  profileImageAvailable: user.profileImageAvailable === true,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

const toPublicAdminUser = (adminUser) => ({
  _id: adminUser._id,
  username: adminUser.username,
  name: adminUser.name,
  email: adminUser.email,
  clearanceLevel: adminUser.clearanceLevel,
  isActive: adminUser.isActive,
  createdBy: adminUser.createdBy,
  createdAt: adminUser.createdAt,
  updatedAt: adminUser.updatedAt,
});

const loadUser = async (req, res, next) => {
  try {
    const token = getTokenFromRequest(req);

    if (!token) {
      req.authUser = null;
      return next();
    }

    const payload = verifyAccessToken(token);
    if (payload.role !== "user" || payload.tokenType !== "access") {
      req.authUser = null;
      return next();
    }

    const user = await User.findById(payload.sub);
    if (!user || user.accountStatus === "deleted") {
      req.authUser = null;
      return next();
    }

    req.authUser = user;
    next();
  } catch (error) {
    req.authUser = null;
    next();
  }
};

const requireUserAuth = async (req, res, next) => {
  try {
    await loadUser(req, res, () => {});

    if (!req.authUser) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized. Please login again.",
      });
    }

    next();
  } catch (error) {
    next(error);
  }
};

const loadAdmin = async (req, res, next) => {
  try {
    const token = getTokenFromRequest(req);

    if (!token) {
      req.adminUser = null;
      return next();
    }

    const payload = verifyAccessToken(token);
    if (payload.role !== "admin" || payload.tokenType !== "access") {
      req.adminUser = null;
      return next();
    }

    const adminUser = await AdminUser.findById(payload.sub);

    if (adminUser && adminUser.isActive) {
      req.adminUser = adminUser;
    } else {
      req.adminUser = null;
    }

    next();
  } catch (error) {
    req.adminUser = null;
    next();
  }
};

const requireAdminAuth = async (req, res, next) => {
  try {
    await loadAdmin(req, res, () => {});

    if (!req.adminUser) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized. Please login again.",
      });
    }

    next();
  } catch (error) {
    next(error);
  }
};

const requireSuperAdmin = async (req, res, next) => {
  try {
    if (req.adminUser?.clearanceLevel !== "super_admin") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Super admin privileges required.",
      });
    }

    next();
  } catch (error) {
    next(error);
  }
};

// Existing roles only. Moderators manage their permitted catalog records but
// do not receive order/customer or payment capabilities.
const CAPABILITY_ROLES = Object.freeze({
  "orders.read": ["admin", "super_admin"],
  "orders.fulfill": ["admin", "super_admin"],
  "orders.delete": ["super_admin"],
  "payments.review": ["admin", "super_admin"],
  "customers.read": ["admin", "super_admin"],
  "contacts.manage": ["admin", "super_admin"],
});

const requireCapability = (capability) => (req, res, next) => {
  const allowedRoles = CAPABILITY_ROLES[capability] || [];
  if (!req.adminUser || !allowedRoles.includes(req.adminUser.clearanceLevel)) {
    return res.status(req.adminUser ? 403 : 401).json({
      success: false,
      message: req.adminUser ? "You are not authorized to perform this action." : "Unauthorized. Please login again.",
    });
  }
  next();
};

const buildOwnedQuery = (req, query = {}) => {
  if (!req.adminUser || req.adminUser.clearanceLevel === "super_admin") {
    return query;
  }

  return {
    ...query,
    $or: [
      { createdBy: req.adminUser._id },
      { createdBy: null },
      { createdBy: { $exists: false } },
    ],
  };
};

const canAccessOwnedDocument = (req, document) => {
  if (!req.adminUser || req.adminUser.clearanceLevel === "super_admin") {
    return true;
  }

  if (!document?.createdBy) {
    return true;
  }

  return document.createdBy.toString() === req.adminUser._id.toString();
};

module.exports = {
  issueUserToken,
  issueAdminToken,
  requireUserAuth,
  requireAdminAuth,
  requireSuperAdmin,
  requireCapability,
  CAPABILITY_ROLES,
  loadUser,
  loadAdmin,
  getCurrentAdmin,
  toPublicUser,
  toPublicAdminUser,
  buildOwnedQuery,
  canAccessOwnedDocument,
  getJwtSecret,
};
