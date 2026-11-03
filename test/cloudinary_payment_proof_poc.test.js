"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");
const {
  assertCleanupTarget,
  assertTrustedDeliveryUrl,
  executePoc,
  isValidPocPublicId,
  metadataMatchesPoc,
  safeConfigState,
  safeEnvFileState,
  safeErrorCategory,
  resolveRecoveryManifestPath,
  recoveryManifestStatus,
  writeExclusiveRecoveryManifest,
} = require("../scripts/cloudinary_payment_proof_poc");

const TEST_ASSET_ID = "synthetic-asset-id-000000000001";

function fixture({
  failRestriction = false,
  failRestrictionStatus = null,
  ignoreRestriction = false,
  failRestrictedAnonymous = false,
  failRestore = false,
  mismatchRestore = false,
  mismatchUpload = false,
  tamperBeforeRestriction = false,
  tamperBeforeRestore = false,
  tamperBeforeCleanup = false,
  tamperAclBeforeCleanup = false,
  failDelete = false,
} = {}) {
  const png = Buffer.from("synthetic-png-bytes");
  let metadata;
  let deleted = false;
  let anonymousReads = 0;
  let metadataReads = 0;
  const calls = { uploads: [], updates: [], gets: [], deletes: [], events: [], metadataReads: [], requestConfigs: [] };
  const config = { cloud_name: "synthetic-cloud", api_key: "synthetic-key", api_secret: "synthetic-secret" };
  const cloudinary = {
    config(value) {
      if (value) Object.assign(config, value);
      return { ...config };
    },
    utils: {
      base_api_url_v1() {
        return (parts) => `https://api.cloudinary.com/v1_1/synthetic-cloud/${parts.join("/")}`;
      },
      api_url(action) {
        return `https://api.cloudinary.com/v1_1/synthetic-cloud/image/${action}`;
      },
      sign_request(params) {
        return { ...params, api_key: config.api_key, signature: "synthetic-signature" };
      },
    },
    url(publicId, options) {
      const transform = options.transformation ? "c_fill,w_160,h_80/" : "";
      return `https://res.cloudinary.com/synthetic-cloud/image/upload/${transform}${publicId}.${options.format}`;
    },
    api: {
      async resource_by_asset_id(assetId) {
        calls.gets.push(assetId);
        metadataReads += 1;
        calls.metadataReads.push(assetId);
        calls.events.push({ operation: "metadata", assetId });
        if (deleted) throw Object.assign(new Error("suppressed provider error"), { http_code: 404 });
        if (!metadata || assetId !== TEST_ASSET_ID) throw Object.assign(new Error("suppressed provider error"), { http_code: 404 });
        if (tamperBeforeCleanup && metadataReads === 6) metadata.public_id = "catalog/unrelated";
        if (tamperAclBeforeCleanup && metadataReads === 6) metadata.access_control = [{ access_type: "token" }];
        return structuredClone(metadata);
      },
    },
    uploader: {
      async upload(dataUri, options) {
        calls.uploads.push(options);
        calls.events.push({ operation: "upload" });
        assert.match(dataUri, /^data:image\/png;base64,/);
        metadata = {
          asset_id: TEST_ASSET_ID,
          public_id: options.public_id,
          resource_type: options.resource_type,
          type: options.type,
          format: "png",
          version: 1,
          tags: options.tags,
        };
        const response = structuredClone(metadata);
        if (mismatchUpload) response.public_id = "catalog/unrelated";
        return response;
      },
    },
  };
  const axios = {
    async get(url, config) {
      calls.requestConfigs.push(config);
      calls.gets.push(url);
      const parsed = new URL(url);
      if (parsed.hostname === "res.cloudinary.com") {
        anonymousReads += 1;
        calls.events.push({ operation: "anonymous_get" });
        const blocked = Array.isArray(metadata?.access_control) && metadata.access_control.some((entry) => entry.access_type === "token");
        if (tamperBeforeRestriction && !blocked && anonymousReads === 2) metadata.public_id = "catalog/unrelated";
        if (blocked && failRestrictedAnonymous) throw Object.assign(new Error("hidden timeout"), { code: "ETIMEDOUT" });
        return { status: blocked ? 401 : 200, data: Readable.from([]) };
      }
      const expiry = Number(parsed.searchParams.get("expires_at"));
      calls.events.push({ operation: "signed_get" });
      if (tamperBeforeRestore && expiry < Math.floor(Date.now() / 1000)) metadata.public_id = "catalog/unrelated";
      return {
        status: expiry < Math.floor(Date.now() / 1000) ? 401 : 200,
        data: Readable.from([png]),
      };
    },
    async put(url, body, config) {
      calls.requestConfigs.push(config);
      const parsed = new URL(url);
      const exactId = parsed.pathname.split("/").at(-1);
      calls.updates.push({ exactId, body });
      calls.events.push({ operation: "update", assetId: exactId });
      if (failRestriction && body.access_control.length) throw Object.assign(new Error("synthetic-secret signed URL"), { code: "ETIMEDOUT" });
      if (failRestore && body.access_control.length === 0) throw Object.assign(new Error("synthetic-secret signed URL"), { code: "ETIMEDOUT" });
      if (failRestrictionStatus && body.access_control.length) return { status: failRestrictionStatus };
      if (ignoreRestriction && body.access_control.length) return { status: 200 };
      if (!metadata || exactId !== TEST_ASSET_ID) throw new Error("unexpected target");
      metadata.access_control = body.access_control;
      if (mismatchRestore && body.access_control.length === 0) metadata.public_id = "catalog/unrelated";
      return { status: 200 };
    },
    async post(url, body, config) {
      calls.requestConfigs.push(config);
      const parsed = new URL(url);
      const params = new URLSearchParams(body);
      calls.deletes.push({ path: parsed.pathname, assetId: params.get("asset_id"), invalidate: params.get("invalidate") });
      calls.events.push({ operation: "delete", assetId: params.get("asset_id") });
      if (params.get("asset_id") !== TEST_ASSET_ID) throw new Error("unexpected delete target");
      if (failDelete) throw Object.assign(new Error("synthetic-secret signed URL"), { code: "ETIMEDOUT" });
      deleted = true;
      return { status: 200, data: { result: "ok" } };
    },
  };
  const sharp = () => ({ png: () => ({ toBuffer: async () => png }) });
  return { dependencies: { cloudinary, axios, sharp }, calls };
}

