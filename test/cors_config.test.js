const test = require("node:test");
const assert = require("node:assert/strict");
const { createCorsOriginCallback } = require("../config/cors");
const { isProductionLike } = require("../config/environment");

function checkOrigin(callback, origin) {
  return new Promise((resolve) => {
    callback(origin, (error, allowed) => resolve({ error, allowed }));
  });
}

test("staging CORS allows only exact configured HTTPS origins", async () => {
  const callback = createCorsOriginCallback({
    NODE_ENV: "staging",
    CORS_ALLOWED_ORIGINS: "https://admin.staging.test,https://shop.staging.test",
  });

  assert.deepEqual(await checkOrigin(callback, "https://admin.staging.test"), {
    error: null,
    allowed: true,
  });
  const denied = await checkOrigin(callback, "https://attacker.test");
  assert.equal(denied.allowed, undefined);
  assert.match(denied.error.message, /Not allowed by CORS/);
  assert.deepEqual(await checkOrigin(callback, undefined), { error: null, allowed: true });
});

test("staging and production fail closed for missing or malformed CORS origins", () => {
  for (const NODE_ENV of ["staging", "production"]) {
    assert.throws(() => createCorsOriginCallback({ NODE_ENV }), /CORS_ALLOWED_ORIGINS is required/);
    for (const CORS_ALLOWED_ORIGINS of ["*", "http://shop.example", "https://shop.example/path", "https://user:pass@shop.example"]) {
      assert.throws(
        () => createCorsOriginCallback({ NODE_ENV, CORS_ALLOWED_ORIGINS }),
        /exact HTTPS origins only/,
      );
    }
  }
  assert.throws(() => createCorsOriginCallback({ NODE_ENV: "stagin" }), /NODE_ENV must be/);
});

test("development retains existing wildcard behavior", async () => {
  const callback = createCorsOriginCallback({ NODE_ENV: "development" });
  assert.deepEqual(await checkOrigin(callback, "http://localhost:5173"), { error: null, allowed: true });
  assert.deepEqual(await checkOrigin(callback, "https://local-dev.test"), { error: null, allowed: true });
});

test("staging uses production-like security configuration", () => {
  assert.equal(isProductionLike({ NODE_ENV: "staging" }), true);
  assert.equal(isProductionLike({ NODE_ENV: "production" }), true);
  assert.equal(isProductionLike({ NODE_ENV: "development" }), false);
  assert.equal(isProductionLike({ NODE_ENV: "test" }), false);
});
