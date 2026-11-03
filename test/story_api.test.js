const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const express = require("express");
const request = require("supertest");
const mongoose = require("mongoose");
process.env.JWT_SECRET ||= "story-feature-test-secret-not-for-deployment";
process.env.CLOUDINARY_CLOUD_NAME ||= "story-test-cloud";
process.env.CLOUDINARY_API_KEY ||= "story-test-key";
process.env.CLOUDINARY_API_SECRET ||= "story-test-secret";
process.env.STORY_MAX_DURATION_SECONDS ||= "30";
const AdminUser = require("../model/adminUser");
const Story = require("../model/story");
const storyVideo = require("../utils/storyVideo");
const uploadFile = require("../uploadFile");
const { issueAdminToken } = require("../middleware/adminAccess");
const routes = require("../routes/story");

const adminId = new mongoose.Types.ObjectId();
const admin = { _id: adminId, isActive: true, clearanceLevel: "admin" };
const originalAdminFind = AdminUser.findById;
const originalStoryFind = Story.find;
const originalStoryFindById = Story.findById;
const originalStoryDelete = Story.findByIdAndDelete;
const originalStoryCreate = Story.create;
const originalCloudinaryDestroy = uploadFile.cloudinary.uploader.destroy;
const originalVideoProbe = storyVideo.probeVideoBuffer;
const originalVideoUpload = storyVideo.uploadAuthenticatedVideo;

function app() {
  const server = express();
  server.use(express.json());
  server.use("/stories", routes);
  server.use(require("../middleware/errorHandler"));
  return server;
}
const authorization = `Bearer ${issueAdminToken(admin)}`;

test.before(() => { AdminUser.findById = async () => admin; });
test.afterEach(() => {
  Story.find = originalStoryFind;
  Story.findById = originalStoryFindById;
  Story.findByIdAndDelete = originalStoryDelete;
  Story.create = originalStoryCreate;
  uploadFile.cloudinary.uploader.destroy = originalCloudinaryDestroy;
  storyVideo.probeVideoBuffer = originalVideoProbe;
  storyVideo.uploadAuthenticatedVideo = originalVideoUpload;
});
test.after(() => { AdminUser.findById = originalAdminFind; });

test("public story feed queries only published, active records and allowlists its response", async () => {
  let querySeen;
  const row = {
    _id: new mongoose.Types.ObjectId(), title: "Launch", subtitle: "New arrivals",
    publicId: "yomart/stories/123e4567-e89b-42d3-a456-426614174000", createdBy: adminId,
    format: "mp4", durationSeconds: 5, bytes: 12345, width: 320, height: 568,
    sortOrder: 2, isPublished: true, isActive: true,
  };
  Story.find = (query) => { querySeen = query; return { sort() { return this; }, lean: async () => [row] }; };
  const response = await request(app()).get("/stories/published");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(querySeen, { uploadStatus: "ready", isActive: true, isPublished: true });
  assert.equal(response.body.data.length, 1);
  assert.equal(response.body.data[0].title, "Launch");
  assert.equal(typeof response.body.data[0].playbackUrl, "string");
  assert.equal(response.body.data[0].playbackUrl.startsWith("https://"), true);
  const expirySeconds = Date.parse(response.body.data[0].playbackExpiresAt) / 1000;
  assert.ok(expirySeconds > Date.now() / 1000 + 298 && expirySeconds <= Date.now() / 1000 + 300);
  assert.equal(JSON.stringify(response.body).includes(process.env.CLOUDINARY_API_SECRET), false);
  assert.equal("publicId" in response.body.data[0], false);
  assert.equal("createdBy" in response.body.data[0], false);
  assert.equal("bytes" in response.body.data[0], false);
});

test("admin story management requires an active administrator", async () => {
  Story.find = () => ({ sort() { return this; }, lean: async () => [] });
  assert.equal((await request(app()).get("/stories")).statusCode, 401);
  const id = new mongoose.Types.ObjectId();
  assert.equal((await request(app()).post("/stories")).statusCode, 401);
  assert.equal((await request(app()).put(`/stories/${id}`).send({ title: "No access" })).statusCode, 401);
  assert.equal((await request(app()).delete(`/stories/${id}`)).statusCode, 401);
  const response = await request(app()).get("/stories").set("Authorization", authorization);
  assert.equal(response.statusCode, 200);
});