async function runPoc(dependencies, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "yomart-cloudinary-run-"));
  const manifestPath = path.join(directory, "recovery.json");
  try {
    const result = await executePoc(dependencies, { ...options, manifestPath });
    const exists = fs.existsSync(manifestPath);
    const manifest = exists ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
    const mode = exists ? fs.statSync(manifestPath).mode & 0o777 : null;
    return { ...result, manifest, manifestMode: mode };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("configuration presence check returns booleans without echoing values", () => {
  const state = safeConfigState({
    CLOUDINARY_CLOUD_NAME: "secret-cloud",
    CLOUDINARY_API_KEY: "secret-key",
    CLOUDINARY_API_SECRET: "secret-value",
  });
  assert.deepEqual(state, {
    CLOUDINARY_CLOUD_NAME: true,
    CLOUDINARY_API_KEY: true,
    CLOUDINARY_API_SECRET: true,
  });
  assert.equal(JSON.stringify(state).includes("secret"), false);
});

test("environment preflight accepts only a private file with unique Cloudinary keys", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "yomart-cloudinary-poc-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, ".env");
  fs.writeFileSync(envPath, "CLOUDINARY_CLOUD_NAME=synthetic\nCLOUDINARY_API_KEY=synthetic\nCLOUDINARY_API_SECRET=synthetic\n", { mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
  assert.deepEqual(safeEnvFileState(envPath), { safeFile: true, uniqueCloudinaryKeys: true, alternateConfigAbsent: true });
  fs.appendFileSync(envPath, "CLOUDINARY_API_SECRET=duplicate\n");
  assert.deepEqual(safeEnvFileState(envPath), { safeFile: true, uniqueCloudinaryKeys: false, alternateConfigAbsent: true });
  fs.appendFileSync(envPath, "CLOUDINARY_URL=cloudinary://hidden\n");
  assert.deepEqual(safeEnvFileState(envPath), { safeFile: true, uniqueCloudinaryKeys: false, alternateConfigAbsent: false });
  fs.chmodSync(envPath, 0o644);
  assert.deepEqual(safeEnvFileState(envPath), { safeFile: false, uniqueCloudinaryKeys: false, alternateConfigAbsent: false });
  const linkPath = path.join(directory, "env-link");
  fs.symlinkSync(envPath, linkPath);
  assert.deepEqual(safeEnvFileState(linkPath), { safeFile: false, uniqueCloudinaryKeys: false, alternateConfigAbsent: false });
});

test("POC ID validator only accepts the one generated namespace and UUID", () => {
  const runId = "01234567-89ab-cdef-0123-456789abcdef";
  assert.equal(isValidPocPublicId(`payment-proofs-poc/poc-${runId}`, runId), true);
  assert.equal(isValidPocPublicId(`payment-proofs/${runId}`, runId), false);
  assert.equal(isValidPocPublicId(`payment-proofs-poc/poc-${runId}-other`, runId), false);
});

test("Cloudinary URL analytics are disabled and delivery validation allows only the documented _a parameter", () => {
  const sdk = require("cloudinary").v2;
  sdk.config({ cloud_name: "synthetic-cloud", api_key: "synthetic-key", api_secret: "synthetic-secret" });
  const publicId = "payment-proofs-poc/poc-01234567-89ab-cdef-0123-456789abcdef";
  const generated = sdk.url(publicId, {
    cloud_name: "synthetic-cloud", secure: true, resource_type: "image", type: "upload", format: "png", urlAnalytics: false,
  });
  const generatedUrl = new URL(generated);
  assert.equal(generatedUrl.search, "");
  assert.equal(assertTrustedDeliveryUrl(generated, "synthetic-cloud", publicId, "png").hostname, "res.cloudinary.com");
  const documentedAnalyticsUrl = new URL(generated);
  documentedAnalyticsUrl.searchParams.set("_a", "sdk-analytics-1");
  assert.doesNotThrow(() => assertTrustedDeliveryUrl(documentedAnalyticsUrl.toString(), "synthetic-cloud", publicId, "png"));
  const unknown = new URL(generated);
  unknown.searchParams.set("redirect", "https://attacker.invalid");
  assert.throws(() => assertTrustedDeliveryUrl(unknown.toString(), "synthetic-cloud", publicId, "png"));
  const invalidAnalytics = new URL(generated);
  invalidAnalytics.searchParams.set("_a", "value with spaces");
  assert.throws(() => assertTrustedDeliveryUrl(invalidAnalytics.toString(), "synthetic-cloud", publicId, "png"));
});

test("recovery manifest path must be explicit, absolute, outside the repository, and non-existing", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "yomart-cloudinary-manifest-path-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, "recovery.json");
  assert.equal(resolveRecoveryManifestPath(manifestPath), manifestPath);
  assert.throws(() => resolveRecoveryManifestPath("relative/recovery.json"), /manifest_path_must_be_absolute/);
  assert.throws(() => resolveRecoveryManifestPath(path.join(__dirname, "inside-repo.json")), /manifest_path_must_be_outside_repository/);
  writeExclusiveRecoveryManifest(manifestPath, { version: 1, status: "upload_in_progress" });
  assert.equal(fs.statSync(manifestPath).mode & 0o777, 0o600);
  assert.equal(recoveryManifestStatus(manifestPath), "present");
  const before = fs.readFileSync(manifestPath, "utf8");
  assert.throws(() => writeExclusiveRecoveryManifest(manifestPath, { version: 1, status: "replacement" }));
  assert.equal(fs.readFileSync(manifestPath, "utf8"), before);
  assert.throws(() => resolveRecoveryManifestPath(manifestPath), /recovery_manifest_already_exists/);
});

test("interrupted verified upload persists exact identity and blocks another upload", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "yomart-cloudinary-interrupted-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, "recovery.json");
  const { dependencies, calls } = fixture({ failRestriction: true });
  const events = [];
  const first = await executePoc({ ...dependencies, output: (event) => events.push(event) }, {
    cleanupAfterSuccess: true,
    manifestPath,
  });
  assert.equal(first.result, "stopped_error");
  assert.equal(calls.uploads.length, 1);
  assert.equal(fs.statSync(manifestPath).mode & 0o777, 0o600);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.status, "uploaded_verified");
  assert.equal(manifest.asset_id, TEST_ASSET_ID);
  assert.match(manifest.public_id, /^payment-proofs-poc\/poc-[a-f0-9-]{36}$/i);
  const serialized = JSON.stringify(manifest).toLowerCase();
  for (const forbidden of ["secret", "signature", "signed_url", "https://", "api_key"]) assert.equal(serialized.includes(forbidden), false);

  const second = await executePoc({ ...dependencies, output: (event) => events.push(event) }, {
    cleanupAfterSuccess: true,
    manifestPath,
  });
  assert.equal(second.result, "stopped_error");
  assert.equal(calls.uploads.length, 1);
  assert.equal(calls.deletes.length, 0);
  assert.ok(events.some((event) => event.category === "previous_recovery_requires_resolution"));
});

