require("dotenv").config();
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const Order = require("../model/order");
const PaymentProof = require("../model/paymentProof");
const { privateProofRoot, inspectPaymentProofAsset } = require("../uploadFile");
const { buildPaymentProofReconciliation } = require("../utils/paymentProofReconciliation");

function parseArgs(args = []) {
  const match = args.filter((arg) => arg.startsWith("--allow-local-db="));
  const unknown = args.filter((arg) => !arg.startsWith("--allow-local-db=") && arg !== "--assume-local-private-storage");
  if (unknown.length || match.length !== 1 || !match[0].slice("--allow-local-db=".length)) {
    throw new Error("Use --allow-local-db=<database-name> and optionally --assume-local-private-storage for a local/test audit.");
  }
  return {
    allowedDatabase: match[0].slice("--allow-local-db=".length),
    assumeLocalPrivateStorage: args.includes("--assume-local-private-storage"),
  };
}

function validateLocalMongoTarget(uriString, allowedDatabase) {
  if (typeof uriString !== "string" || !uriString.startsWith("mongodb://")) {
    throw new Error("The reconciliation audit accepts a loopback mongodb:// target only; remote and SRV databases are refused.");
  }
  let uri;
  try { uri = new URL(uriString); }
  catch (_) { throw new Error("The configured local database URI is invalid."); }
  const hostname = uri.hostname.toLowerCase();
  if (!["127.0.0.1", "[::1]", "::1"].includes(hostname) || uri.host.includes(",")) {
    throw new Error("The reconciliation audit requires a loopback IP literal database host.");
  }
  if (uri.searchParams.has("replicaSet") || uri.searchParams.get("loadBalanced") === "true" || uri.searchParams.get("directConnection") === "false") {
    throw new Error("The reconciliation audit refuses topology options that can redirect a loopback URI to remote database hosts.");
  }
  let database;
  try { database = decodeURIComponent(uri.pathname.replace(/^\//, "")); }
  catch (_) { throw new Error("The configured local database name is invalid."); }
  if (!database || database.includes("/") || database !== allowedDatabase || /(^|[-_])(prod|production|live)([-_]|$)/i.test(database)) {
    throw new Error("The database name must match --allow-local-db and must not identify a production/live database.");
  }
  return database;
}

async function writePrivateReport(report, root = privateProofRoot, now = new Date()) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || await fs.realpath(root) !== root) {
    throw new Error("The private report root is unsafe.");
  }
  await fs.chmod(root, 0o700);
  const reportDirectory = path.join(root, "reconciliation-reports");
  await fs.mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  const reportStat = await fs.lstat(reportDirectory);
  if (reportStat.isSymbolicLink() || !reportStat.isDirectory() || !path.resolve(await fs.realpath(reportDirectory)).startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error("The reconciliation report directory is unsafe.");
  }
  await fs.chmod(reportDirectory, 0o700);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(reportDirectory, `payment-proof-reconciliation-${stamp}-${process.pid}-${crypto.randomUUID()}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await fs.chmod(filePath, 0o600);
  return filePath;
}

async function runAudit({
  env = process.env,
  args = [],
  connect = (url, options) => mongoose.connect(url, options),
  disconnect = () => mongoose.disconnect(),
  models = { Order, PaymentProof },
  inspectAsset,
  writeReport = writePrivateReport,
  logger = console,
  now = () => new Date(),
} = {}) {
  const { allowedDatabase, assumeLocalPrivateStorage } = parseArgs(args);
  const mongoUrl = env.MONGODB_URL || env.MONGO_URL;
  validateLocalMongoTarget(mongoUrl, allowedDatabase);
  await connect(mongoUrl, {
    directConnection: true,
    readPreference: "primaryPreferred",
    autoIndex: false,
    autoCreate: false,
  });
  try {
    const orders = await models.Order.find({
      $or: [
        { paymentMethod: { $in: ["cbe", "telebirr"] } },
        { "paymentProof.storageKey": { $exists: true } },
        { "paymentProof.imageUrl": { $exists: true } },
      ],
    }).select("_id userID paymentMethod paymentProof").lean();
    const proofs = await models.PaymentProof.find({ status: { $in: ["uploaded", "associated", "superseded", "cleanup_pending"] } })
      .select("+storageKey _id ownerId orderId status createdAt supersededAt").lean();
    const assetInspector = inspectAsset || ((reference) => inspectPaymentProofAsset(reference, { assumeLocalPrivateStorage }));
    const report = await buildPaymentProofReconciliation({ orders, proofs, inspectAsset: assetInspector });
    report.limitations.push("Private proof records do not store their storage provider; their assets remain unverified unless --assume-local-private-storage explicitly confirms that this environment stores them locally.");
    report.generatedAt = now().toISOString();
    report.databaseName = allowedDatabase;
    const reportPath = await writeReport(report);
    const sanitizedSummary = {
      reportSaved: true,
      total: report.summary.total,
      byReviewStatus: report.summary.byReviewStatus,
      byKind: report.summary.byKind,
      byAssetStatus: report.summary.byAssetStatus,
      limitations: report.limitations,
    };
    logger.info(JSON.stringify(sanitizedSummary));
    return { ...sanitizedSummary, reportPath };
  } finally {
    await disconnect();
  }
}

if (require.main === module) {
  runAudit({ args: process.argv.slice(2) }).catch((error) => {
    const safeMessage = /^(Use --allow-local-db=|The reconciliation audit accepts |The reconciliation audit requires |The reconciliation audit refuses topology options|The configured local database |The database name must match |The private report )/.test(error.message || "");
    console.error(safeMessage ? error.message : "Payment-proof reconciliation audit failed; verify the local database and private storage configuration.");
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, validateLocalMongoTarget, writePrivateReport, runAudit };
