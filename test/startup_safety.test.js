const test = require("node:test");
const assert = require("node:assert/strict");
const {
  STARTUP_NO_WRITE_FLAG,
  configureStartupSafety,
  runAdminBootstrap,
} = require("../config/startupSafety");

function fakeMongoose() {
  const settings = [];
  return { settings, set: (...args) => settings.push(args) };
}

test("explicit startup no-write guard disables Mongoose collection and index automation before initialization", () => {
  const mongoose = fakeMongoose();
  const policy = configureStartupSafety(mongoose, { [STARTUP_NO_WRITE_FLAG]: "true" });
  assert.deepEqual(mongoose.settings, [["autoCreate", false], ["autoIndex", false]]);
  assert.equal(policy.noWriteStartup, true);
  assert.equal(policy.autoCreate, false);
  assert.equal(policy.autoIndex, false);
  assert.equal(policy.shouldBootstrapAdmin, false);
});

test("guarded startup skips the admin bootstrap callback", async () => {
  const policy = configureStartupSafety(fakeMongoose(), { [STARTUP_NO_WRITE_FLAG]: "true" });
  let bootstrapCalls = 0;
  const result = await runAdminBootstrap(policy, async () => { bootstrapCalls += 1; });
  assert.equal(result, "skipped");
  assert.equal(bootstrapCalls, 0);
});

test("absence of the temporary flag preserves the existing automatic startup behavior", async () => {
  const mongoose = fakeMongoose();
  const policy = configureStartupSafety(mongoose, {});
  let bootstrapCalls = 0;
  const result = await runAdminBootstrap(policy, async () => { bootstrapCalls += 1; });
  assert.deepEqual(mongoose.settings, []);
  assert.equal(policy.noWriteStartup, false);
  assert.equal(policy.shouldBootstrapAdmin, true);
  assert.equal(result, "completed");
  assert.equal(bootstrapCalls, 1);
});

test("a malformed safety flag fails closed instead of silently enabling startup writes", () => {
  assert.throws(
    () => configureStartupSafety(fakeMongoose(), { [STARTUP_NO_WRITE_FLAG]: "yes" }),
    new RegExp(`${STARTUP_NO_WRITE_FLAG} must be set to true or false`),
  );
});
