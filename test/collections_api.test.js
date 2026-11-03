const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const Collection = require("../model/collection");
const routes = require("../routes/collection");

const originalFind = Collection.find;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/collections", routes);
  return app;
}

test.afterEach(() => {
  Collection.find = originalFind;
});

test("public collection listing asks only for active collections", async () => {
  let querySeen;
  const collections = [{
    _id: "collection-id",
    title: "Featured phones",
    subtitle: "Selected by our team",
    productIds: [],
    sortOrder: 0,
    isActive: true,
  }];
  Collection.find = (query) => {
    querySeen = query;
    return {
      sort: () => ({ lean: async () => collections }),
    };
  };

  const response = await request(createApp()).get("/collections");

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.deepEqual(querySeen, { isActive: true });
  assert.equal(response.body.data[0].title, "Featured phones");
});

test("collection changes require administrator authentication", async () => {
  const response = await request(createApp())
    .post("/collections")
    .send({ title: "Featured phones", subtitle: "Curated", productIds: [] });

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.success, false);
});
