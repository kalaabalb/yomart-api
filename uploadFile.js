const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const cloudinary = require("cloudinary").v2;
const sharp = require("sharp");
const axios = require("axios");
const { pipeline, Transform } = require("node:stream");
const { enhanceProductPhoto, enhancementEnabled } = require("./utils/photoEnhance");
const { isProductionLike } = require("./config/environment");

function canonicalFuturePath(inputPath) {
  const absolutePath = path.resolve(inputPath);
  let cursor = absolutePath;
  const missingSegments = [];
  while (true) {
    try {
      const realPath = fs.realpathSync.native(cursor);
      const stat = fs.statSync(realPath);
      if (cursor === absolutePath && !stat.isDirectory()) {
        throw new Error("Upload storage roots must be directories.");
      }
      return path.resolve(realPath, ...missingSegments.reverse());
    } catch (error) {
      if (error.message === "Upload storage roots must be directories.") throw error;
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function isPathWithin(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertStorageRootsDisjoint(publicRoot, privateRoot) {
  const canonicalPublicRoot = canonicalFuturePath(publicRoot);
  const canonicalPrivateRoot = canonicalFuturePath(privateRoot);
  if (
    isPathWithin(canonicalPublicRoot, canonicalPrivateRoot) ||
    isPathWithin(canonicalPrivateRoot, canonicalPublicRoot)
  ) {
    throw new Error("Public uploads and private payment-proof storage must use separate, non-overlapping directories.");
  }
  return { publicRoot: canonicalPublicRoot, privateRoot: canonicalPrivateRoot };
}

const configuredLocalUploadRoot = process.env.UPLOADS_DIR || path.join(__dirname, "uploads");
const configuredPrivateProofRoot = process.env.PAYMENT_PROOFS_DIR || path.join(__dirname, "private-payment-proofs");
const canonicalStorageRoots = assertStorageRootsDisjoint(configuredLocalUploadRoot, configuredPrivateProofRoot);
const localUploadRoot = canonicalStorageRoots.publicRoot;
const privateProofRoot = canonicalStorageRoots.privateRoot;
const CLOUDINARY_ENV_NAMES = Object.freeze([
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
]);

const hasCloudinary = () => {
  const configuredCount = CLOUDINARY_ENV_NAMES.filter((name) => Boolean(process.env[name])).length;
  if (configuredCount !== 0 && configuredCount !== CLOUDINARY_ENV_NAMES.length) {
    const error = new Error("Cloudinary requires CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET together.");
    error.statusCode = 503;
    throw error;
  }
  return configuredCount === CLOUDINARY_ENV_NAMES.length;
};

function ensureUploadStorageConfigured() {
  if (
    isProductionLike() &&
    !hasCloudinary() &&
    !process.env.UPLOADS_DIR
  ) {
    const error = new Error(
      "Image uploads require Cloudinary or a persistent UPLOADS_DIR in production.",
    );
    error.statusCode = 503;
    throw error;
  }
}

function ensurePrivateProofStorageConfigured() {
  assertStorageRootsDisjoint(configuredLocalUploadRoot, configuredPrivateProofRoot);
  if (isProductionLike() && !hasCloudinary() && !process.env.PAYMENT_PROOFS_DIR) {
    const error = new Error("Payment proofs require authenticated Cloudinary storage or a persistent PAYMENT_PROOFS_DIR in production.");
    error.statusCode = 503;
    throw error;
  }
}

function validateUploadStorageRoots() {
  const roots = assertStorageRootsDisjoint(configuredLocalUploadRoot, configuredPrivateProofRoot);
  // Reject partial Cloudinary configuration before accepting traffic, so a typo
  // cannot silently route new private proofs to local/ephemeral storage.
  hasCloudinary();
  return roots;
}

async function openSafeFile(root, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) return null;
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;

  let canonicalRoot;
  try {
    canonicalRoot = await fs.promises.realpath(root);
    if (canonicalRoot !== root) return null;
    const rootStat = await fs.promises.lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
  } catch (_) {
    return null;
  }

  let directory = canonicalRoot;
  for (const segment of segments.slice(0, -1)) {
    directory = path.join(directory, segment);
    try {
      const stat = await fs.promises.lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
      const realDirectory = await fs.promises.realpath(directory);
      if (!isPathWithin(canonicalRoot, realDirectory)) return null;
    } catch (_) {
      return null;
    }
  }

  const filePath = path.join(directory, segments[segments.length - 1]);
  let handle;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close();
      return null;
    }

    // On Linux, resolve the opened descriptor itself so a directory swap
    // between lstat and open cannot redirect the read outside the root.
    if (process.platform === "linux" && fs.existsSync(`/proc/self/fd/${handle.fd}`)) {
      const openedPath = await fs.promises.realpath(`/proc/self/fd/${handle.fd}`);
      if (!isPathWithin(canonicalRoot, openedPath)) {
        await handle.close();
        return null;
      }
    } else {
      const realFile = await fs.promises.realpath(filePath);
      if (!isPathWithin(canonicalRoot, realFile)) {
        await handle.close();
        return null;
      }
    }
    return { handle, stat };
  } catch (_) {
    await handle?.close().catch(() => {});
    return null;
  }
}

async function inspectLocalProofPresence(root, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) return "unverified";
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return "unverified";
  try {
    const canonicalRoot = await fs.promises.realpath(root);
    if (canonicalRoot !== root) return "unverified";
    const rootStat = await fs.promises.lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return "unverified";
    let directory = canonicalRoot;
    for (const segment of segments.slice(0, -1)) {
      directory = path.join(directory, segment);
      let stat;
      try { stat = await fs.promises.lstat(directory); }
      catch (error) { return error.code === "ENOENT" ? "missing" : "unverified"; }
      if (stat.isSymbolicLink() || !stat.isDirectory()) return "unverified";
      if (!isPathWithin(canonicalRoot, await fs.promises.realpath(directory))) return "unverified";
    }
    const target = path.join(directory, segments.at(-1));
    let stat;
    try { stat = await fs.promises.lstat(target); }
    catch (error) { return error.code === "ENOENT" ? "missing" : "unverified"; }
    if (stat.isSymbolicLink() || !stat.isFile()) return "unverified";
    if (!isPathWithin(canonicalRoot, await fs.promises.realpath(target))) return "unverified";
    return "present";
  } catch (_) {
    return "unverified";
  }
}

