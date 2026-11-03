const AdminUser = require("../model/adminUser");
const logSafeError = require("./logSafeError");
const { isProductionLike } = require("../config/environment");
const {
  REQUIRED_ADMIN_ENV_VARS,
  getConfiguredDefaultAdmin,
} = require("../config/defaultAdmin");

const getMissingAdminProvisioningMessage = () =>
  `Missing required admin provisioning environment variables: ${REQUIRED_ADMIN_ENV_VARS.join(
    ", ",
  )}`;

const ensureDefaultAdminUser = async () => {
  try {
    const configuredAdmin = getConfiguredDefaultAdmin();

    if (!configuredAdmin) {
      const existingAdmin = await AdminUser.exists({});

      if (existingAdmin) {
        return;
      }

      const error = new Error(getMissingAdminProvisioningMessage());

      if (isProductionLike()) {
        throw error;
      }

      console.warn("Default admin bootstrap skipped because provisioning configuration is missing.");
      return;
    }

    const existing = await AdminUser.findOne({ username: configuredAdmin.username });

    if (existing) {
      // Environment values bootstrap the first administrator only. Never let
      // a routine restart undo a later password, role, or account-status change.
      return;
    }

    await AdminUser.create(configuredAdmin);
    console.log("Seeded initial admin user.");
  } catch (error) {
    logSafeError("Failed to ensure default admin user:", error);
    throw error;
  }
};

module.exports = ensureDefaultAdminUser;
