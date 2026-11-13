const dotenv = require("dotenv");
dotenv.config();

const mongoose = require("mongoose");
const { configureStartupSafety, runAdminBootstrap } = require("./config/startupSafety");
const startupSafety = configureStartupSafety(mongoose, process.env);

const express = require("express");
const cors = require("cors");
const asyncHandler = require("express-async-handler");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const mountHttpSecurity = require("./config/httpSecurity");
const { isProductionLike } = require("./config/environment");
const { APP_VERSION } = require("./config/app");
const logSafeError = require("./utils/logSafeError");
const requestLogger = require("./middleware/requestLogger");
const notFound = require("./middleware/notFound");
const errorHandler = require("./middleware/errorHandler");

const {
  validateUploadStorageRoots,
  createPublicUploadHandler,
} = require("./uploadFile");
// Validate canonical filesystem locations before opening the DB or accepting
// requests. Public and private roots may not overlap through symlinks either.
validateUploadStorageRoots();

const app = express();
// Render terminates TLS at one trusted proxy. Let Express derive req.ip from
// that hop instead of trusting the caller-controlled X-Forwarded-For header.
app.set("trust proxy", 1);

// Development retains its existing origin behavior. Staging and production
// require exact HTTPS origins; CORS also runs before request limits so browser
// preflights and limited responses receive the appropriate CORS headers.
mountHttpSecurity(app, { cors, rateLimit });

// Security headers
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    // API and uploaded media responses can use Helmet's default CSP in
    // production. Keep local development flexible for browser tooling.
    contentSecurityPolicy:
      isProductionLike() ? undefined : false,
    crossOriginEmbedderPolicy: false,
  }),
);

// Body parsing middleware
app.use(
  express.json({
    limit: "1mb",
    // Payment proof base64 payloads have a dedicated authenticated parser and
    // upload rate limit in routes/payment.js; keep the general JSON limit small.
    type: (req) =>
      req.path !== "/payment/upload-proof-base64" &&
      /^application\/(?:json|[^;]+\+json)(?:;|$)/i.test(
        req.headers["content-type"] || "",
      ),
  }),
);
app.use(
  express.urlencoded({ extended: false, limit: "1mb", parameterLimit: 100 }),
);

// MongoDB connection
mongoose.set("strictQuery", true);

const connectDB = async () => {
  try {
    const mongoUrl = process.env.MONGO_URL;

    if (!mongoUrl) {
      console.error("❌ MONGO_URL environment variable is missing");
      if (isProductionLike()) {
        process.exit(1);
      }
      return;
    }

    await mongoose.connect(mongoUrl, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
      ...(startupSafety.noWriteStartup ? { autoCreate: false, autoIndex: false } : {}),
    });
    console.log("✅ Connected to MongoDB");
  } catch (error) {
    logSafeError("❌ Database connection failed:", error);
    process.exit(1);
  }
};

connectDB();

const db = mongoose.connection;
db.on("error", (error) => {
  logSafeError("❌ MongoDB connection error:", error);
});
db.on("disconnected", () => {
  console.log("⚠️ MongoDB disconnected");
});
db.on("reconnected", () => {
  console.log("✅ MongoDB reconnected");
});

app.use(requestLogger);
// Serve only allowlisted public catalog folders through a canonical, no-follow
// file handler. Payment proofs and unknown upload folders are never static.
app.use("/uploads", createPublicUploadHandler());

// Routes
app.use("/categories", require("./routes/category"));
app.use("/subCategories", require("./routes/subCategory"));
app.use("/brands", require("./routes/brand"));
app.use("/variantTypes", require("./routes/variantType"));
app.use("/variants", require("./routes/variant"));
app.use("/products", require("./routes/product"));
app.use("/posters", require("./routes/poster"));
app.use("/stories", require("./routes/story"));
app.use("/collections", require("./routes/collection"));
app.use("/store-settings", require("./routes/storeSettings"));
app.use("/retailer-contacts", require("./routes/retailerContacts"));
app.use("/support-content", require("./routes/supportContent"));
app.use("/users", require("./routes/user"));
app.use("/admin-users", require("./routes/adminUser"));
app.use("/orders", require("./routes/order"));
app.use("/payment", require("./routes/payment"));
app.use("/notification", require("./routes/notification"));
app.use("/ratings", require("./routes/rating"));

// Health check route
app.get(
  "/health",
  asyncHandler(async (req, res) => {
    const databaseReady = mongoose.connection.readyState === 1;
    const dbStatus = databaseReady ? "connected" : "disconnected";
    const cloudinaryReady = Boolean(
      process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET,
    );
    const persistentUploadsReady =
      !isProductionLike() ||
      cloudinaryReady ||
      Boolean(process.env.UPLOADS_DIR);
    const privateProofsReady =
      !isProductionLike() ||
      cloudinaryReady ||
      Boolean(process.env.PAYMENT_PROOFS_DIR);
    const serviceReady = databaseReady && persistentUploadsReady && privateProofsReady;

    res.status(serviceReady ? 200 : 503).json({
      success: serviceReady,
      message: !databaseReady
        ? "Database is unavailable"
        : !persistentUploadsReady
          ? "Production image storage is not configured"
          : !privateProofsReady
            ? "Private payment proof storage is not configured"
            : "API is healthy",
      data: {
        timestamp: new Date().toISOString(),
        database: dbStatus,
        imageStorage: cloudinaryReady
          ? "cloudinary"
          : process.env.UPLOADS_DIR
            ? "persistent-volume"
            : "local",
        privatePaymentProofStorage: cloudinaryReady
          ? "cloudinary-authenticated"
          : process.env.PAYMENT_PROOFS_DIR
            ? "persistent-private-volume"
            : "local-unconfigured",
        environment: process.env.NODE_ENV || "development",
        platform: process.env.PLATFORM || (process.env.NODE_ENV === "production" ? "Production" : process.env.NODE_ENV === "staging" ? "Staging" : "Local"),
        version: APP_VERSION,
      },
    });
  }),
);

// Test route
app.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json({
      success: true,
      message: "API is running",
      data: {
        version: APP_VERSION,
        environment: process.env.NODE_ENV || "development",
        database:
          mongoose.connection.readyState === 1 ? "connected" : "disconnected",
        timestamp: new Date().toISOString(),
      },
    });
  }),
);

// Initialize database connection
db.once("open", async () => {
  try {
    console.log("✅ Connected to Database");
    const bootstrapResult = await runAdminBootstrap(
      startupSafety,
      () => require("./utils/ensureDefaultAdminUser")(),
    );
    if (bootstrapResult === "skipped") {
      console.log("🛡️ Startup no-write guard active; admin bootstrap and automatic collection/index creation are disabled.");
    }
  } catch (error) {
    logSafeError("❌ Startup failed:", error);
    process.exit(1);
  }
});

app.use(notFound);
app.use(errorHandler);

// Render port binding
const PORT = process.env.PORT || 3000;

if (!process.env.VERCEL) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`📍 Base URL: http://localhost:${PORT}`);
    console.log(`❤️  Health check: http://localhost:${PORT}/health`);
  });
}

module.exports = app;
