function parseSupportContent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "Support content is required." };
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  const sortOrder = input.sortOrder === undefined ? 0 : Number(input.sortOrder);
  const isActive = input.isActive === undefined ? false : input.isActive;
  const safeText = (value) => value.length > 0 && !/[<>\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value);
  if (!safeText(title) || title.length > 100) return { error: "Title must be plain text between 1 and 100 characters." };
  if (!safeText(body) || body.length > 4000) return { error: "Help text must be plain text between 1 and 4000 characters." };
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 100000) return { error: "Sort order must be a non-negative integer." };
  if (typeof isActive !== "boolean") return { error: "Published state must be true or false." };
  return { value: { title, body, sortOrder, isActive } };
}

function publicSupportContent(item) {
  return { title: item.title, body: item.body, sortOrder: item.sortOrder };
}

module.exports = { parseSupportContent, publicSupportContent };