test("metadata and cleanup guard require exact synthetic ID, folder, type, and tag", () => {
  const runId = "01234567-89ab-cdef-0123-456789abcdef";
  const expected = {
    runId,
    publicId: `payment-proofs-poc/poc-${runId}`,
    assetId: TEST_ASSET_ID,
    tag: `yomart-synthetic-poc-${runId}`,
  };
  const metadata = {
    asset_id: TEST_ASSET_ID,
    public_id: expected.publicId,
    resource_type: "image",
    type: "upload",
    format: "png",
    tags: [expected.tag],
  };
  assert.equal(metadataMatchesPoc(metadata, expected), true);
  assertCleanupTarget(metadata, expected);
  assert.throws(() => assertCleanupTarget({ ...metadata, public_id: "catalog/real-asset" }, expected));
  assert.throws(() => assertCleanupTarget({ ...metadata, asset_id: "different-id" }, expected));
  assert.throws(() => assertCleanupTarget({ ...metadata, resource_type: "video" }, expected));
  assert.throws(() => assertCleanupTarget({ ...metadata, tags: [] }, expected));
});

test("synthetic run targets exactly one upload, restricts by its asset ID, restores it, and cleans by that ID only", async () => {
  const { dependencies, calls } = fixture();
  const events = [];
  const result = await runPoc({ ...dependencies, output: (event) => events.push(event) }, { cleanupAfterSuccess: true });

  assert.equal(result.result, "complete_and_cleaned");
  assert.equal(result.manifest, null);
  assert.equal(calls.uploads.length, 1);
  assert.match(calls.uploads[0].public_id, /^payment-proofs-poc\/poc-[a-f0-9-]{36}$/i);
  assert.equal(calls.uploads[0].overwrite, false);
  assert.equal(calls.uploads[0].resource_type, "image");
  assert.equal(calls.uploads[0].type, "upload");
  assert.match(calls.uploads[0].public_id, /^payment-proofs-poc\/poc-[a-f0-9-]{36}$/i);
  const retrievalUrls = calls.gets.filter((value) => typeof value === "string" && value.startsWith("https://")).map((value) => new URL(value));
  assert.ok(retrievalUrls.length >= 5);
  for (const url of retrievalUrls) {
    if (url.hostname === "res.cloudinary.com") {
      assert.equal(url.pathname.endsWith(`/${calls.uploads[0].public_id}.png`), true);
    } else {
      assert.equal(url.hostname, "api.cloudinary.com");
      assert.equal(url.pathname.endsWith("/asset/download"), true);
      assert.equal(url.searchParams.get("asset_id"), TEST_ASSET_ID);
    }
  }
  assert.equal(calls.updates.length, 2);
  assert.deepEqual(calls.updates.map((call) => call.exactId), [TEST_ASSET_ID, TEST_ASSET_ID]);
  assert.deepEqual(calls.metadataReads, Array(7).fill(TEST_ASSET_ID));
  assert.equal(calls.deletes.length, 1);
  assert.equal(calls.deletes[0].assetId, TEST_ASSET_ID);
  assert.equal(calls.deletes[0].invalidate, "true");
  assert.equal(calls.deletes[0].path.endsWith("/image/destroy"), true);
  assert.ok(calls.requestConfigs.every((config) => config.proxy === false));
  for (let index = 0; index < calls.events.length; index += 1) {
    const event = calls.events[index];
    if (event.operation === "update" || event.operation === "delete") {
      assert.equal(calls.events[index - 1]?.operation, "metadata");
      assert.equal(calls.events[index - 1]?.assetId, TEST_ASSET_ID);
      assert.equal(event.assetId, TEST_ASSET_ID);
    }
  }
  assert.equal(events.some((event) => JSON.stringify(event).includes(TEST_ASSET_ID)), false);
  const serializedEvents = JSON.stringify(events);
  for (const privateValue of ["https://", "res.cloudinary.com", "synthetic-key", "synthetic-secret", "synthetic-signature"]) {
    assert.equal(serializedEvents.includes(privateValue), false);
  }
});

