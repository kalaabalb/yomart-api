const passwordPolicyMessage =
  "Use at least 8 characters with upper and lowercase letters, a number, and a symbol.";

function hasStrongPassword(value) {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value) &&
    /\d/.test(value) &&
    /[^A-Za-z0-9]/.test(value)
  );
}

module.exports = { hasStrongPassword, passwordPolicyMessage };
