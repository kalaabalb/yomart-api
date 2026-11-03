const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const Category = require("../model/category");
const Brand = require("../model/brand");
const Poster = require("../model/poster");
const categoryRoutes = require("../routes/category");
const brandRoutes = require("../routes/brand");
const posterRoutes = require("../routes/poster");

const originals = {
  categoryFind: Category.find,
  brandFind: Brand.find,
  posterFind: Poster.find,
};

test.afterEach(() => {
  Category.find = originals.categoryFind;
  Brand.find = originals.brandFind;
  Poster.find = originals.posterFind;
});

test("public category, brand, and poster feeds honor admin visibility and order", async () => {
  const seen = {};
  Category.find = (query) => {
    seen.categoryQuery = query;
    return { sort: async (sort) => { seen.categorySort = sort; return []; } };
  };
  Brand.find = (query) => {
    seen.brandQuery = query;
    return {
      populate() { return this; },
      sort: async (sort) => { seen.brandSort = sort; return []; },
    };
  };
  Poster.find = (query) => {
    seen.posterQuery = query;
    return { sort: async (sort) => { seen.posterSort = sort; return []; } };
  };

  const app = express();
  app.use("/categories", categoryRoutes);
  app.use("/brands", brandRoutes);
  app.use("/posters", posterRoutes);
  assert.equal((await request(app).get("/categories")).statusCode, 200);
  assert.equal((await request(app).get("/brands")).statusCode, 200);
  assert.equal((await request(app).get("/posters")).statusCode, 200);

  assert.deepEqual(seen.categoryQuery, { isActive: { $ne: false } });
  assert.deepEqual(seen.brandQuery, { isActive: { $ne: false } });
  assert.deepEqual(seen.posterQuery, { isActive: { $ne: false } });
  assert.deepEqual(seen.categorySort, { sortOrder: 1, name: 1 });
  assert.deepEqual(seen.brandSort, { sortOrder: 1, name: 1 });
  assert.deepEqual(seen.posterSort, { sortOrder: 1, createdAt: -1 });
});
