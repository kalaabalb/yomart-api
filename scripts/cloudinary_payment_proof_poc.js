#!/usr/bin/env node
"use strict";

// Standalone, synthetic-only Cloudinary POC. It deliberately does not import
// the application entrypoint, connect to MongoDB, or print provider identifiers.
// No provider call occurs unless both explicit execution switches are passed.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const POC_PREFIX = "payment-proofs-poc/poc-";
const EXECUTION_ACK = "I_APPROVE_ONE_SYNTHETIC_CLOUDINARY_POC";
const MANIFEST_ENV = "YOMART_CLOUDINARY_POC_MANIFEST";
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const SAFE_LOCAL_ERROR_CATEGORIES = new Map([
  ["untrusted_delivery_endpoint", "local_delivery_url_rejected"],
  ["untrusted_provider_endpoint", "local_provider_url_rejected"],
  ["untrusted_signed_endpoint", "local_signed_url_rejected"],
  ["untrusted_signed_parameters", "local_signed_parameters_rejected"],
  ["asset_identity_not_verified", "local_asset_identity_check_failed"],
  ["asset_state_not_verified", "local_asset_state_check_failed"],
  ["cleanup_target_not_verified", "local_cleanup_identity_check_failed"],
  ["cleanup_asset_state_not_verified", "local_cleanup_state_check_failed"],
  ["cleanup_manifest_invalid", "local_recovery_manifest_invalid"],
  ["manifest_path_required", "local_recovery_manifest_path_missing"],
  ["manifest_path_must_be_absolute", "local_recovery_manifest_path_invalid"],
  ["manifest_path_must_be_outside_repository", "local_recovery_manifest_path_unsafe"],
  ["recovery_manifest_already_exists", "previous_recovery_requires_resolution"],
  ["recovery_manifest_permissions_invalid", "local_recovery_manifest_permissions_invalid"],
  ["synthetic_image_invalid", "local_synthetic_image_invalid"],
  ["response_too_large", "local_response_limit_exceeded"],
]);