async function inspectPaymentProofAsset(reference, { assumeLocalPrivateStorage = false, localPrivateRoot = privateProofRoot } = {}) {
  if (typeof reference !== "string" || !reference) {
    return { storageType: "unknown", assetStatus: "unverified" };
  }
  const privateLocation = privateProofLocation(reference);
  if (privateLocation) {
    // Private proof IDs have no persisted provider marker. Without an explicit
    // operator assertion, do not label an inaccessible Cloudinary asset missing
    // merely because this process currently lacks provider credentials.
    if (!assumeLocalPrivateStorage) {
      return { storageType: hasCloudinary() ? "cloudinary_authenticated" : "private_storage_unverified", assetStatus: "unverified" };
    }
    return {
      storageType: "local_private",
      assetStatus: await inspectLocalProofPresence(localPrivateRoot, privateLocation.key),
    };
  }
  const localLegacy = reference.match(/^\/uploads\/payment-proofs\/([a-f\d]{24})\/((?:payment_[a-f\d-]{36}|\d+_[a-f\d-]{36}))\.webp$/i);
  if (localLegacy) {
    const relative = path.join("payment-proofs", localLegacy[1], `${localLegacy[2]}.webp`);
    return { storageType: "local_legacy", assetStatus: await inspectLocalProofPresence(localUploadRoot, relative) };
  }
  try {
    const parsed = new URL(reference);
    if (parsed.protocol === "https:" && parsed.hostname === "res.cloudinary.com") {
      return { storageType: "cloudinary_legacy_public", assetStatus: "unverified" };
    }
  } catch (_) {}
  return { storageType: "malformed", assetStatus: "unverified" };
}

