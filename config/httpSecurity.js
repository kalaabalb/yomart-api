const { createCorsOriginCallback } = require("./cors");
const { isProductionLike } = require("./environment");

/**
 * Mount the shared HTTP origin policy and request limits.
 * CORS must run first so allowed browser origins receive CORS headers even on
 * rate-limited responses. Preflights are excluded explicitly from both limits.
 */
function mountHttpSecurity(app, { cors, rateLimit, env = process.env }) {
  const productionLike = isProductionLike(env);

  app.use(
    cors({
      origin: createCorsOriginCallback(env),
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-Requested-With",
        "Accept",
        "Origin",
        "Idempotency-Key",
      ],
    }),
  );

  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: productionLike ? 600 : 10000,
      message: {
        success: false,
        message: "Too many requests from this IP, please try again later.",
      },
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) =>
        req.method === "OPTIONS" ||
        req.path === "/health" ||
        req.path === "/" ||
        !productionLike,
    }),
  );

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    message: {
      success: false,
      message: "Too many sign-in attempts. Please try again later.",
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === "OPTIONS" || !productionLike,
  });
  app.use(["/users/login", "/users/register", "/admin-users/login"], loginLimiter);

  return { loginLimiter };
}

module.exports = mountHttpSecurity;
