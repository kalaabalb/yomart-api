const TYPES = Object.freeze(["phone", "telegram", "whatsapp", "email", "website", "other"]);
const PLACEMENTS = Object.freeze(["product_details", "support_page", "storefront_footer", "all"]);

function normalizeAndValidateContact(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "A contact entry is required." };
  const label = typeof input.label === "string" ? input.label.trim() : "";
  const description = input.description === undefined ? "" : input.description;
  const type = input.type;
  const placement = input.placement ?? "all";
  const displayOrder = input.displayOrder ?? 0;
  const isActive = input.isActive ?? true;
  if (!label || label.length > 80) return { error: "A label between 1 and 80 characters is required." };
  if (typeof description !== "string" || description.length > 240) return { error: "Description must be 240 characters or fewer." };
  if (!TYPES.includes(type)) return { error: "Choose a supported contact type." };
  if (!PLACEMENTS.includes(placement)) return { error: "Choose a supported contact placement." };
  if (!Number.isInteger(Number(displayOrder)) || Number(displayOrder) < 0 || Number(displayOrder) > 100000) return { error: "Display order must be a non-negative integer." };
  if (typeof isActive !== "boolean") return { error: "Active state must be true or false." };
  if (typeof input.value !== "string") return { error: "A contact value is required." };
  let value = input.value.trim();
  if (!value || value.length > 500) return { error: "A contact value between 1 and 500 characters is required." };

  if (type === "phone") {
    if (!/^\+?[0-9().\-\s]{5,40}$/.test(value) || value.replace(/\D/g, "").length < 5) return { error: "Enter a valid phone number." };
  } else if (type === "telegram") {
    value = value.replace(/^@/, "");
    if (!/^[A-Za-z0-9_]{5,32}$/.test(value)) return { error: "Enter a valid Telegram username." };
  } else if (type === "whatsapp") {
    const digits = value.replace(/[\s().-]/g, "").replace(/^\+/, "");
    if (!/^\d{8,15}$/.test(digits)) return { error: "Enter a WhatsApp number with 8 to 15 digits." };
    value = digits;
  } else if (type === "email") {
    if (value.length > 254 || !/^[A-Za-z0-9.!#$%&'*+/=_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value)) return { error: "Enter a valid email address." };
  } else {
    let parsed;
    try { parsed = new URL(value); } catch { return { error: "Enter a valid HTTPS URL." }; }
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) return { error: "Contact links must use HTTPS and cannot contain credentials." };
    value = parsed.toString();
  }
  return { value: { label, description: description.trim(), type, value, placement, displayOrder: Number(displayOrder), isActive } };
}

function toPublicContact(contact) {
  const parsed = normalizeAndValidateContact({
    label: contact?.label,
    description: contact?.description || "",
    type: contact?.type,
    value: contact?.value,
    placement: contact?.placement,
    displayOrder: contact?.displayOrder,
    isActive: true,
  });
  if (parsed.error) return null;
  contact = parsed.value;
  const base = {
    label: contact.label,
    description: contact.description || "",
    type: contact.type,
    value: contact.value,
    placement: contact.placement,
    displayOrder: contact.displayOrder,
  };
  const href = contact.type === "phone" ? `tel:${contact.value.replace(/[().\-\s]/g, "")}`
    : contact.type === "telegram" ? `https://t.me/${encodeURIComponent(contact.value)}`
      : contact.type === "whatsapp" ? `https://wa.me/${encodeURIComponent(contact.value)}`
        : contact.type === "email" ? `mailto:${contact.value}`
          : contact.value;
  return { ...base, href };
}

module.exports = { TYPES, PLACEMENTS, normalizeAndValidateContact, toPublicContact };