function resolveRecoveryManifestPath(filePath, repositoryRoot = path.resolve(__dirname, "..")) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw new Error("manifest_path_must_be_absolute");
  const resolvedPath = path.resolve(filePath);
  const parentPath = path.dirname(resolvedPath);
  const realParent = fs.realpathSync(parentPath);
  const realRepository = fs.realpathSync(repositoryRoot);
  const relativeParent = path.relative(realRepository, realParent);
  if (relativeParent === "" || (!relativeParent.startsWith(`..${path.sep}`) && relativeParent !== ".." && !path.isAbsolute(relativeParent))) {
    throw new Error("manifest_path_must_be_outside_repository");
  }
  try {
    fs.lstatSync(resolvedPath);
    throw new Error("recovery_manifest_already_exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return resolvedPath;
}

function writeExclusiveRecoveryManifest(filePath, manifest) {
  const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    if ((fs.fstatSync(fd).mode & 0o777) !== 0o600) throw new Error("recovery_manifest_permissions_invalid");
    fs.writeFileSync(fd, `${JSON.stringify(manifest)}\n`, { encoding: "utf8" });
    fs.fsyncSync(fd);
  } catch (error) {
    // Keep a created marker on a write failure so a later run cannot upload
    // another asset while the first upload's outcome is uncertain.
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}

function updateRecoveryManifest(filePath, manifest) {
  const fd = fs.openSync(filePath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error("recovery_manifest_permissions_invalid");
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, `${JSON.stringify(manifest)}\n`, { encoding: "utf8" });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function removeResolvedRecoveryManifest(filePath, expected) {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error("recovery_manifest_permissions_invalid");
    const manifest = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (manifest.status !== "uploaded_verified" || manifest.asset_id !== expected.assetId || manifest.public_id !== expected.publicId) {
      throw new Error("recovery_manifest_identity_mismatch");
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.unlinkSync(filePath);
}

function recoveryManifestStatus(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 ? "present" : "unsafe";
  } catch (error) {
    if (error.code === "ENOENT") return "absent";
    return "unsafe";
  }
}

function safeConfigState(env) {
  const names = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"];
  return Object.fromEntries(names.map((name) => [name, typeof env[name] === "string" && env[name].trim().length > 0]));
}

function readPrivateEnvConfig(filePath) {
  let fd;
  try {
    if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
      return { state: { safeFile: false, uniqueCloudinaryKeys: false, alternateConfigAbsent: false } };
    }
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      return { state: { safeFile: false, uniqueCloudinaryKeys: false, alternateConfigAbsent: false } };
    }
    const contents = fs.readFileSync(fd, "utf8");
    const counts = new Map();
    let alternateConfigAbsent = true;
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?(CLOUDINARY_CLOUD_NAME|CLOUDINARY_API_KEY|CLOUDINARY_API_SECRET|CLOUDINARY_URL|CLOUDINARY_API_PROXY|CLOUDINARY_ACCOUNT_URL)\s*=/);
      if (match) counts.set(match[1], (counts.get(match[1]) || 0) + 1);
      if (match && ["CLOUDINARY_URL", "CLOUDINARY_API_PROXY", "CLOUDINARY_ACCOUNT_URL"].includes(match[1])) alternateConfigAbsent = false;
    }
    const keys = ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"];
    const uniqueCloudinaryKeys = keys.every((key) => counts.get(key) === 1);
    const parsed = require("dotenv").parse(contents);
    const config = {
      cloud_name: parsed.CLOUDINARY_CLOUD_NAME,
      api_key: parsed.CLOUDINARY_API_KEY,
      api_secret: parsed.CLOUDINARY_API_SECRET,
    };
    const configComplete = Object.values(config).every((value) => typeof value === "string" && value.trim().length > 0);
    return {
      state: { safeFile: true, uniqueCloudinaryKeys, alternateConfigAbsent },
      config: uniqueCloudinaryKeys && alternateConfigAbsent && configComplete ? config : null,
    };
  } catch (_) {
    return { state: { safeFile: false, uniqueCloudinaryKeys: false, alternateConfigAbsent: false }, config: null };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function safeEnvFileState(filePath) {
  return readPrivateEnvConfig(filePath).state;
}

function isValidPocPublicId(value, runId) {
  return typeof value === "string" && /^[a-f0-9-]{36}$/i.test(runId || "") && value === `${POC_PREFIX}${runId}`;
}

function metadataMatchesPoc(metadata, expected) {
  return Boolean(
    metadata && expected &&
    typeof expected.assetId === "string" && /^[A-Za-z0-9_-]{16,256}$/.test(expected.assetId) &&
    metadata.asset_id === expected.assetId &&
    metadata.public_id === expected.publicId &&
    isValidPocPublicId(expected.publicId, expected.runId) &&
    metadata.resource_type === "image" &&
    metadata.type === "upload" &&
    metadata.format === "png" &&
    Array.isArray(metadata.tags) && metadata.tags.includes(expected.tag)
  );
}

function normalizedAccessControl(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => Object.fromEntries(Object.entries(entry || {}).sort(([a], [b]) => a.localeCompare(b))))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function accessControlMatches(actual, expected) {
  return JSON.stringify(normalizedAccessControl(actual)) === JSON.stringify(normalizedAccessControl(expected));
}

function assertTrustedApiUrl(value, expectedPath) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" || url.hostname !== "api.cloudinary.com" || url.port ||
    url.username || url.password || url.pathname !== expectedPath || url.search || url.hash
  ) throw new Error("untrusted_provider_endpoint");
  return url;
}

function assertTrustedDeliveryUrl(value, cloudName, publicId, format) {
  const url = new URL(value);
  const basePath = `/${encodeURIComponent(cloudName)}/image/upload/`;
  if (
    url.protocol !== "https:" || url.hostname !== "res.cloudinary.com" || url.port ||
    url.username || url.password || url.hash ||
    !url.pathname.startsWith(basePath) || !url.pathname.endsWith(`/${publicId}.${format}`)
  ) throw new Error("untrusted_delivery_endpoint");
  // Cloudinary's documented SDK analytics parameter is `_a`. URL analytics
  // are disabled below, but accept a valid `_a` defensively across SDK builds.
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "_a") || keys.filter((key) => key === "_a").length > 1) {
    throw new Error("untrusted_delivery_endpoint");
  }
  if (keys.includes("_a") && !/^[A-Za-z0-9_-]{1,128}$/.test(url.searchParams.get("_a") || "")) {
    throw new Error("untrusted_delivery_endpoint");
  }
  return url;
}

