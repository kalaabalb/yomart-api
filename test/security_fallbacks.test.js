const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

function resetEnv(previousEnv) {
  const keys = [
    "NODE_ENV",
    "JWT_SECRET",
    "ACCESS_TOKEN_SECRET",
    "JWT_EXPIRES_IN",
    "ADMIN_JWT_EXPIRES_IN",
    "ADMIN_USERNAME",
    "ADMIN_NAME",
    "ADMIN_EMAIL",
    "ADMIN_PASSWORD",
  ];

  for (const key of keys) {
    if (previousEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previousEnv[key];
    }
  }
}

function loadFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

test("JWT issuance fails safely when JWT_SECRET is absent", () => {
  const previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    JWT_SECRET: process.env.JWT_SECRET,
    ACCESS_TOKEN_SECRET: process.env.ACCESS_TOKEN_SECRET,
    JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN,
  };

  delete process.env.JWT_SECRET;
  delete process.env.ACCESS_TOKEN_SECRET;
  process.env.NODE_ENV = "test";

  const adminAccess = loadFresh("../middleware/adminAccess");

  assert.throws(
    () =>
      adminAccess.issueUserToken({
        _id: new mongoose.Types.ObjectId(),
      }),
    /JWT_SECRET environment variable is required/,
  );

  assert.throws(
    () =>
      adminAccess.issueAdminToken({
        _id: new mongoose.Types.ObjectId(),
        clearanceLevel: "super_admin",
      }),
    /JWT_SECRET environment variable is required/,
  );

  resetEnv(previousEnv);
  delete require.cache[require.resolve("../middleware/adminAccess")];
});

test("production startup fails closed when JWT_SECRET is missing", () => {
  const previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    JWT_SECRET: process.env.JWT_SECRET,
    ACCESS_TOKEN_SECRET: process.env.ACCESS_TOKEN_SECRET,
  };

  delete process.env.JWT_SECRET;
  delete process.env.ACCESS_TOKEN_SECRET;
  process.env.NODE_ENV = "production";

  assert.throws(() => loadFresh("../middleware/adminAccess"), /JWT_SECRET environment variable is required in production/);

  resetEnv(previousEnv);
  delete require.cache[require.resolve("../middleware/adminAccess")];
});

test("production rejects a JWT_SECRET shorter than 32 bytes", () => {
  const previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    JWT_SECRET: process.env.JWT_SECRET,
    ACCESS_TOKEN_SECRET: process.env.ACCESS_TOKEN_SECRET,
  };

  process.env.NODE_ENV = "production";
  process.env.JWT_SECRET = "too-short";
  delete process.env.ACCESS_TOKEN_SECRET;

  assert.throws(() => loadFresh("../middleware/adminAccess"), /JWT_SECRET must be at least 32 bytes in production/);

  resetEnv(previousEnv);
  delete require.cache[require.resolve("../middleware/adminAccess")];
});

test("explicit JWT_SECRET still allows token issuance", () => {
  const previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    JWT_SECRET: process.env.JWT_SECRET,
    ACCESS_TOKEN_SECRET: process.env.ACCESS_TOKEN_SECRET,
    JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN,
  };

  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "configured-secret";
  process.env.JWT_EXPIRES_IN = "1h";
  delete process.env.ACCESS_TOKEN_SECRET;

  const adminAccess = loadFresh("../middleware/adminAccess");
  const userId = new mongoose.Types.ObjectId();
  const token = adminAccess.issueUserToken({
    _id: userId,
  });

  const decoded = jwt.verify(token, "configured-secret");
  assert.equal(decoded.sub, userId.toString());
  assert.equal(decoded.role, "user");

  resetEnv(previousEnv);
  delete require.cache[require.resolve("../middleware/adminAccess")];
});

test("default admin provisioning cannot create a predictable account implicitly", async () => {
  const previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    ADMIN_USERNAME: process.env.ADMIN_USERNAME,
    ADMIN_NAME: process.env.ADMIN_NAME,
    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  };

  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_NAME;
  delete process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_PASSWORD;
  process.env.NODE_ENV = "production";

  const AdminUser = require("../model/adminUser");
  const originalExists = AdminUser.exists;
  const originalFindOne = AdminUser.findOne;
  const originalCreate = AdminUser.create;

  let createCalled = false;
  let saveCalled = false;

  AdminUser.exists = async () => false;
  AdminUser.findOne = async () => null;
  AdminUser.create = async () => {
    createCalled = true;
    return {
      save: async () => {
        saveCalled = true;
      },
      correctPassword: async () => false,
    };
  };

  delete require.cache[require.resolve("../utils/ensureDefaultAdminUser")];
  const ensureDefaultAdminUser = require("../utils/ensureDefaultAdminUser");

  await assert.rejects(
    () => ensureDefaultAdminUser(),
    /Missing required admin provisioning environment variables/,
  );

  assert.equal(createCalled, false);
  assert.equal(saveCalled, false);

  AdminUser.exists = originalExists;
  AdminUser.findOne = originalFindOne;
  AdminUser.create = originalCreate;
  resetEnv(previousEnv);
  delete require.cache[require.resolve("../utils/ensureDefaultAdminUser")];
});

test("bootstrap admin settings never overwrite an existing admin account", async () => {
  const previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    ADMIN_USERNAME: process.env.ADMIN_USERNAME,
    ADMIN_NAME: process.env.ADMIN_NAME,
    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  };
  process.env.NODE_ENV = "test";
  process.env.ADMIN_USERNAME = "bootstrap-admin";
  process.env.ADMIN_NAME = "Bootstrap Admin";
  process.env.ADMIN_EMAIL = "bootstrap@example.test";
  process.env.ADMIN_PASSWORD = "Strong-Password-123!";

  const AdminUser = require("../model/adminUser");
  const originalFindOne = AdminUser.findOne;
  const originalCreate = AdminUser.create;
  const existingAdmin = {
    isActive: false,
    clearanceLevel: "moderator",
    password: "hash-of-user-chosen-password",
  };
  let createCalled = false;
  AdminUser.findOne = async () => existingAdmin;
  AdminUser.create = async () => {
    createCalled = true;
    throw new Error("Existing admin should not be recreated");
  };

  delete require.cache[require.resolve("../utils/ensureDefaultAdminUser")];
  const ensureDefaultAdminUser = require("../utils/ensureDefaultAdminUser");
  await ensureDefaultAdminUser();

  assert.equal(createCalled, false);
  assert.equal(existingAdmin.isActive, false);
  assert.equal(existingAdmin.clearanceLevel, "moderator");
  assert.equal(existingAdmin.password, "hash-of-user-chosen-password");

  AdminUser.findOne = originalFindOne;
  AdminUser.create = originalCreate;
  resetEnv(previousEnv);
  delete require.cache[require.resolve("../utils/ensureDefaultAdminUser")];
});
