const test = require("node:test");
const assert = require("node:assert/strict");
const { stripUnapprovedRetailData } = require("../utils/publicProduct");

test("public preview products omit synthetic prices and stock", () => {
  const product = {
    _id: "preview-product",
    name: "Sample phone",
    price: 12345,
    offerPrice: 11000,
    quantity: 5,
    catalogSource: { note: "synthetic review data" },
    isSearchVerified: false,
    createdBy: null,
    toObject() {
      return { ...this, toObject: undefined };
    },
  };
  const result = stripUnapprovedRetailData(product);
  assert.equal(result.name, "Sample phone");
  assert.equal("price" in result, false);
  assert.equal("offerPrice" in result, false);
  assert.equal("quantity" in result, false);
  assert.equal("catalogSource" in result, false);
  assert.equal("isSearchVerified" in result, false);
  assert.equal("createdBy" in result, false);
});

test("public preview product sanitizer does not mutate its input", () => {
  const product = { name: "Sample", price: 10, quantity: 1 };
  const result = stripUnapprovedRetailData(product);
  assert.equal(product.price, 10);
  assert.equal(product.quantity, 1);
  assert.equal("price" in result, false);
  assert.equal("quantity" in result, false);
});