function assertTrustedSignedDownloadUrl(url, cloudinary, assetId, expiresAt) {
  const config = cloudinary.config();
  const expectedPath = `/v1_1/${encodeURIComponent(config.cloud_name)}/asset/download`;
  if (
    url.protocol !== "https:" || url.hostname !== "api.cloudinary.com" || url.port ||
    url.username || url.password || url.pathname !== expectedPath || url.hash
  ) throw new Error("untrusted_signed_endpoint");
  const names = [...url.searchParams.keys()].sort();
  const expectedNames = ["api_key", "asset_id", "expires_at", "signature", "timestamp"];
  if (
    JSON.stringify(names) !== JSON.stringify(expectedNames) ||
    url.searchParams.get("api_key") !== config.api_key ||
    url.searchParams.get("asset_id") !== assetId ||
    url.searchParams.get("expires_at") !== String(expiresAt) ||
    !/^\d{1,12}$/.test(url.searchParams.get("timestamp") || "") ||
    !/^[A-Za-z0-9_-]{16,256}$/.test(url.searchParams.get("signature") || "")
  ) throw new Error("untrusted_signed_parameters");
  return url;
}

function isSuccessStatus(status) {
  return Number.isInteger(status) && status >= 200 && status < 300;
}

function safeErrorCategory(error) {
  if (SAFE_LOCAL_ERROR_CATEGORIES.has(error?.message)) return SAFE_LOCAL_ERROR_CATEGORIES.get(error.message);
  const status = Number(error?.http_code || error?.status || error?.response?.status);
  if (status === 401 || status === 403) return "provider_denied";
  if (status === 404) return "asset_not_found";
  if (status === 429) return "provider_quota_or_rate_limit";
  if (status >= 500) return "provider_server_error";
  if (error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT") return "network_timeout";
  if (error?.code === "ENOTFOUND" || error?.code === "EAI_AGAIN") return "network_dns";
  const code = String(error?.code || "");
  if (["ECONNRESET", "EPIPE", "ENETUNREACH", "EHOSTUNREACH"].includes(code)) return "network_transport";
  if (["ERR_INVALID_URL", "ERR_INVALID_ARG_TYPE", "ERR_INVALID_CHAR"].includes(code)) return "local_input_or_url_invalid";
  if (error?.name === "TimeoutError") return "network_timeout";
  if (error?.name === "CloudinaryError") return "provider_request_failed";
  return "unclassified_failure";
}

function createSyntheticPng(sharp) {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="360"><rect width="100%" height="100%" fill="#10213a"/><text x="50%" y="44%" text-anchor="middle" font-family="sans-serif" font-size="38" fill="#fff">SYNTHETIC TEST</text><text x="50%" y="61%" text-anchor="middle" font-family="sans-serif" font-size="23" fill="#e7bd5b">NOT A RECEIPT</text></svg>',
  );
  return sharp(svg).png().toBuffer();
}

function assertCleanupTarget(metadata, expected) {
  if (!metadataMatchesPoc(metadata, expected)) {
    throw new Error("cleanup_target_not_verified");
  }
  if (Object.hasOwn(expected, "baselineAccessControl") && !accessControlMatches(metadata.access_control, expected.baselineAccessControl)) {
    throw new Error("cleanup_asset_state_not_verified");
  }
}

