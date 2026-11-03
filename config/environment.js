const PRODUCTION_LIKE_ENVIRONMENTS = new Set(["staging", "production"]);

function isProductionLike(env = process.env) {
  return PRODUCTION_LIKE_ENVIRONMENTS.has(env.NODE_ENV);
}

module.exports = { isProductionLike };