test("ambiguous restriction failure stops without cleanup or a second update", async () => {
  const { dependencies, calls } = fixture({ failRestriction: true });
  const result = await runPoc({ ...dependencies, output: () => {} }, { cleanupAfterSuccess: true });
  assert.equal(result.result, "stopped_error");
  assert.equal(calls.uploads.length, 1);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.deletes.length, 0);
});

test("restriction rejection response never proceeds to cleanup", async () => {
  const { dependencies, calls } = fixture({ failRestrictionStatus: 403 });
  const result = await runPoc({ ...dependencies, output: () => {} }, { cleanupAfterSuccess: true });
  assert.equal(result.result, "stopped_restriction_failed");
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.deletes.length, 0);
});

test("restriction response without matching provider metadata never restores or deletes", async () => {
  const { dependencies, calls } = fixture({ ignoreRestriction: true });
  const result = await runPoc({ ...dependencies, output: () => {} }, { cleanupAfterSuccess: true });
  assert.equal(result.result, "stopped_restriction_ambiguous");
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.deletes.length, 0);
});

test("upload response with mismatched identity stops before any update or deletion", async () => {
  const { dependencies, calls } = fixture({ mismatchUpload: true });
  const result = await runPoc({ ...dependencies, output: () => {} }, { cleanupAfterSuccess: true });
  assert.equal(result.result, "stopped_ambiguous_upload");
  assert.equal(calls.metadataReads.length, 0);
  assert.equal(calls.updates.length, 0);
  assert.equal(calls.deletes.length, 0);
});

