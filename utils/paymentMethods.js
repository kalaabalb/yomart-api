const CATEGORIES = Object.freeze(["cash_collection", "bank_transfer", "mobile_wallet", "other"]);
const PAYMENT_METHOD_CODE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,79}$/;

function cleanText(value, maxLength) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value.trim().slice(0, maxLength) : null;
}

function normalizePaymentMethod(input, { code, allowMissingCode = false, allowLegacy = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "A payment method is required." };
  const methodCode = code || input.code;
  if (!allowMissingCode && (typeof methodCode !== "string" || !PAYMENT_METHOD_CODE.test(methodCode))) {
    return { error: "A valid payment method identifier is required." };
  }
  if (methodCode && !PAYMENT_METHOD_CODE.test(methodCode)) return { error: "A valid payment method identifier is required." };

  const name = cleanText(input.name ?? input.title, 80);
  const description = cleanText(input.description ?? input.subtitle, 240);
  const category = input.category || legacyCategory(methodCode);
  const providerName = cleanText(input.providerName, 100);
  const accountHolder = cleanText(input.accountHolder, 120);
  const accountIdentifier = cleanText(input.accountIdentifier, 160);
  const additionalDetails = cleanText(input.additionalDetails, 500);
  const instructions = cleanText(input.instructions, 500);
  const logoUrl = cleanText(input.logoUrl, 500);
  const enabled = input.enabled === undefined ? false : input.enabled;
  const requiresProof = input.requiresProof === undefined
    ? category !== "cash_collection"
    : input.requiresProof;
  const displayOrder = input.displayOrder === undefined ? 0 : Number(input.displayOrder);

  if (!name || name.length > 80) return { error: "A payment method name is required." };
  if ([description, providerName, accountHolder, accountIdentifier, additionalDetails, instructions, logoUrl].includes(null)) {
    return { error: "Payment method details must be text." };
  }
  if (!CATEGORIES.includes(category)) return { error: "Choose a supported payment category." };
  if (typeof enabled !== "boolean" || typeof requiresProof !== "boolean") return { error: "Active and proof-required settings must be true or false." };
  if (!Number.isInteger(displayOrder) || displayOrder < 0 || displayOrder > 100000) return { error: "Display order must be a non-negative integer." };
  if (logoUrl) {
    let parsed;
    try { parsed = new URL(logoUrl); } catch { return { error: "Logo must use a valid HTTPS URL." }; }
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
      return { error: "Logo must use HTTPS and cannot contain credentials." };
    }
  }
  if (!allowLegacy && category === "cash_collection") {
    if (requiresProof) return { error: "Cash on collection cannot require payment proof." };
    if (providerName || accountHolder || accountIdentifier) return { error: "Cash on collection cannot include bank or wallet account details." };
  }
  if (!allowLegacy && category === "bank_transfer" && (!providerName || !accountIdentifier)) {
    return { error: "Bank transfers require a provider name and account identifier." };
  }
  if (!allowLegacy && category === "mobile_wallet" && !accountIdentifier) {
    return { error: "Mobile wallet methods require an account or wallet identifier." };
  }
  if (!allowLegacy && category === "other" && !instructions && !accountIdentifier && !additionalDetails) {
    return { error: "Provide instructions or payment details for this method." };
  }

  const value = {
    ...(methodCode ? { code: methodCode } : {}),
    name,
    title: name,
    description,
    subtitle: description,
    category,
    logoUrl,
    providerName,
    accountHolder,
    accountIdentifier,
    additionalDetails,
    instructions,
    requiresProof,
    enabled,
    displayOrder,
  };
  return { value };
}

function legacyCategory(code) {
  if (code === "cod") return "cash_collection";
  if (code === "cbe") return "bank_transfer";
  if (code === "telebirr") return "mobile_wallet";
  return "other";
}

function paymentMethodSnapshot(method) {
  const source = typeof method?.toObject === "function" ? method.toObject({ depopulate: true }) : method;
  const legacy = !source?.category;
  const normalized = normalizePaymentMethod({
    ...source,
    name: source?.name || source?.title,
    description: source?.description ?? source?.subtitle ?? "",
    category: source?.category || legacyCategory(source?.code),
    requiresProof: typeof source?.requiresProof === "boolean"
      ? source.requiresProof
      : source?.code !== "cod",
  }, { code: source?.code, allowLegacy: legacy });
  if (normalized.error) return null;
  const { code, name, description, category, logoUrl, providerName, accountHolder, accountIdentifier, additionalDetails, instructions, requiresProof } = normalized.value;
  return { code, name, description, category, logoUrl, providerName, accountHolder, accountIdentifier, additionalDetails, instructions, requiresProof };
}

function isProofRequired(order) {
  if (typeof order?.paymentMethodSnapshot?.requiresProof === "boolean") return order.paymentMethodSnapshot.requiresProof;
  return Boolean(order?.paymentMethod && order.paymentMethod !== "cod");
}

function isCashCollection(order) {
  if (order?.paymentMethodSnapshot?.category) return order.paymentMethodSnapshot.category === "cash_collection";
  return order?.paymentMethod === "cod";
}

function toCustomerPaymentMethod(method) {
  const snapshot = paymentMethodSnapshot(method);
  if (!snapshot) return null;
  return {
    ...snapshot,
    // Compatibility aliases for older Flutter/client builds.
    title: snapshot.name,
    subtitle: snapshot.description,
    enabled: true,
  };
}

module.exports = {
  CATEGORIES,
  PAYMENT_METHOD_CODE,
  normalizePaymentMethod,
  paymentMethodSnapshot,
  isProofRequired,
  isCashCollection,
  toCustomerPaymentMethod,
};
