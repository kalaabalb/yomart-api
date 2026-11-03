const STARTUP_NO_WRITE_FLAG = "YOMART_STARTUP_NO_WRITES";

function configureStartupSafety(mongoose, env = process.env) {
  const configured = env[STARTUP_NO_WRITE_FLAG];
  if (configured !== undefined && !["true", "false"].includes(String(configured).toLowerCase())) {
    throw new Error(`${STARTUP_NO_WRITE_FLAG} must be set to true or false when provided.`);
  }

  const noWriteStartup = String(configured).toLowerCase() === "true";
  if (noWriteStartup) {
    // Configure Mongoose before any model is compiled or a connection is opened.
    mongoose.set("autoCreate", false);
    mongoose.set("autoIndex", false);
  }

  return Object.freeze({
    noWriteStartup,
    autoCreate: noWriteStartup ? false : undefined,
    autoIndex: noWriteStartup ? false : undefined,
    shouldBootstrapAdmin: !noWriteStartup,
  });
}

async function runAdminBootstrap(policy, bootstrap) {
  if (!policy.shouldBootstrapAdmin) return "skipped";
  await bootstrap();
  return "completed";
}

module.exports = {
  STARTUP_NO_WRITE_FLAG,
  configureStartupSafety,
  runAdminBootstrap,
};