test("ambiguous anonymous retrieval after restriction stops without rollback or deletion", async () => {
  const { dependencies, calls } = fixture({ failRestrictedAnonymous: true });
  const result = await runPoc({ ...dependencies, output: () => {} }, { cleanupAfterSuccess: true });
  assert.equal(result.result, "stopped_ambiguous_anonymous_probe");
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.deletes.length, 0);
});

test("identity is rechecked before restriction and mismatch prevents mutation", async () => {
  const { dependencies, calls } = fixture({ tamperBeforeRestriction: true });
  const result = await runPoc({ ...dependencies, output: () => {} }, { cleanupAfterSuccess: true });
  assert.equal(result.result, "stopped_error");
  assert.equal(calls.updates.length, 0);
  assert.equal(calls.deletes.length, 0);
});

test("identity is rechecked before restore and mismatch prevents restore and deletion", async () => {
  const { dependencies, calls } = fixture({ tamperBeforeRestore: true });
  const result = await runPoc({ ...dependencies, output: () => {} }, { cleanupAfterSuccess: true });
  assert.equal(result.result, "stopped_error");
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.deletes.length, 0);
});

test("cleanup rechecks identity immediately before deletion", async () => {
  const { dependencies, calls } = fixture({ tamperBeforeCleanup: true });
  const result = await runPoc({ ...dependencies, output: () => {} }, { cleanupAfterSuccess: true });
  assert.equal(result.result, "stopped_error");
  assert.equal(calls.updates.length, 2);
  assert.equal(calls.metadataReads.length, 6);
  assert.equal(calls.deletes.length, 0);
});