function streamSafeFile(root, relativePath, res, contentType = "image/webp") {
  return openSafeFile(root, relativePath).then((opened) => {
    if (!opened) return false;
    res.set({
      "Content-Type": contentType,
      "Content-Length": String(opened.stat.size),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    const stream = opened.handle.createReadStream({ autoClose: true });
    stream.on("error", () => {
      if (res.headersSent) res.destroy();
      else res.status(404).end();
    });
    res.on("close", () => stream.destroy());
    stream.pipe(res);
    return true;
  });
}

function createPublicUploadHandler() {
  const publicFolders = new Set(["categories", "products", "posters", "brands"]);
  return async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    let rawPath;
    try {
      rawPath = new URL(req.originalUrl, "http://localhost").pathname;
      if (!rawPath.startsWith("/uploads/")) return next();
      let decodedPath = rawPath;
      for (let i = 0; i < 4; i += 1) {
        if (/%(?:2f|5c)/i.test(decodedPath) || decodedPath.includes("\\")) {
          return res.status(404).end();
        }
        const nextPath = decodeURIComponent(decodedPath);
        if (nextPath === decodedPath) break;
        decodedPath = nextPath;
      }
      if (/%(?:2f|5c)/i.test(decodedPath)) return res.status(404).end();
      const segments = decodedPath.slice("/uploads/".length).split("/");
      if (
        segments.length < 2 ||
        segments.some((segment) => !segment || segment === "." || segment === "..") ||
        !publicFolders.has(segments[0])
      ) {
        return res.status(404).end();
      }
      const relativePath = segments.join(path.sep);
      const opened = await openSafeFile(localUploadRoot, relativePath);
      if (!opened) return res.status(404).end();
      const contentTypes = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
      };
      res.set({
        "Content-Type": contentTypes[path.extname(relativePath).toLowerCase()] || "application/octet-stream",
        "Content-Length": String(opened.stat.size),
        "Cache-Control": process.env.NODE_ENV === "production" ? "public, max-age=86400" : "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      if (req.method === "HEAD") {
        await opened.handle.close();
        return res.end();
      }
      const stream = opened.handle.createReadStream({ autoClose: true });
      stream.on("error", () => {
        if (res.headersSent) res.destroy();
        else res.status(404).end();
      });
      res.on("close", () => stream.destroy());
      stream.pipe(res);
    } catch (_) {
      return res.status(404).end();
    }
  };
}

async function saveLocalImage(buffer, folderName, prefix = "image", maxEdge = 2400) {
  ensureUploadStorageConfigured();
  const safeFolders = String(folderName || "uploads")
    .split("/")
    .filter((part) => /^[A-Za-z0-9_-]+$/.test(part));
  const directory = path.join(localUploadRoot, ...safeFolders);
  await fs.promises.mkdir(directory, { recursive: true });
  const filename = `${prefix}_${crypto.randomUUID()}.webp`;
  await sharp(buffer)
    .rotate()
    .resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toFile(path.join(directory, filename));
  return `/uploads/${path.posix.join(...safeFolders, filename)}`;
}

async function savePrivatePaymentProof(buffer, userId) {
  ensurePrivateProofStorageConfigured();
  const safeUserId = String(userId || "");
  if (!/^[a-f\d]{24}$/i.test(safeUserId)) throw new Error("Invalid proof owner.");
  const filename = `payment_${crypto.randomUUID()}.webp`;
  let optimized;
  try {
    optimized = await sharp(buffer)
      .rotate()
      .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
  } catch (error) {
    error.statusCode = 400;
    throw error;
  }
  if (hasCloudinary()) {
    const result = await cloudinary.uploader.upload(
      `data:image/webp;base64,${optimized.toString("base64")}`,
      {
      folder: `payment-proofs/${safeUserId}`,
      public_id: filename.replace(/\.webp$/, ""),
      resource_type: "image",
      type: "authenticated",
      format: "webp",
      },
    );
    return `proof:${result.public_id}`;
  }
  const directory = path.join(privateProofRoot, "payment-proofs", safeUserId);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(privateProofRoot, 0o700);
  await fs.promises.chmod(path.join(privateProofRoot, "payment-proofs"), 0o700);
  await fs.promises.chmod(directory, 0o700);
  await fs.promises.writeFile(path.join(directory, filename), optimized, {
    flag: "wx",
    mode: 0o600,
  });
  await fs.promises.chmod(path.join(directory, filename), 0o600);
  return `proof:payment-proofs/${safeUserId}/${filename}`;
}

function privateProofLocation(proofId) {
  if (typeof proofId !== "string" || !proofId.startsWith("proof:")) return null;
  const key = proofId.slice("proof:".length);
  const match = key.match(/^payment-proofs\/([a-f\d]{24})\/(payment_[a-f\d-]{36})(?:\.webp)?$/i);
  if (!match) return null;
  return { key, userId: match[1], filename: `${match[2]}.webp` };
}

async function deliverLegacyPaymentProof(imageUrl, ownerId, res) {
  if (typeof imageUrl !== "string") return false;
  const localMatch = imageUrl.match(/^\/uploads\/payment-proofs\/([a-f\d]{24})\/((?:payment_[a-f\d-]{36}|\d+_[a-f\d-]{36}))\.webp$/i);
  if (localMatch && localMatch[1].toLowerCase() === String(ownerId).toLowerCase()) {
    return streamSafeFile(
      localUploadRoot,
      path.join("payment-proofs", localMatch[1], `${localMatch[2]}.webp`),
      res,
    );
  }
  // Historical Cloudinary imageUrl values point to public delivery URLs. Never
  // fetch them here: keeping that behavior would proxy publicly addressable
  // evidence and would not make the original URL private. They require an
  // owner-approved migration to authenticated storage before retrieval.
  return false;
}

function trustedPrivateDownloadUrl(value, { publicId, expiresAt }) {
  try {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    if (!cloudName || !apiKey || typeof value !== "string") return null;
    const url = new URL(value);
    const expectedPath = `/v1_1/${encodeURIComponent(cloudName)}/image/download`;
    const params = url.searchParams;
    const queryNames = [...params.keys()];
    const queryNamesAreUnique = new Set(queryNames).size === queryNames.length;
    const expectedQueryNames = ["api_key", "expires_at", "format", "public_id", "signature", "timestamp", "type"];
    const queryNamesAreExpected = queryNames.length === expectedQueryNames.length &&
      expectedQueryNames.every((name) => params.has(name));
    if (
      url.protocol !== "https:" ||
      url.hostname !== "api.cloudinary.com" ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== expectedPath ||
      url.hash ||
      !queryNamesAreUnique ||
      !queryNamesAreExpected ||
      params.get("api_key") !== apiKey ||
      params.get("public_id") !== publicId ||
      params.get("format") !== "webp" ||
      params.get("type") !== "authenticated" ||
      params.get("expires_at") !== String(expiresAt) ||
      !/^\d{1,12}$/.test(params.get("timestamp") || "") ||
      !/^[A-Za-z0-9_-]{16,256}$/.test(params.get("signature") || "")
    ) return null;
    return url.toString();
  } catch (_) {
    return null;
  }
}

async function deliverPrivatePaymentProof(proofId, res) {
  const location = privateProofLocation(proofId);
  if (!location) return false;
  if (hasCloudinary()) {
    let remote;
    try {
      const publicId = location.key.replace(/\.webp$/, "");
      const expiresAt = Math.floor(Date.now() / 1000) + 60;
      const signedUrl = cloudinary.utils.private_download_url(publicId, "webp", {
        resource_type: "image",
        type: "authenticated",
        expires_at: expiresAt,
      });
      const trustedUrl = trustedPrivateDownloadUrl(signedUrl, { publicId, expiresAt });
      if (!trustedUrl) return false;
      remote = await axios.get(trustedUrl, {
        responseType: "stream",
        timeout: 15000,
        maxContentLength: 10 * 1024 * 1024,
        maxRedirects: 0,
        validateStatus: (status) => status === 200,
      });
    } catch (_) {
      return false;
    }
    res.set({ "Content-Type": "image/webp", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    remote.data.on("error", () => res.destroy());
    remote.data.pipe(res);
    return true;
  }
  return streamSafeFile(privateProofRoot, location.key, res);
}

async function deletePrivatePaymentProof(proofId) {
  const location = privateProofLocation(proofId);
  if (!location) throw new Error("Invalid private proof reference.");
  if (hasCloudinary()) {
    const result = await cloudinary.uploader.destroy(location.key.replace(/\.webp$/, ""), {
      resource_type: "image",
      type: "authenticated",
      invalidate: true,
    });
    if (!result || !["ok", "not found"].includes(result.result)) {
      throw new Error("Private proof provider cleanup did not complete.");
    }
    return;
  }
  if (process.platform !== "linux") {
    throw new Error("Race-safe local proof deletion requires Linux directory-handle support.");
  }
  const segments = location.key.split("/");
  const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  let directoryHandle;
  let fileHandle;
  try {
    directoryHandle = await fs.promises.open(privateProofRoot, directoryFlags);
    const canonicalRoot = await fs.promises.realpath(`/proc/self/fd/${directoryHandle.fd}`);
    if (canonicalRoot !== privateProofRoot) throw new Error("Private proof root changed during deletion.");

    for (const segment of segments.slice(0, -1)) {
      const child = await fs.promises.open(`/proc/self/fd/${directoryHandle.fd}/${segment}`, directoryFlags);
      const stat = await child.stat();
      const canonicalChild = await fs.promises.realpath(`/proc/self/fd/${child.fd}`);
      if (!stat.isDirectory() || !isPathWithin(canonicalRoot, canonicalChild)) {
        await child.close();
        throw new Error("Private proof directory is unsafe.");
      }
      await directoryHandle.close();
      directoryHandle = child;
    }

    const target = `/proc/self/fd/${directoryHandle.fd}/${segments.at(-1)}`;
    try {
      fileHandle = await fs.promises.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if (error.code === "ENOENT") return; // Idempotent retry after prior deletion.
      throw error;
    }
    const fileStat = await fileHandle.stat();
    const canonicalFile = await fs.promises.realpath(`/proc/self/fd/${fileHandle.fd}`);
    if (!fileStat.isFile() || !isPathWithin(canonicalRoot, canonicalFile)) {
      throw new Error("Private proof file is unsafe.");
    }
    // The procfs descriptor path anchors unlink to the already-opened directory,
    // so replacing a checked parent directory with a symlink cannot redirect it.
    await fs.promises.unlink(target);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new Error("Private proof file is unavailable or unsafe.");
  } finally {
    await fileHandle?.close().catch(() => {});
    await directoryHandle?.close().catch(() => {});
  }
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const extensionMimeTypes = {
  ".jpg": ["image/jpeg", "application/octet-stream"],
  ".jpeg": ["image/jpeg", "application/octet-stream"],
  ".png": ["image/png", "application/octet-stream"],
  ".webp": ["image/webp", "application/octet-stream"],
};
const maxUploadSize = 1024 * 1024 * 10;
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many image uploads. Please try again later.",
  },
  skip: () => process.env.NODE_ENV !== "production",
});

const createFileFilter = () => (req, file, cb) => {
  const extension = path.extname(file.originalname).toLowerCase();
  const acceptedMimeTypes = extensionMimeTypes[extension];

  if (acceptedMimeTypes?.includes(file.mimetype)) {
    return cb(null, true);
  }

  return cb(
    Object.assign(new Error(
      `Only image files are allowed. Received ${file.mimetype} (${extension || "no extension"}).`,
    ), { statusCode: 400 }),
  );
};

/**
 * Stream transformer used by every image upload. Product photos (options.enhance)
 * are buffered and run through the free studio-style enhancement; if anything goes
 * wrong we silently fall back to the plain resize so an upload never fails because
 * of the cosmetic step.
 */
function makeImageTransformer(req, options = {}) {
  const plain = () => sharp().rotate().resize(2400, 2400, {
    fit: "inside",
    withoutEnlargement: true,
  }).webp({ quality: 82 });
  if (!options.enhance || !enhancementEnabled(req)) return plain();

  const chunks = [];
  return new Transform({
    transform(chunk, _encoding, done) {
      chunks.push(chunk);
      done();
    },
    flush(done) {
      const original = Buffer.concat(chunks);
      enhanceProductPhoto(original)
        .then(({ buffer }) => buffer)
        .catch(() => sharp(original).rotate().resize(2400, 2400, {
          fit: "inside",
          withoutEnlargement: true,
        }).webp({ quality: 82 }).toBuffer())
        .then((buffer) => done(null, buffer), (error) => {
          error.statusCode = 400;
          done(error);
        });
    },
  });
}

const createStorage = (folder, getPublicId, options = {}) => ({
  _handleFile(req, file, callback) {
    try {
      if (options.private) ensurePrivateProofStorageConfigured();
      else ensureUploadStorageConfigured();
    } catch (error) {
      callback(error);
      return;
    }
    const folderName = typeof folder === "function" ? folder(req, file) : folder;
    if (!hasCloudinary()) {
      const safeFolders = String(folderName || "uploads")
        .split("/")
        .filter((part) => /^[A-Za-z0-9_-]+$/.test(part));
      const relativeDirectory = path.join(...safeFolders);
      const root = options.private ? privateProofRoot : localUploadRoot;
      const directory = path.join(root, relativeDirectory);
      const filename = options.private
        ? `payment_${crypto.randomUUID()}.webp`
        : `${Date.now()}_${crypto.randomUUID()}.webp`;
      const destination = path.join(directory, filename);
      fs.mkdir(directory, { recursive: true, mode: options.private ? 0o700 : undefined }, (mkdirError) => {
        if (mkdirError) return callback(mkdirError);
        const beginWriting = () => {
          let completed = false;
          const finish = (error, info) => {
            if (completed) return;
            completed = true;
            callback(error, info);
          };
          const transformer = makeImageTransformer(req, options);
          const output = fs.createWriteStream(destination, {
            flags: "wx",
            ...(options.private ? { mode: 0o600 } : {}),
          });
          const markInvalidImage = (error) => {
            if (!error.statusCode) error.statusCode = 400;
          };
          file.stream.on("error", markInvalidImage);
          transformer.on("error", markInvalidImage);
          pipeline(file.stream, transformer, output, (error) => {
            if (error) {
              fs.unlink(destination, () => {});
              return finish(error);
            }
            fs.stat(destination, (statError, stats) => {
              if (statError) return finish(statError);
              const relativePath = path.posix.join(...safeFolders, filename);
              finish(null, {
                path: options.private ? `proof:${relativePath}` : `/uploads/${relativePath}`,
                size: stats.size,
                filename: options.private ? `proof:${relativePath}` : relativePath,
              });
            });
          });
        };
        if (options.private) {
          fs.chmod(privateProofRoot, 0o700, (rootError) => {
            if (rootError) return callback(rootError);
            fs.chmod(path.join(privateProofRoot, "payment-proofs"), 0o700, (parentError) => {
              if (parentError) return callback(parentError);
              fs.chmod(directory, 0o700, (chmodError) => {
                if (chmodError) return callback(chmodError);
                beginWriting();
              });
            });
          });
        } else beginWriting();
      });
      return;
    }

    const publicId = getPublicId(req, file)
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 140);
    let completed = false;
    const finish = (error, info) => {
      if (completed) return;
      completed = true;
      callback(error, info);
    };
    const upload = cloudinary.uploader.upload_stream(
      {
        folder: folderName,
        public_id: publicId || crypto.randomUUID(),
        resource_type: "image",
        ...(options.private ? { type: "authenticated" } : {}),
        format: "webp",
        // Convert and resize at ingestion so stored assets are bounded and
        // use a compressed storefront format.
        transformation: [
          { width: 2400, height: 2400, crop: "limit" },
          { quality: "auto:good" },
        ],
      },
      (error, result) => {
        if (error) {
          if (error.http_code === 400 || error.name === "InputError") error.statusCode = 400;
          return finish(error);
        }
        finish(null, {
          path: options.private ? `proof:${result.public_id}` : result.secure_url,
          size: result.bytes,
          filename: result.public_id,
        });
      },
    );
    const transformer = makeImageTransformer(req, options);
    const markInvalidImage = (error) => {
      if (!error.statusCode) error.statusCode = 400;
    };
    file.stream.on("error", markInvalidImage);
    transformer.on("error", markInvalidImage);
    pipeline(file.stream, transformer, upload, (error) => {
      if (error) finish(error);
    });
  },

  _removeFile(_req, file, callback) {
    if (!hasCloudinary()) {
      const root = options.private ? privateProofRoot : localUploadRoot;
      const storedName = options.private
        ? privateProofLocation(file.filename)?.key
        : file.filename;
      if (typeof storedName !== "string") return callback(null);
      const resolvedPath = path.resolve(root, storedName);
      if (!resolvedPath.startsWith(`${path.resolve(root)}${path.sep}`)) return callback(null);
      return fs.unlink(resolvedPath, (error) => callback(error?.code === "ENOENT" ? null : error));
    }
    cloudinary.uploader.destroy(file.filename, {
      invalidate: true,
      ...(options.private ? { type: "authenticated" } : {}),
    }, callback);
  },
});

