const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const Product = require("../model/product");
const productRoutes = require("../routes/product");

const originalFind = Product.find;

test.afterEach(() => {
  Product.find = originalFind;
});

test("public catalog reads exclude products disabled by an admin", async () => {
  let filter;
  Product.find = (query) => {
    filter = query;
    const result = {
      populate() {
        return this;
      },
      sort: async () => [],
    };
    return result;
  };

  const app = express();
  app.use("/products", productRoutes);
  const response = await request(app).get("/products");

  assert.equal(response.statusCode, 200);
  assert.deepEqual(filter, { isActive: { $ne: false } });
});

test("new products stay out of search until an admin verifies them", () => {
  const product = new Product({ name: "Example phone", price: 100, quantity: 1 });

  assert.equal(product.isSearchVerified, false);
});