test("story upload admission limits memory use to one buffered upload at a time", () => {
  const firstReq = new EventEmitter();
  const firstRes = new EventEmitter();
  firstRes.status = () => firstRes;
  firstRes.json = () => firstRes;
  let firstPassed = false;
  routes.reserveStoryUploadSlot(firstReq, firstRes, () => { firstPassed = true; });
  assert.equal(firstPassed, true);

  const secondReq = new EventEmitter();
  const secondRes = new EventEmitter();
  let status;
  secondRes.status = (value) => { status = value; return secondRes; };
  secondRes.json = () => secondRes;
  routes.reserveStoryUploadSlot(secondReq, secondRes, () => assert.fail("second upload must be rejected"));
  assert.equal(status, 429);

  firstRes.emit("finish");
  let retriedPassed = false;
  routes.reserveStoryUploadSlot(secondReq, secondRes, () => { retriedPassed = true; });
  assert.equal(retriedPassed, true);
  secondRes.emit("finish");
});

test("story upload endpoint fails closed when the owner duration policy is missing", async () => {
  const savedDuration = process.env.STORY_MAX_DURATION_SECONDS;
  try {
    for (const invalid of [undefined, "not-a-number", "0", "-1"]) {
      if (invalid === undefined) delete process.env.STORY_MAX_DURATION_SECONDS;
      else process.env.STORY_MAX_DURATION_SECONDS = invalid;
      const response = await request(app()).post("/stories").set("Authorization", authorization);
      assert.equal(response.statusCode, 503);
      assert.match(response.body.message, /STORY_MAX_DURATION_SECONDS/);
    }
  } finally {
    if (savedDuration === undefined) delete process.env.STORY_MAX_DURATION_SECONDS;
    else process.env.STORY_MAX_DURATION_SECONDS = savedDuration;
  }
});

test("story upload rejects a request larger than 10 MiB with HTTP 413", async () => {
  const response = await request(app()).post("/stories").set("Authorization", authorization)
    .field("title", "Oversized upload")
    .attach("video", Buffer.alloc(10 * 1024 * 1024 + 1), { filename: "story.mp4", contentType: "video/mp4" });
  assert.equal(response.statusCode, 413);
  assert.match(response.body.message, /10 MiB/);
});

test("story multipart parser rejects excess form fields with a controlled 4xx", async () => {
  const response = await request(app()).post("/stories").set("Authorization", authorization)
    .field("title", "Story")
    .field("subtitle", "Short")
    .field("sortOrder", "0")
    .field("unexpected", "not accepted");
  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /could not be parsed/i);
});

test("metadata validation rejects invalid titles, publication values, and sort order", () => {
  assert.equal(routes.parseStoryMetadata({ title: "  ", isPublished: true }).error != null, true);
  assert.equal(routes.parseStoryMetadata({ title: "Story", isPublished: "true" }).error != null, true);
  assert.equal(routes.parseStoryMetadata({ title: "Story", sortOrder: -1 }).error != null, true);
  assert.deepEqual(routes.parseStoryMetadata({ title: "  Story  ", subtitle: "  New  " }).value, { title: "Story", subtitle: "New" });
});

test("admins can unpublish a story without deleting it", async () => {
  const story = {
    _id: new mongoose.Types.ObjectId(), publicId: "yomart/stories/123e4567-e89b-42d3-a456-426614174001",
    createdBy: adminId, title: "Campaign", subtitle: "", isPublished: true,
    isActive: true, sortOrder: 0, uploadStatus: "ready", save: async () => {},
  };
  Story.findById = async () => story;
  const response = await request(app()).put(`/stories/${story._id}`)
    .set("Authorization", authorization).send({ isPublished: false });
  assert.equal(response.statusCode, 200);
  assert.equal(story.isPublished, false);
  assert.equal(response.body.data.isPublished, false);
});

test("an admin cannot edit a story owned by another moderator", async () => {
  const id = new mongoose.Types.ObjectId();
  Story.findById = async () => ({ _id: id, createdBy: new mongoose.Types.ObjectId() });
  const response = await request(app()).put(`/stories/${id}`)
    .set("Authorization", authorization).send({ isPublished: true });
  assert.equal(response.statusCode, 403);
});

