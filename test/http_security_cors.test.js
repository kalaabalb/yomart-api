const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const request = require("supertest");
const mountHttpSecurity = require("../config/httpSecurity");
const errorHandler = require("../middleware/errorHandler");

const adminOrigin = "https://yomart-admin.onrender.com";

function createApp() {
  const app = express();
  mountHttpSecurity(app, {
    cors,
    rateLimit,
    env: {
      NODE_ENV: "staging",
      CORS_ALLOWED_ORIGINS: adminOrigin,
    },
  });
  app.post("/admin-users/login", (req, res) => {
    res.status(401).json({ success: false, message: "Invalid credentials" });
  });
  app.use(errorHandler);
  return app;
}

test("allowed admin preflight permits POST and required content/auth headers", async () => {
  const response = await request(createApp())
    .options("/admin-users/login")
    .set("Origin", adminOrigin)
    .set("Access-Control-Request-Method", "POST")
    .set("Access-Control-Request-Headers", "Content-Type, Authorization");

  assert.equal(response.status, 204);
  assert.equal(response.headers["access-control-allow-origin"], adminOrigin);
  assert.match(response.headers["access-control-allow-methods"], /POST/);
  assert.match(response.headers["access-control-allow-headers"], /content-type/i);
  assert.match(response.headers["access-control-allow-headers"], /authorization/i);
  assert.equal(response.headers["access-control-allow-credentials"], "true");
});

test("more than ten preflights keep valid CORS and do not consume login capacity", async () => {
  const app = createApp();

  for (let i = 0; i < 15; i += 1) {
    const preflight = await request(app)
      .options("/admin-users/login")
      .set("Origin", adminOrigin)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "Content-Type, Authorization");
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], adminOrigin);
  }

  for (let i = 0; i < 10; i += 1) {
    const login = await request(app)
      .post("/admin-users/login")
      .set("Origin", adminOrigin)
      .send({ username: "synthetic", password: "synthetic" });
    assert.equal(login.status, 401);
    assert.equal(login.headers["access-control-allow-origin"], adminOrigin);
  }

  const limited = await request(app)
    .post("/admin-users/login")
    .set("Origin", adminOrigin)
    .send({ username: "synthetic", password: "synthetic" });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers["access-control-allow-origin"], adminOrigin);
});

test("unapproved origins remain rejected without wildcard CORS access", async () => {
  const response = await request(createApp())
    .options("/admin-users/login")
    .set("Origin", "https://attacker.example")
    .set("Access-Control-Request-Method", "POST")
    .set("Access-Control-Request-Headers", "Content-Type, Authorization");

  assert.equal(response.status, 403);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
});

test("both rate limiters explicitly skip OPTIONS", () => {
  const captured = [];
  const app = { use: () => {} };
  const captureRateLimit = (options) => {
    captured.push(options);
    return () => {};
  };

  mountHttpSecurity(app, {
    cors,
    rateLimit: captureRateLimit,
    env: { NODE_ENV: "staging", CORS_ALLOWED_ORIGINS: adminOrigin },
  });

  assert.equal(captured.length, 2);
  assert.equal(captured.every(({ skip }) => skip({ method: "OPTIONS", path: "/admin-users/login" })), true);
  assert.equal(captured[0].skip({ method: "POST", path: "/admin-users/login" }), false);
  assert.equal(captured[1].skip({ method: "POST", path: "/admin-users/login" }), false);
  assert.equal(captured[1].limit, 10);
});
