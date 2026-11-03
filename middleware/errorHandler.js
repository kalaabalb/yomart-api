const errorHandler = (error, req, res, next) => {
  const isPaymentProofRoute =
    req.path.startsWith("/payment/upload-proof") ||
    req.path.startsWith("/payment/proofs/");
  const isOrderProofRoute = /\/payment-proof(?:\/|$)/.test(req.path);
  const isSensitiveProofRequest = isPaymentProofRoute || isOrderProofRoute;
  const safeName = typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name) ? error.name : "Error";
  const safeCode = typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code)
    ? error.code
    : Number.isSafeInteger(error?.code) ? error.code : undefined;
  // Never log raw exceptions: driver/provider errors can carry URLs, credentials,
  // document contents, or customer supplied fields.
  console.error(isSensitiveProofRequest ? "Payment-proof request failed." : "API request failed.", {
    name: safeName,
    ...(safeCode === undefined ? {} : { code: safeCode }),
  });

  if (isPaymentProofRoute) {
    const isPaymentProofUpload = req.path.startsWith("/payment/upload-proof");
    const tooLarge =
      error.code === "LIMIT_FILE_SIZE" || error.type === "entity.too.large";
    const malformedUpload =
      isPaymentProofUpload &&
      (error.statusCode === 400 ||
        error.type === "entity.parse.failed" ||
        error.name === "MulterError" ||
        /multipart|boundary|unexpected end of form/i.test(error.message || ""));
    const status = tooLarge
      ? 413
      : malformedUpload || error.statusCode === 400
        ? 400
        : error.statusCode === 503
          ? 503
          : 500;
    return res.status(status).json({
      success: false,
      message: status === 413
        ? "Payment proof images must be 10 MB or smaller."
        : status === 400
          ? "Choose a supported JPG, PNG, or WebP image."
          : "Could not process the payment proof. Please try again.",
    });
  }

  if (isOrderProofRoute) {
    const status = Number.isInteger(error.statusCode || error.status) && (error.statusCode || error.status) >= 400 && (error.statusCode || error.status) < 600
      ? error.statusCode || error.status
      : 500;
    return res.status(status).json({
      success: false,
      message: status >= 500
        ? "Could not process the payment-proof request. Please try again."
        : status === 404
          ? "The requested record was not found."
          : status === 409
            ? "The request conflicts with the current payment-proof state."
            : status === 401
              ? "Authentication is required to complete this request."
              : status === 403
                ? "You are not authorized to complete this request."
                : "The payment-proof request is invalid.",
    });
  }

  if (error.message === "Not allowed by CORS") {
    return res.status(403).json({
      success: false,
      message: "CORS policy: Origin not allowed",
    });
  }

  if (error.statusCode === 429) {
    return res.status(429).json({
      success: false,
      message: "Too many requests, please try again later.",
    });
  }

  if (error.code === 11000) {
    const field = Object.keys(error.keyValue)[0];
    return res.status(400).json({
      success: false,
      message: `${field} already exists`,
    });
  }

  if (error.name === "ValidationError") {
    const errors = Object.values(error.errors).map((err) => err.message);
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors,
    });
  }

  const status = error.statusCode || error.status || 500;
  res.status(status).json({
    success: false,
    message:
      status >= 500
        ? "Internal server error. Please try again later."
        : error.message || "Internal server error",
  });
};

module.exports = errorHandler;
