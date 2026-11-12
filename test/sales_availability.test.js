const test = require("node:test");
const assert = require("node:assert/strict");
const { areSalesEnabled } = require("../config/salesAvailability");

test("sales are disabled by default in staging and production", () => {
  assert.equal(areSalesEnabled({ NODE_ENV: "staging" }), false);
  assert.equal(areSalesEnabled({ NODE_ENV: "production" }), false);
});

test("local development keeps checkout enabled unless explicitly disabled", () => {
  assert.equal(areSalesEnabled({ NODE_ENV: "development" }), true);
  assert.equal(areSalesEnabled({ NODE_ENV: "test" }), true);
  assert.equal(areSalesEnabled({ NODE_ENV: "development", YOMART_SALES_ENABLED: "false" }), false);
});

test("production sales require an explicit true value", () => {
  assert.equal(areSalesEnabled({ NODE_ENV: "production", YOMART_SALES_ENABLED: "true" }), true);
  assert.equal(areSalesEnabled({ NODE_ENV: "staging", YOMART_SALES_ENABLED: "true" }), true);
});

test("invalid sales switch values fail closed", () => {
  assert.throws(() => areSalesEnabled({ NODE_ENV: "production", YOMART_SALES_ENABLED: "yes" }), /must be set to true or false/);
  assert.throws(() => areSalesEnabled({ NODE_ENV: "production", YOMART_SALES_ENABLED: "" }), /must be set to true or false/);
});
