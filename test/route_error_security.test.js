const test = require("node:test");
const assert = require("node:assert/strict");
const sendRouteError = require("../utils/sendRouteError");

function responseCapture() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("production API errors do not expose internal failure details", () => {
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const response = responseCapture();

  sendRouteError(response, new Error("mongodb://private-host/internal-detail"));

  assert.equal(response.statusCode, 500);
  assert.equal(response.body.message, "Internal server error. Please try again later.");
  assert.equal(response.body.message.includes("private-host"), false);

  if (previousEnvironment === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousEnvironment;
});

test("payment-proof route errors redact provider URLs and secrets from responses and logs", () => {
  const previousEnvironment = process.env.NODE_ENV;
  const originalConsoleError = console.error;
  const logLines = [];
  console.error = (...parts) => logLines.push(parts.map((part) => typeof part === "string" ? part : JSON.stringify(part)).join(" "));
  process.env.NODE_ENV = "development";
  const response = responseCapture();
  const sensitive = "https://res.cloudinary.com/private-cloud/image/upload?api_secret=synthetic-secret";
  try {
    sendRouteError(response, Object.assign(new Error(sensitive), { statusCode: 502, code: "ECONNRESET" }), { safeResponse: true });
  } finally {
    console.error = originalConsoleError;
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
  }

  assert.equal(response.statusCode, 502);
  assert.equal(JSON.stringify(response.body).includes(sensitive), false);
  assert.equal(logLines.join("\n").includes(sensitive), false);
  assert.equal(logLines.join("\n").includes("synthetic-secret"), false);
  assert.match(logLines.join("\n"), /ECONNRESET/);
});

test("global error middleware sanitizes payment-proof order errors in development", async () => {
  const express = require("express");
  const request = require("supertest");
  const errorHandler = require("../middleware/errorHandler");
  const originalConsoleError = console.error;
  const logLines = [];
  console.error = (...parts) => logLines.push(parts.map((part) => typeof part === "string" ? part : JSON.stringify(part)).join(" "));
  const app = express();
  app.get("/orders/:id/payment-proof", (_req, _res, next) => {
    next(new Error("https://res.cloudinary.com/private-cloud/receipt?signature=synthetic-signature"));
  });
  app.use(errorHandler);
  try {
    const response = await request(app).get("/orders/order-test/payment-proof");
    assert.equal(response.statusCode, 500);
    assert.equal(JSON.stringify(response.body).includes("private-cloud"), false);
    assert.equal(logLines.join("\n").includes("synthetic-signature"), false);
    assert.match(logLines.join("\n"), /Payment-proof request failed/);
  } finally {
    console.error = originalConsoleError;
  }
});

test("upload size errors return HTTP 413", () => {
  const response = responseCapture();
  sendRouteError(response, Object.assign(new Error("File too large"), {
    name: "MulterError",
    code: "LIMIT_FILE_SIZE",
  }));

  assert.equal(response.statusCode, 413);
});
