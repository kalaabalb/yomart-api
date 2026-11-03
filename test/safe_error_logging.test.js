const test = require("node:test");
const assert = require("node:assert/strict");
const logSafeError = require("../utils/logSafeError");

test("safe error logging omits messages, stacks, and nested provider data", () => {
  const originalConsoleError = console.error;
  const parts = [];
  console.error = (...values) => parts.push(...values);
  const sensitive = "mongodb+srv://user:synthetic-secret@private-host/db";
  const error = Object.assign(new Error(sensitive), {
    code: "ENOTFOUND",
    response: { data: { token: "synthetic-token" } },
  });

  try {
    logSafeError("Database connection failed", error);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(parts[0], "Database connection failed");
  assert.deepEqual(parts[1], { name: "Error", code: "ENOTFOUND" });
  assert.equal(JSON.stringify(parts).includes(sensitive), false);
  assert.equal(JSON.stringify(parts).includes("synthetic-secret"), false);
  assert.equal(JSON.stringify(parts).includes("synthetic-token"), false);
});

test("safe error metadata accepts only bounded class names and safe codes", () => {
  assert.deepEqual(
    logSafeError.safeErrorMetadata({ name: "MongooseServerSelectionError", code: 11000 }),
    { name: "MongooseServerSelectionError", code: 11000 },
  );
  assert.deepEqual(
    logSafeError.safeErrorMetadata({ name: "Error\nsecret", code: "secret-value" }),
    { name: "Error" },
  );
});