async function readBoundedResponse(response, maxBytes = MAX_IMAGE_BYTES) {
  const chunks = [];
  let length = 0;
  for await (const chunk of response.data) {
    length += chunk.length;
    if (length > maxBytes) {
      response.data.destroy();
      throw new Error("response_too_large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function makeSignedAssetDownloadUrl(cloudinary, assetId, expiresAt) {
  const timestamp = Math.floor(Date.now() / 1000);
  const options = cloudinary.config();
  const params = { asset_id: assetId, expires_at: expiresAt, timestamp };
  const signed = cloudinary.utils.sign_request(params, {
    api_key: options.api_key,
    api_secret: options.api_secret,
  });
  const url = new URL(cloudinary.utils.base_api_url_v1()(["asset", "download"], options));
  for (const [key, value] of Object.entries(signed)) url.searchParams.set(key, String(value));
  return url;
}

async function retrieveStatus(axios, url) {
  try {
    const response = await axios.get(url.toString(), {
      responseType: "stream",
      timeout: 12000,
      maxRedirects: 0,
      // Axios otherwise honors ambient HTTP(S)_PROXY settings. A proxy could
      // observe the signed download query even though provider URLs are checked.
      proxy: false,
      maxContentLength: MAX_IMAGE_BYTES,
      validateStatus: () => true,
    });
    const status = response.status;
    if (response.data && typeof response.data.destroy === "function") response.data.destroy();
    return { status, category: status >= 200 && status < 300 ? "allowed" : status === 401 || status === 403 || status === 404 ? "denied" : "unexpected_status" };
  } catch (error) {
    return { status: null, category: safeErrorCategory(error) };
  }
}

async function executePoc(dependencies, options = {}) {
  const { cloudinary, axios, sharp, output = console.log } = dependencies;
  const runId = crypto.randomUUID();
  const publicId = `${POC_PREFIX}${runId}`;
  const tag = `yomart-synthetic-poc-${runId}`;
  const expected = { runId, publicId, tag };
  let assetId;
  let baselineAccessControl;
  let metadata;
  let expectedFull;
  let uploadedBytes;
  let manifestCreated = false;
  let allChecksPassed = false;
  let cleanupAttempted = false;

  const emit = (name, result) => output({ check: name, ...result });
  const getMetadata = async (id) => cloudinary.api.resource_by_asset_id(id);
  const getVerifiedMetadata = async (id, expectedAccessControl) => {
    if (!assetId || id !== assetId || !expectedFull) throw new Error("asset_identity_not_verified");
    const current = await getMetadata(assetId);
    assertCleanupTarget(current, expectedFull);
    if (!accessControlMatches(current.access_control, expectedAccessControl)) throw new Error("asset_state_not_verified");
    return current;
  };
  const updateExactAsset = async (id, accessControl, expectedCurrentAccessControl) => {
    await getVerifiedMetadata(id, expectedCurrentAccessControl);
    const config = cloudinary.config();
    const assetPath = `/v1_1/${encodeURIComponent(config.cloud_name)}/resources/${encodeURIComponent(assetId)}`;
    const endpoint = assertTrustedApiUrl(
      cloudinary.utils.base_api_url_v1()(["resources", assetId], config),
      assetPath,
    ).toString();
    return axios.put(endpoint, { access_control: accessControl }, {
      auth: { username: config.api_key, password: config.api_secret },
      headers: { "Content-Type": "application/json" },
      timeout: 12000,
      maxRedirects: 0,
      proxy: false,
    });
  };

  try {
    uploadedBytes = await createSyntheticPng(sharp);
    if (!uploadedBytes.length || uploadedBytes.length > MAX_IMAGE_BYTES) throw new Error("synthetic_image_invalid");
    if (!options.manifestPath) throw new Error("manifest_path_required");
    const manifestPath = resolveRecoveryManifestPath(options.manifestPath);
    writeExclusiveRecoveryManifest(manifestPath, {
      version: 1,
      status: "upload_in_progress",
      run_id: runId,
      public_id: publicId,
      created_at: new Date().toISOString(),
    });
    manifestCreated = true;

    const upload = await cloudinary.uploader.upload(`data:image/png;base64,${uploadedBytes.toString("base64")}`, {
      public_id: publicId,
      overwrite: false,
      unique_filename: false,
      resource_type: "image",
      type: "upload",
      tags: [tag],
    });
    assetId = upload?.asset_id;
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(assetId || "") || upload.public_id !== publicId || upload.resource_type !== "image") {
      emit("upload", { result: "ambiguous_metadata" });
      return { runId, result: "stopped_ambiguous_upload" };
    }
    emit("upload", { result: "pass" });

    metadata = await getMetadata(assetId);
    expectedFull = { ...expected, assetId };
    if (!metadataMatchesPoc(metadata, expectedFull)) {
      emit("exact_asset_identity", { result: "fail" });
      return { runId, result: "stopped_identity_mismatch" };
    }
    baselineAccessControl = Array.isArray(metadata.access_control) ? metadata.access_control : [];
    updateRecoveryManifest(manifestPath, {
      version: 1,
      status: "uploaded_verified",
      run_id: runId,
      public_id: publicId,
      asset_id: assetId,
      tag,
      resource_type: metadata.resource_type,
      delivery_type: metadata.type,
      format: metadata.format,
      baseline_access_control: baselineAccessControl,
      created_at: new Date().toISOString(),
    });
    emit("exact_asset_identity", { result: "pass", resourceType: metadata.resource_type, deliveryType: metadata.type, format: metadata.format });

    const config = cloudinary.config();
    const originalUrl = assertTrustedDeliveryUrl(cloudinary.url(publicId, {
      cloud_name: config.cloud_name,
      secure: true,
      cdn_subdomain: false,
      resource_type: "image",
      type: "upload",
      format: "png",
      urlAnalytics: false,
    }), config.cloud_name, publicId, "png").toString();
    const derivedUrl = assertTrustedDeliveryUrl(cloudinary.url(publicId, {
      cloud_name: config.cloud_name,
      secure: true,
      cdn_subdomain: false,
      resource_type: "image",
      type: "upload",
      format: "png",
      transformation: [{ width: 160, height: 80, crop: "fill" }],
      urlAnalytics: false,
    }), config.cloud_name, publicId, "png").toString();
    const initialOriginal = await retrieveStatus(axios, originalUrl);
    const initialDerived = await retrieveStatus(axios, derivedUrl);
    emit("anonymous_before_restriction", { original: initialOriginal, derived: initialDerived });
    if (initialOriginal.status === null || initialDerived.status === null) {
      return { runId, result: "stopped_ambiguous_anonymous_probe", cleanupEligible: false };
    }
    const baselinePassed = initialOriginal.category === "allowed" && initialDerived.category === "allowed";

    const restriction = await updateExactAsset(assetId, [{ access_type: "token" }], baselineAccessControl);
    if (!isSuccessStatus(restriction?.status)) {
      emit("access_control_update", { result: "failed", status: Number.isInteger(restriction?.status) ? restriction.status : null });
      return { runId, result: "stopped_restriction_failed" };
    }
    emit("access_control_update", { result: "pass" });

    metadata = await getMetadata(assetId);
    if (!metadataMatchesPoc(metadata, expectedFull) || !accessControlMatches(metadata.access_control, [{ access_type: "token" }])) {
      emit("restriction_metadata", { result: "fail" });
      return { runId, result: "stopped_restriction_ambiguous" };
    }
    emit("restriction_metadata", { result: "pass" });

    const anonymousOriginal = await retrieveStatus(axios, originalUrl);
    const anonymousDerived = await retrieveStatus(axios, derivedUrl);
    emit("anonymous_after_restriction", { original: anonymousOriginal, derived: anonymousDerived });
    if (anonymousOriginal.status === null || anonymousDerived.status === null) {
      return { runId, result: "stopped_ambiguous_anonymous_probe", cleanupEligible: false };
    }
    const anonymousDenied = anonymousOriginal.category === "denied" && anonymousDerived.category === "denied";

    const expiresAt = Math.floor(Date.now() / 1000) + 60;
    const signedUrl = makeSignedAssetDownloadUrl(cloudinary, assetId, expiresAt);
    try {
      assertTrustedSignedDownloadUrl(signedUrl, cloudinary, assetId, expiresAt);
    } catch (_) {
      emit("signed_asset_id_retrieval", { result: "refused_untrusted_endpoint" });
      return { runId, result: "stopped_untrusted_endpoint" };
    }
    let signedRetrievalPassed = false;
    try {
      const privateResponse = await axios.get(signedUrl.toString(), {
        responseType: "stream",
        timeout: 12000,
        maxRedirects: 0,
      proxy: false,
        maxContentLength: MAX_IMAGE_BYTES,
        validateStatus: () => true,
      });
      if (privateResponse.status >= 200 && privateResponse.status < 300) {
        const bytes = await readBoundedResponse(privateResponse);
        const contentMatches = crypto.createHash("sha256").update(bytes).digest("hex") === crypto.createHash("sha256").update(uploadedBytes).digest("hex");
        signedRetrievalPassed = contentMatches;
        emit("signed_asset_id_retrieval", { result: contentMatches ? "pass" : "content_mismatch", status: privateResponse.status });
      } else {
        if (privateResponse.data?.destroy) privateResponse.data.destroy();
        emit("signed_asset_id_retrieval", { result: "denied_or_failed", status: privateResponse.status, category: privateResponse.status === 401 || privateResponse.status === 403 ? "provider_denied" : "unexpected_status" });
      }
    } catch (error) {
      emit("signed_asset_id_retrieval", { result: "failed", category: safeErrorCategory(error) });
      return { runId, result: "stopped_ambiguous_signed_retrieval", cleanupEligible: false };
    }

    const expiredUrl = makeSignedAssetDownloadUrl(cloudinary, assetId, Math.floor(Date.now() / 1000) - 60);
    try {
      assertTrustedSignedDownloadUrl(expiredUrl, cloudinary, assetId, Number(expiredUrl.searchParams.get("expires_at")));
    } catch (_) {
      emit("expired_signed_asset_id_retrieval", { result: "refused_untrusted_endpoint" });
      return { runId, result: "stopped_untrusted_endpoint", cleanupEligible: false };
    }
    const expiry = await retrieveStatus(axios, expiredUrl);
    emit("expired_signed_asset_id_retrieval", expiry);
    if (expiry.status === null) {
      return { runId, result: "stopped_ambiguous_expiry_probe", cleanupEligible: false };
    }
    const expiryPassed = expiry.category === "denied";

    // Roll back only the exact synthetic object. If restoring its captured ACL
    // or confirming the baseline is ambiguous, stop and do not delete anything.
    const restore = await updateExactAsset(assetId, baselineAccessControl, [{ access_type: "token" }]);
    if (!isSuccessStatus(restore?.status)) {
      emit("restore_baseline", { result: "failed", status: Number.isInteger(restore?.status) ? restore.status : null });
      return { runId, result: "stopped_restore_failed" };
    }
    const restored = await getMetadata(assetId);
    assertCleanupTarget(restored, expectedFull);
    if (!accessControlMatches(restored.access_control, baselineAccessControl)) {
      emit("restore_baseline", { result: "metadata_mismatch" });
      return { runId, result: "stopped_restore_ambiguous" };
    }
    emit("restore_baseline", { result: "pass" });
    allChecksPassed = baselinePassed && anonymousDenied && signedRetrievalPassed && expiryPassed;
    emit("poc_result", { result: allChecksPassed ? "pass" : "fail" });
    if (options.cleanupAfterSuccess !== true) {
      return { runId, result: allChecksPassed ? "checks_passed_cleanup_not_requested" : "checks_failed_asset_retained", cleanupEligible: true };
    }
    cleanupAttempted = true;
    const cleanupResult = await cleanupExactSyntheticAsset(dependencies, { ...expected, assetId, baselineAccessControl });
    removeResolvedRecoveryManifest(manifestPath, { assetId, publicId });
    emit("cleanup", cleanupResult);
    return { runId, result: allChecksPassed ? "complete_and_cleaned" : "checks_failed_but_cleaned", cleanupEligible: false };
  } catch (error) {
    emit("poc", { result: "stopped", category: safeErrorCategory(error) });
    return { runId, result: "stopped_error" };
  } finally {
    // Failures and ambiguous provider outcomes never trigger deletion.
    if (assetId && metadata && !allChecksPassed && !cleanupAttempted) emit("cleanup", { result: "not_attempted_ambiguous_or_incomplete" });
  }
}

async function cleanupExactSyntheticAsset(dependencies, manifest) {
  const { cloudinary, axios } = dependencies;
  const expected = {
    runId: manifest?.runId,
    publicId: manifest?.publicId,
    tag: manifest?.tag,
    assetId: manifest?.assetId,
    baselineAccessControl: manifest?.baselineAccessControl,
  };
  if (
    !isValidPocPublicId(expected.publicId, expected.runId) ||
    !/^[A-Za-z0-9_-]{16,256}$/.test(expected.assetId || "") ||
    expected.tag !== `yomart-synthetic-poc-${expected.runId}` ||
    !Array.isArray(expected.baselineAccessControl)
  ) {
    throw new Error("cleanup_manifest_invalid");
  }
  const before = await cloudinary.api.resource_by_asset_id(expected.assetId);
  assertCleanupTarget(before, expected);
  const config = cloudinary.config();
  const params = {
    asset_id: expected.assetId,
    invalidate: true,
    timestamp: Math.floor(Date.now() / 1000),
  };
  const signed = cloudinary.utils.sign_request(params, { api_key: config.api_key, api_secret: config.api_secret });
  const deletePath = `/v1_1/${encodeURIComponent(config.cloud_name)}/image/destroy`;
  const endpoint = assertTrustedApiUrl(
    cloudinary.utils.api_url("destroy", { resource_type: "image" }),
    deletePath,
  ).toString();
  const response = await axios.post(endpoint, new URLSearchParams(Object.entries(signed).map(([k, v]) => [k, String(v)])).toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 12000,
    maxRedirects: 0,
    proxy: false,
    validateStatus: () => true,
  });
  if (!isSuccessStatus(response?.status) || !["ok", "not found"].includes(response.data?.result)) {
    throw new Error("cleanup_provider_result_unverified");
  }
  try {
    await cloudinary.api.resource_by_asset_id(expected.assetId);
    throw new Error("cleanup_asset_still_present");
  } catch (error) {
    if (error.message === "cleanup_asset_still_present") throw error;
    if (Number(error?.http_code || error?.status) !== 404) throw new Error("cleanup_absence_unverified");
  }
  return { result: "deleted_exact_synthetic_asset" };
}

async function main(argv = process.argv.slice(2)) {
  const execute = argv.includes("--execute");
  const cleanup = argv.includes("--cleanup");
  const envPath = path.resolve(__dirname, "../.env");
  const envResult = readPrivateEnvConfig(envPath);
  const envFileState = envResult.state;
  if (!envFileState.safeFile || !envFileState.uniqueCloudinaryKeys || !envFileState.alternateConfigAbsent) {
    console.log("Local environment preflight: unsafe or ambiguous. No provider calls were made.");
    process.exitCode = 2;
    return;
  }
  const configComplete = Boolean(envResult.config);
  console.log(`Cloudinary configuration: ${configComplete ? "complete" : "incomplete"}. Credentials were not displayed.`);
  let manifestPath;
  try {
    manifestPath = resolveRecoveryManifestPath(process.env[MANIFEST_ENV]);
  } catch (error) {
    const category = error.message === "recovery_manifest_already_exists" ? "previous_recovery_requires_resolution" : "manifest_path_invalid_or_unsafe";
    console.log(`Recovery manifest preflight: ${category}. No provider calls were made.`);
    process.exitCode = 2;
    return;
  }
  if (!execute) {
    console.log("Preflight only. No provider calls were made.");
    return;
  }
  if (!configComplete) {
    console.log("Stopped: Cloudinary configuration is incomplete. No provider calls were made.");
    process.exitCode = 2;
    return;
  }
  if (!cleanup) {
    console.log("Stopped: --cleanup is required for this synthetic-only run. No provider calls were made.");
    process.exitCode = 2;
    return;
  }
  if (process.env.YOMART_CLOUDINARY_POC_ACK !== EXECUTION_ACK) {
    console.log("Stopped: explicit POC acknowledgement is missing. No provider calls were made.");
    process.exitCode = 2;
    return;
  }

  // Prevent SDK ambient URL/proxy settings from selecting other credentials or hosts.
  delete process.env.CLOUDINARY_URL;
  delete process.env.CLOUDINARY_API_PROXY;
  delete process.env.CLOUDINARY_ACCOUNT_URL;
  const cloudinary = require("cloudinary").v2;
  cloudinary.config({
    ...envResult.config,
    secure: true,
    upload_prefix: "https://api.cloudinary.com",
    api_proxy: null,
    private_cdn: false,
    secure_distribution: undefined,
    cname: undefined,
  });
  const dependencies = { cloudinary, axios: require("axios"), sharp: require("sharp") };
  const result = await executePoc(dependencies, { cleanupAfterSuccess: true, manifestPath });
  console.log(JSON.stringify({ result: result.result, cleanupEligible: result.cleanupEligible === true }));
}

if (require.main === module) {
  main().catch(() => {
    console.error("POC stopped with an internal error; details were suppressed.");
    process.exitCode = 1;
  });
}

module.exports = {
  POC_PREFIX,
  EXECUTION_ACK,
  safeConfigState,
  safeEnvFileState,
  resolveRecoveryManifestPath,
  recoveryManifestStatus,
  writeExclusiveRecoveryManifest,
  updateRecoveryManifest,
  removeResolvedRecoveryManifest,
  isValidPocPublicId,
  assertTrustedDeliveryUrl,
  metadataMatchesPoc,
  safeErrorCategory,
  assertCleanupTarget,
  executePoc,
};