async function deleteUploadedImage(url) {
  if (typeof url !== "string") return;
  if (url.startsWith("/uploads/")) {
    const relativePath = path.posix.normalize(url.slice("/uploads/".length));
    if (relativePath.startsWith("..") || path.posix.isAbsolute(relativePath)) return;
    await fs.promises.unlink(path.join(localUploadRoot, relativePath)).catch(() => {});
    return;
  }
  if (!process.env.CLOUDINARY_CLOUD_NAME) return;
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "res.cloudinary.com" ||
      segments[0] !== process.env.CLOUDINARY_CLOUD_NAME ||
      segments[1] !== "image" ||
      segments[2] !== "upload"
    ) return;

    const assetSegments = segments.slice(3);
    if (assetSegments[0]?.startsWith("v") && /^v\d+$/.test(assetSegments[0])) {
      assetSegments.shift();
    }
    const filename = assetSegments.pop();
    if (!filename) return;
    const extensionless = filename.replace(/\.[^.]+$/, "");
    const publicId = [...assetSegments, extensionless].join("/");
    if (!publicId) return;
    await cloudinary.uploader.destroy(publicId, {
      invalidate: true,
      resource_type: "image",
    });
  } catch (error) {
    // Image cleanup should not undo the database operation that removed it.
    console.warn("Could not remove obsolete Cloudinary media.");
  }
}

