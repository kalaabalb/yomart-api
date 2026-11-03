const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const {
  assertStagingTarget,
  parseTargetUsername,
  safeFailureCategory,
  safeWriteState,
  disconnectPreservingWriteOutcome,
  updateAndVerifyPassword,
} = require("../scripts/reset_staging_super_admin_password");

function fakeAdminModel({ precheck, storedAccount, precheckError, postReadError, updateError, updateResult } = {}) {
  let reads = 0;
  const calls = { filters: [], updates: [] };
  return {
    calls,
    findOne(filter) {
      calls.filters.push(filter);
      return {
        select() { return this; },
        async lean() {
          reads += 1;
          if (reads === 1 && precheckError) throw precheckError;
          if (reads === 1) return precheck;
          if (postReadError) throw postReadError;
          return storedAccount;
        },
      };
    },
    async updateOne(filter, update, options) {
      calls.updates.push({ filter, update, options });
      if (updateError) throw updateError;
      return updateResult || { matchedCount: 1, modifiedCount: 1 };
    },
  };
}

const resetAccount = Object.freeze({
  _id: "synthetic-account-id",
  username: "synthetic-admin",
  clearanceLevel: "super_admin",
  isActive: true,
});

function eligibleResetAccount() {
  return { ...resetAccount };
}

test("password reset target accepts only the confirmed staging cluster and database", () => {
  const target = assertStagingTarget("mongodb+srv://synthetic:synthetic@yomart-staging.vgxqc6z.mongodb.net/yomart_staging?retryWrites=true");
  assert.deepEqual(target, {
    hostname: "yomart-staging.vgxqc6z.mongodb.net",
    database: "yomart_staging",
  });
});

test("password reset refuses a production or otherwise unconfirmed hostname", () => {
  assert.throws(
    () => assertStagingTarget("mongodb+srv://synthetic:synthetic@production.invalid/yomart_staging"),
    (error) => error.safeCategory === "wrong_database_target",
  );
});

test("password reset refuses a different database even on the staging host", () => {
  assert.throws(
    () => assertStagingTarget("mongodb+srv://synthetic:synthetic@yomart-staging.vgxqc6z.mongodb.net/production"),
    (error) => error.safeCategory === "wrong_database_target",
  );
});

test("password reset rejects malformed connection strings without echoing them", () => {
  assert.throws(
    () => assertStagingTarget("not-a-mongodb-uri"),
    (error) => error.safeCategory === "local_configuration_failed",
  );
});

test("password reset requires an explicit exact target username", () => {
  assert.equal(parseTargetUsername(["--username", "yonas"]), "yonas");
  assert.throws(() => parseTargetUsername([]), /exact account/);
  assert.throws(() => parseTargetUsername(["--username", " "]), /exact account/);
  assert.throws(() => parseTargetUsername(["--username", "yonas", "--force"]), /exact account/);
});

test("reset diagnostics map known failures to safe categories without using raw messages", () => {
  assert.equal(safeFailureCategory({ name: "MongooseServerSelectionError", message: "private detail" }), "staging_database_unavailable");
  assert.equal(safeFailureCategory({ name: "MongoServerError", message: "private detail" }), "database_operation_failed");
  assert.equal(safeFailureCategory({ code: "ETIMEDOUT", message: "private detail" }), "database_transport_failed");
  assert.equal(safeFailureCategory({ message: "secret-looking detail" }), "unknown_reset_failure");
});

test("reset diagnostics retain only allow-listed password write states", () => {
  assert.equal(safeWriteState({ writeState: "confirmed" }), "confirmed");
  assert.equal(safeWriteState({ writeState: "outcome_uncertain" }), "outcome_uncertain");
  assert.equal(safeWriteState({ writeState: "password hash detail" }), "not_attempted");
});

test("password write is confirmed only after the stored hash passes bcrypt comparison", async () => {
  const password = "Synthetic-only-Password1!";
  const passwordHash = await bcrypt.hash(password, 4);
  const model = fakeAdminModel({
    precheck: eligibleResetAccount(),
    storedAccount: { password: passwordHash },
  });
  const result = await updateAndVerifyPassword({
    AdminUser: model,
    account: resetAccount,
    targetUsername: resetAccount.username,
    passwordHash,
    password,
    comparePassword: bcrypt.compare,
  });

  assert.deepEqual(result, { writeState: "confirmed" });
  assert.deepEqual(model.calls.updates[0].update, { $set: { password: passwordHash } });
  assert.deepEqual(model.calls.updates[0].filter, {
    _id: resetAccount._id,
    username: resetAccount.username,
    clearanceLevel: "super_admin",
    isActive: true,
  });
});

test("failed bcrypt verification reports an uncertain write outcome", async () => {
  const password = "Synthetic-only-Password1!";
  const otherPasswordHash = await bcrypt.hash("Different-synthetic-password2!", 4);
  const model = fakeAdminModel({
    precheck: eligibleResetAccount(),
    storedAccount: { password: otherPasswordHash },
  });
  await assert.rejects(
    updateAndVerifyPassword({
      AdminUser: model,
      account: resetAccount,
      targetUsername: resetAccount.username,
      passwordHash: "synthetic-new-hash",
      password,
      comparePassword: bcrypt.compare,
    }),
    (error) => error.safeCategory === "password_write_not_confirmed" && error.writeState === "outcome_uncertain",
  );
});

test("database error before update leaves write not attempted", async () => {
  const model = fakeAdminModel({ precheckError: new Error("synthetic database error") });
  await assert.rejects(
    updateAndVerifyPassword({
      AdminUser: model,
      account: resetAccount,
      targetUsername: resetAccount.username,
      passwordHash: "synthetic-new-hash",
      password: "Synthetic-only-Password1!",
      comparePassword: async () => true,
    }),
    (error) => error.safeCategory === "database_operation_failed" && error.writeState === "not_attempted",
  );
  assert.equal(model.calls.updates.length, 0);
});

test("database error after acknowledged update leaves write outcome uncertain", async () => {
  const model = fakeAdminModel({
    precheck: eligibleResetAccount(),
    postReadError: new Error("synthetic verification read error"),
  });
  await assert.rejects(
    updateAndVerifyPassword({
      AdminUser: model,
      account: resetAccount,
      targetUsername: resetAccount.username,
      passwordHash: "synthetic-new-hash",
      password: "Synthetic-only-Password1!",
      comparePassword: async () => true,
    }),
    (error) => error.safeCategory === "password_write_not_confirmed" && error.writeState === "outcome_uncertain",
  );
  assert.equal(model.calls.updates.length, 1);
});

test("disconnect failure cannot downgrade a confirmed password write", async () => {
  const result = await disconnectPreservingWriteOutcome(
    async () => { throw new Error("synthetic disconnect failure"); },
    "confirmed",
  );
  assert.deepEqual(result, { writeState: "confirmed", disconnectFailed: true });
});
