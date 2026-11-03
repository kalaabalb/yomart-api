const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const SAFE_ERROR_CODE = /^[A-Z0-9_]{1,40}$/;

function safeErrorMetadata(error) {
  const name = typeof error?.name === "string" && SAFE_ERROR_NAME.test(error.name)
    ? error.name
    : "Error";
  const code = typeof error?.code === "string" && SAFE_ERROR_CODE.test(error.code)
    ? error.code
    : Number.isSafeInteger(error?.code)
      ? error.code
      : undefined;

  return {
    name,
    ...(code === undefined ? {} : { code }),
  };
}

function logSafeError(context, error) {
  console.error(context, safeErrorMetadata(error));
}

module.exports = logSafeError;
module.exports.safeErrorMetadata = safeErrorMetadata;