test("stories cannot be edited while upload or cleanup is incomplete", async () => {
  const id = new mongoose.Types.ObjectId();
  let saved = false;
  Story.findById = async () => ({
    _id: id,
    createdBy: adminId,
    uploadStatus: "cleanup_pending",
    save: async () => { saved = true; },
  });
  const response = await request(app()).put(`/stories/${id}`)
    .set("Authorization", authorization).send({ title: "Changed" });
  assert.equal(response.statusCode, 409);
  assert.equal(saved, false);
});

test("malformed video bytes with a valid-looking MP4 name and MIME are rejected", async () => {
  const response = await request(app()).post("/stories").set("Authorization", authorization)
    .field("title", "Bad upload")
    .attach("video", Buffer.from("not a video"), { filename: "story.mp4", contentType: "video/mp4" });
  assert.equal(response.statusCode, 400);
  assert.match(response.body.message, /valid supported video/i);
});

test("provider upload failure returns a safe error and retains an unpublished cleanup record", async () => {
  const row = {
    _id: new mongoose.Types.ObjectId(),
    save: async () => {},
  };
  Story.create = async (values) => Object.assign(row, values);
  storyVideo.probeVideoBuffer = async () => ({ format: "mp4", durationSeconds: 5, width: 320, height: 568 });
  storyVideo.uploadAuthenticatedVideo = async () => { throw new Error("synthetic quota failure"); };

  const response = await request(app()).post("/stories").set("Authorization", authorization)
    .field("title", "Temporary failure")
    .attach("video", Buffer.from("synthetic bytes"), { filename: "story.mp4", contentType: "video/mp4" });

  assert.equal(response.statusCode, 502);
  assert.match(response.body.message, /network or quota limit/i);
  assert.equal(row.uploadStatus, "cleanup_pending");
  assert.equal(row.isPublished, false);
  assert.equal(row.isActive, false);
});

test("story deletion keeps the record when the provider fails so deletion can be retried", async () => {
  const row = { _id: new mongoose.Types.ObjectId(), publicId: "yomart/stories/123e4567-e89b-42d3-a456-426614174002", createdBy: adminId, save: async () => {} };
  Story.findById = async () => row;
  let databaseDeleted = false;
  Story.findByIdAndDelete = async () => { databaseDeleted = true; };
  uploadFile.cloudinary.uploader.destroy = async () => { throw new Error("provider quota or network error"); };
  const response = await request(app()).delete(`/stories/${row._id}`).set("Authorization", authorization);
  assert.equal(response.statusCode, 502);
  assert.equal(databaseDeleted, false);
});

test("a story cannot be deleted while its provider upload is still active", async () => {
  const row = { _id: new mongoose.Types.ObjectId(), publicId: "yomart/stories/123e4567-e89b-42d3-a456-426614174004", createdBy: adminId, uploadStatus: "uploading", save: async () => assert.fail("active story must not be mutated") };
  Story.findById = async () => row;
  let providerCalled = false;
  uploadFile.cloudinary.uploader.destroy = async () => { providerCalled = true; return { result: "ok" }; };
  const release = routes.markStoryUploadActive(row._id);
  try {
    const response = await request(app()).delete(`/stories/${row._id}`).set("Authorization", authorization);
    assert.equal(response.statusCode, 409);
    assert.equal(providerCalled, false);
  } finally {
    release();
  }
});

test("story deletion removes the asset before removing its database record", async () => {
  const row = { _id: new mongoose.Types.ObjectId(), publicId: "yomart/stories/123e4567-e89b-42d3-a456-426614174003", createdBy: adminId, save: async () => {} };
  Story.findById = async () => row;
  let order = [];
  uploadFile.cloudinary.uploader.destroy = async (id, options) => { order.push(["provider", id, options.resource_type, options.type]); return { result: "ok" }; };
  Story.findByIdAndDelete = async () => { order.push(["database"]); };
  const response = await request(app()).delete(`/stories/${row._id}`).set("Authorization", authorization);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(order, [["provider", row.publicId, "video", "authenticated"], ["database"]]);
});