test("restoration failure cannot run cleanup", async () => {
  const { dependencies, calls } = fixture({ failRestore: true });
  const result = await runPoc({ ...dependencies, output: () => {} }, { cleanupAfterSuccess: true });
  assert.equal(result.result, "stopped_error");
  assert.equal(calls.updates.length, 2);
  assert.equal(calls.deletes.length, 0);
});

test("restoration response with changed asset identity cannot run cleanup", async () => {
  const { dependencies, calls } = fixture({ mismatchRestore: true });
  const result = await runPoc({ ...dependencies, output: () => {} }, { cleanupAfterSuccess: true });
  assert.equal(result.result, "stopped_error");
  assert.equal(calls.updates.length, 2);
  assert.equal(calls.deletes.length, 0);
});

test("cleanup refuses an unexpected ACL state immediately before deletion", async () => {
  const { dependencies, calls } = fixture({ tamperAclBeforeCleanup: true });
  const result = await runPoc({ ...dependencies, output: () => {} }, { cleanupAfterSuccess: true });
  assert.equal(result.result, "stopped_error");
  assert.equal(calls.updates.length, 2);
  assert.equal(calls.deletes.length, 0);
});

test("ambiguous deletion is not retried", async () => {
  const { dependencies, calls } = fixture({ failDelete: true });
  const events = [];
  const result = await runPoc({ ...dependencies, output: (event) => events.push(event) }, { cleanupAfterSuccess: true });
  assert.equal(result.result, "stopped_error");
  assert.equal(calls.deletes.length, 1);
  assert.equal(calls.deletes[0].assetId, TEST_ASSET_ID);
  assert.equal(events.some((event) => JSON.stringify(event).includes("synthetic-secret")), false);
});

test("POC module does not load backend startup or MongoDB code", () => {
  const cachedModules = Object.keys(require.cache).join("\n");
  assert.doesNotMatch(cachedModules, /node_modules[\\/]mongoose[\\/]/);
  assert.doesNotMatch(cachedModules, /yomobiles_backend[\\/]index\.js/);
  const source = fs.readFileSync(path.join(__dirname, "../scripts/cloudinary_payment_proof_poc.js"), "utf8");
  assert.doesNotMatch(source, /require\(["'](?:mongoose|\.\.\/index|\.\/index)["']\)/);
});

test("script has no folder, prefix, tag, or bulk deletion API path", () => {
  const source = fs.readFileSync(path.join(__dirname, "../scripts/cloudinary_payment_proof_poc.js"), "utf8");
  assert.doesNotMatch(source, /delete_resources|delete_all_resources|delete_resources_by_prefix|delete_resources_by_tag/);
  assert.doesNotMatch(source, /\bprefix\s*:\s*|\ball\s*:\s*true|tags\/|folders?\/delete/);
});

test("safe error classification ignores provider message text", () => {
  const category = safeErrorCategory(Object.assign(new Error("secret URL and token"), { response: { status: 403 } }));
  assert.equal(category, "provider_denied");
  assert.equal(category.includes("secret"), false);
});
