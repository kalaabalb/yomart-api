const DEVELOPMENT_ORIGINS = [
  "http://localhost:*",
  "http://10.161.175.199:*",
  "http://192.168.*:*",
  "http://127.0.0.1:*",
  "http://0.0.0.0:*",
  "http://10.0.2.2:*",
  "*",
];

const { isProductionLike } = require("./environment");

function parseStrictOrigins(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("CORS_ALLOWED_ORIGINS is required in staging and production.");
  }

  const origins = [...new Set(value.split(",").map((entry) => entry.trim()))];
  for (const origin of origins) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch (_) {
      throw new Error("CORS_ALLOWED_ORIGINS must contain exact HTTPS origins only.");
    }
    if (
      parsed.protocol !== "https:" || parsed.origin !== origin ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.pathname !== "/"
    ) {
      throw new Error("CORS_ALLOWED_ORIGINS must contain exact HTTPS origins only.");
    }
  }
  return origins;
}

function createCorsOriginCallback(env = process.env) {
  const environment = env.NODE_ENV || "development";
  const strict = isProductionLike({ NODE_ENV: environment });
  if (!strict && !["development", "test"].includes(environment)) {
    throw new Error("NODE_ENV must be development, test, staging, or production.");
  }
  const origins = strict
    ? parseStrictOrigins(env.CORS_ALLOWED_ORIGINS)
    : DEVELOPMENT_ORIGINS;

  return (origin, callback) => {
    if (!origin) return callback(null, true);
    const allowed = strict
      ? origins.includes(origin)
      : origins.some((pattern) => origin.startsWith(pattern.replace("*", "")));
    if (allowed) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  };
}

module.exports = { createCorsOriginCallback };