const uploadCategory = multer({
  storage: createStorage(
    "categories",
    () => `category_${crypto.randomUUID()}`,
  ),
  limits: { fileSize: maxUploadSize },
  fileFilter: createFileFilter(),
});

const uploadProduct = multer({
  storage: createStorage("products", (req, file) => {
    const nameWithoutExt = path.basename(file.originalname, path.extname(file.originalname));
    return `product_${Date.now()}_${crypto.randomUUID()}_${nameWithoutExt}`;
  }, { enhance: true }),
  limits: { fileSize: maxUploadSize },
  fileFilter: createFileFilter(),
});

const uploadPosters = multer({
  storage: createStorage("posters", (req, file) => {
    const nameWithoutExt = path.basename(file.originalname, path.extname(file.originalname));
    return `poster_${Date.now()}_${crypto.randomUUID()}_${nameWithoutExt}`;
  }),
  limits: { fileSize: maxUploadSize },
  fileFilter: createFileFilter(),
});

const uploadBrand = multer({
  storage: createStorage("brands", () => `brand_${crypto.randomUUID()}`),
  limits: { fileSize: maxUploadSize },
  fileFilter: createFileFilter(),
});

const uploadPaymentProof = multer({
  storage: createStorage(
    (req) => `payment-proofs/${req.authUser._id}`,
    () => `payment_${crypto.randomUUID()}`,
    { private: true },
  ),
  limits: { fileSize: maxUploadSize },
  fileFilter: createFileFilter(),
});

module.exports = {
  uploadCategory,
  uploadProduct,
  uploadPosters,
  uploadBrand,
  uploadPaymentProof,
  uploadLimiter,
  cloudinary,
  hasCloudinary,
  ensureUploadStorageConfigured,
  ensurePrivateProofStorageConfigured,
  validateUploadStorageRoots,
  assertStorageRootsDisjoint,
  createPublicUploadHandler,
  saveLocalImage,
  savePrivatePaymentProof,
  privateProofLocation,
  deliverPrivatePaymentProof,
  deletePrivatePaymentProof,
  privateProofRoot,
  localUploadRoot,
  inspectPaymentProofAsset,
  deliverLegacyPaymentProof,
  trustedPrivateDownloadUrl,
  createFileFilter,
  deleteUploadedImage,
};
