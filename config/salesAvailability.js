const { isProductionLike } = require("./environment");

/**
 * Sales are opt-in in staging/production. Local development keeps the
 * historical enabled default so developers can exercise checkout safely.
 */
function areSalesEnabled(env = process.env) {
  const configured = env.YOMART_SALES_ENABLED;
  if (configured === undefined) return !isProductionLike(env);
  if (configured !== "true" && configured !== "false") {
    throw new Error("YOMART_SALES_ENABLED must be set to true or false when provided.");
  }
  return configured === "true";
}

module.exports = { areSalesEnabled };
