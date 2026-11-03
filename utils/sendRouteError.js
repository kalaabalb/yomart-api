const { isProductionLike } = require("../config/environment");

function safeErrorMetadata(error) {
  const name = typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)
    ? error.name
    : "Error";
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code)
    ? error.code
    : Number.isSafeInteger(error?.code) ? error.code : undefined;
  return { name, ...(code === undefined ? {} : { code }) };
}

function sendRouteError(res, error, { safeResponse = false } = {}) {
  // Error messages/stacks can contain user data, provider URLs, and credentials.
  // Record only bounded metadata so these details never enter routine logs.
  console.error("Route request failed.", safeErrorMetadata(error));

  let status = error.statusCode || error.status || 500;
  let message = safeResponse ? "Request could not be completed." : error.message || "Internal server error";
  let errors;

  if (error.code === 11000) {
    status = 409;
    const field = Object.keys(error.keyValue || {})[0];
    message = safeResponse
      ? "A conflicting record already exists."
      : field ? `${field} already exists` : "A record with these details already exists.";
  } else if (error.name === "ValidationError") {
    status = 400;
    message = safeResponse ? "The submitted data is invalid." : "Validation failed";
    if (!safeResponse) errors = Object.values(error.errors || {}).map((item) => item.message);
  } else if (error.name === "CastError") {
    status = 400;
    message = safeResponse ? "The submitted identifier is invalid." : "Invalid identifier";
  } else if (error.name === "MulterError") {
    status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    message = status === 413 ? "Payment proof images must be 10 MB or smaller." : "Choose a supported JPG, PNG, or WebP image.";
  } else if (safeResponse && status === 404) {
    message = "The requested record was not found.";
  } else if (safeResponse && status === 409) {
    message = "The request conflicts with the current payment-proof state.";
  } else if (safeResponse && status === 401) {
    message = "Authentication is required to complete this request.";
  } else if (safeResponse && status === 403) {
    message = "You are not authorized to complete this request.";
  } else if (safeResponse && status === 400) {
    message = "The payment-proof request is invalid.";
  } else if (safeResponse) {
    status = status >= 400 && status < 600 ? status : 500;
    message = "Could not process the payment-proof request. Please try again.";
  }

  if ((safeResponse || isProductionLike()) && status >= 500) {
    message = "Internal server error. Please try again later.";
    errors = undefined;
  }

  return res.status(status).json({
    success: false,
    message,
    ...(errors ? { errors } : {}),
  });
}

module.exports = sendRouteError;
module.exports.safeErrorMetadata = safeErrorMetadata;
