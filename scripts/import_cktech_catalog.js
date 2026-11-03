require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const mongoose = require("mongoose");
const sharp = require("sharp");
const Category = require("../model/category");
const SubCategory = require("../model/subCategory");
const Brand = require("../model/brand");
const Product = require("../model/product");
const Poster = require("../model/poster");
const Collection = require("../model/collection");
const VariantType = require("../model/variantType");
const Variant = require("../model/variant");

const manifestPath = path.join(__dirname, "data", "cktech_catalog_2026-10-16.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const root = path.join(__dirname, "..", "uploads", "catalog");
const apply = process.argv.includes("--apply");
const maxImages = 5;
const maxPrice = 100_000_000;

const categories = {
  mobile: { name: "Phones", subcategory: "Smartphones" },
  tablet: { name: "Tablets", subcategory: "Tablets" },
  laptop: { name: "Laptops", subcategory: "Laptops" },
  watch: { name: "Smartwatches", subcategory: "Smartwatches" },
  accessory: { name: "Accessories" },
};

const brandDefinitions = [
  { match: /^(?:apple|iphone\b)/i, name: "Apple", icon: "apple", color: "000000" },
  { match: /^samsung\b/i, name: "Samsung", icon: "samsung", color: "1428A0" },
  { match: /^huawei\b/i, name: "Huawei", icon: "huawei", color: "CF0A2C" },
  { match: /^anker\b/i, name: "Anker", icon: "anker", color: "111111" },
  { match: /^soundcore\b/i, name: "Soundcore", icon: "soundcore", color: "00A7E1" },
  { match: /^hollyland\b/i, name: "Hollyland", icon: null, color: "111111" },
  { match: /^dji\b/i, name: "DJI", icon: "dji", color: "111111" },
  { match: /^ugreen\b/i, name: "UGREEN", icon: "ugreen", color: "00A650" },
];
const categorySlugs = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const safeFilePart = (name) => categorySlugs(name).slice(0, 100) || "product";
const textForProduct = (value, max = 100) => {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const boundary = cut.lastIndexOf(" ");
  return `${cut.slice(0, boundary > max * 0.65 ? boundary : cut.length).trimEnd()}…`;
};

function sourceDescription(item) {
  const sourceText = String(item.description || item.title).replace(/\s+/g, " ").trim();
  const note = `Reference listing from ${manifest.retailer}, checked ${manifest.checkedAt.slice(0, 10)}. Price is a market reference, not a confirmed YoMart offer. Stock is unverified; update both in the admin before accepting orders.`;
  const room = Math.max(0, 1000 - note.length - 2);
  return `${sourceText.slice(0, Math.min(room, 700)).trim()}\n\n${note}`;
}

function productBrand(title) {
  const definition = brandDefinitions.find((entry) => entry.match.test(title));
  return definition || null;
}

function subcategoryName(type, title) {
  if (type !== "accessory") return categories[type]?.subcategory;
  if (/headphones?|earbuds?|freeclip|earphones?/i.test(title)) return "Audio";
  if (/microphone|\bmic\b|gimbal|osmo mobile/i.test(title)) return "Audio & Video";
  if (/charger|charging|power bank|charge cable|usb-c cable|adapter/i.test(title)) return "Power & Charging";
  if (/case|cover|screen protector/i.test(title)) return "Cases & Protection";
  if (/pencil|stylus/i.test(title)) return "Styluses";
  return "Other Accessories";
}

function storageOptions(title) {
  const values = new Set();
  const regex = /\b(64|128|256|512)\s?GB\b|\b(1|2)\s?TB\b/gi;
  for (const match of title.matchAll(regex)) {
    const size = (match[0].replace(/\s+/g, "").toUpperCase());
    const normalized = size.replace(/(\d+)(GB|TB)/, "$1 $2");
    values.add(normalized);
  }
  return [...values];
}

async function fetchImage(sourceUrl, destination, maxEdge = 2000) {
  if (fs.existsSync(destination) && fs.statSync(destination).size > 0) return;
  let response;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      response = await axios.get(sourceUrl, {
        responseType: "arraybuffer",
        timeout: 20000,
        maxContentLength: 20 * 1024 * 1024,
        headers: { "User-Agent": "YoMart local catalog importer/1.0" },
      });
      break;
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  const buffer = Buffer.from(response.data);
  const metadata = await sharp(buffer).metadata();
  if (!metadata.width || !metadata.height || !metadata.format) {
    throw new Error(`Not a decodable image: ${sourceUrl}`);
  }
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await sharp(buffer)
    .rotate()
    .resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82, effort: 5 })
    .toFile(destination);
}

async function downloadProductImages(item, index) {
  const slug = `${String(index + 1).padStart(2, "0")}-${safeFilePart(item.title)}`;
  const sources = item.imageSources.slice(0, maxImages);
  const output = [];
  await Promise.all(sources.map(async (sourceUrl, imageIndex) => {
    const relative = `/uploads/catalog/products/${slug}-${String(imageIndex + 1).padStart(2, "0")}.webp`;
    const destination = path.join(root, "products", `${slug}-${String(imageIndex + 1).padStart(2, "0")}.webp`);
    try {
      await fetchImage(sourceUrl, destination);
      output.push({ image: imageIndex + 1, url: relative });
    } catch (error) {
      console.warn(`Image ${imageIndex + 1} skipped for ${item.title}: ${error.code || error.message}`);
    }
  }));
  const downloaded = output.sort((a, b) => a.image - b.image);
  if (downloaded.length === 0) throw new Error(`No downloadable images for ${item.title}`);
  return downloaded.map((entry, index) => ({ ...entry, image: index + 1 }));
}

async function downloadBrandLogo(brand) {
  if (!brand.icon) return "";
  const relative = `/uploads/catalog/brands/${brand.icon}.webp`;
  const destination = path.join(root, "brands", `${brand.icon}.webp`);
  if (!fs.existsSync(destination)) {
    const url = `https://cdn.simpleicons.org/${brand.icon}/${brand.color}`;
    try {
      const response = await axios.get(url, { responseType: "arraybuffer", timeout: 15000 });
      const buffer = Buffer.from(response.data);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      await sharp(buffer).resize(512, 512, { fit: "contain" }).webp({ quality: 90 }).toFile(destination);
    } catch (error) {
      console.warn(`Brand logo skipped for ${brand.name}: ${error.message}`);
      return "";
    }
  }
  return relative;
}

async function main() {
  if (!process.env.MONGO_URL) throw new Error("MONGO_URL is not configured.");
  const target = new URL(process.env.MONGO_URL);
  const databaseName = target.pathname.replace(/^\//, "").split("/")[0];
  if (databaseName !== "yomart_local") {
    throw new Error(`Refusing to import into '${databaseName}'. Expected the local yomart_local database.`);
  }
  if (manifest.items.length === 0 || manifest.items.some((item) => !item.title || item.price <= 0 || item.price > maxPrice || !item.productUrl || item.imageSources.length === 0)) {
    throw new Error("Catalog snapshot failed validation.");
  }
  if (!apply) {
    console.log(`Dry run only: ${manifest.items.length} products, ${Object.keys(categories).length} categories, from ${manifest.retailer}.`);
    console.log("Run with --apply and CATALOG_SEED_CONFIRM=yomart_local to import and download optimized media.");
    return;
  }
  if (process.env.CATALOG_SEED_CONFIRM !== "yomart_local") {
    throw new Error("Set CATALOG_SEED_CONFIRM=yomart_local to confirm writes to the local database.");
  }

  await mongoose.connect(process.env.MONGO_URL, { serverSelectionTimeoutMS: 15000 });
  if (mongoose.connection.db.databaseName !== "yomart_local") throw new Error("Connected to an unexpected database.");
  console.log(`Connected to ${mongoose.connection.db.databaseName}; preparing ${manifest.items.length} sourced listings.`);

  // Download and validate every photo before changing database records.
  const imageSets = [];
  const batchSize = 5;
  for (let start = 0; start < manifest.items.length; start += batchSize) {
    const batch = await Promise.allSettled(manifest.items.slice(start, start + batchSize).map((item, offset) =>
      downloadProductImages(item, start + offset),
    ));
    for (const [offset, result] of batch.entries()) {
      if (result.status === "fulfilled") imageSets.push(result.value);
      else {
        imageSets.push([]);
        console.warn(`Product skipped; no verified product image downloaded: ${manifest.items[start + offset].title}`);
      }
    }
    console.log(`Prepared images for ${imageSets.length}/${manifest.items.length} products.`);
  }

  const categoryDocs = new Map();
  const subcategoryDocs = new Map();
  const productsByCategory = new Map();
  const productsByTitle = new Map();
  let categorySortOrder = 0;
  for (const [sourceType, definition] of Object.entries(categories)) {
    const firstProductIndex = manifest.items.findIndex((item, index) => item.category === sourceType && imageSets[index].length > 0);
    if (firstProductIndex < 0) continue;
    const category = await Category.findOneAndUpdate(
      { name: definition.name },
      { $set: { name: definition.name, image: imageSets[firstProductIndex][0].url, sortOrder: categorySortOrder++, isActive: true, createdBy: null } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
    categoryDocs.set(sourceType, category);
    productsByCategory.set(sourceType, []);
  }

  for (const item of manifest.items) {
    const category = categoryDocs.get(item.category);
    const name = subcategoryName(item.category, item.title);
    const key = `${item.category}/${name}`;
    if (!category || subcategoryDocs.has(key)) continue;
    const subcategory = await SubCategory.findOneAndUpdate(
      { name, categoryId: category._id },
      { $set: { name, categoryId: category._id, createdBy: null } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
    subcategoryDocs.set(key, subcategory);
  }

  const logoUrls = new Map();
  for (const brand of brandDefinitions) logoUrls.set(brand.name, await downloadBrandLogo(brand));

  const storageType = await VariantType.findOneAndUpdate(
    { name: "Storage", type: "Storage" },
    { $set: { name: "Storage", type: "Storage", createdBy: null } },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
  );
  let sortOrder = 0;
  for (const [index, item] of manifest.items.entries()) {
    if (imageSets[index].length === 0) continue;
    const type = categories[item.category];
    const category = categoryDocs.get(item.category);
    const subcategory = subcategoryDocs.get(`${item.category}/${subcategoryName(item.category, item.title)}`);
    if (!type || !category || !subcategory) continue;

    const brandDefinition = productBrand(item.title);
    let brand = null;
    if (brandDefinition) {
      brand = await Brand.findOneAndUpdate(
        { name: brandDefinition.name },
        { $set: {
          name: brandDefinition.name,
          logoUrl: logoUrls.get(brandDefinition.name) || "",
          isActive: true,
          createdBy: null,
        } },
        { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
      );
    }

    const options = storageOptions(item.title);
    const variantIds = [];
    for (const name of options) {
      const variant = await Variant.findOneAndUpdate(
        { name, variantTypeId: storageType._id },
        { $set: { name, variantTypeId: storageType._id, createdBy: null } },
        { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
      );
      variantIds.push(variant._id.toString());
    }

    const productName = textForProduct(item.displayName || item.title, 100);
    const product = await Product.findOneAndUpdate(
      { "catalogSource.productUrl": item.productUrl },
      { $set: {
        name: productName,
        description: sourceDescription(item),
        quantity: 0,
        price: item.price,
        proCategoryId: category._id,
        proSubCategoryId: subcategory._id,
        ...(brand ? { proBrandId: brand._id } : {}),
        proVariantTypeId: options.length ? storageType._id : undefined,
        proVariantId: variantIds,
        images: imageSets[index],
        sortOrder: sortOrder++,
        isActive: true,
        catalogSource: {
          retailer: manifest.retailer,
          productUrl: item.productUrl,
          checkedAt: manifest.checkedAt,
          originalTitle: item.title.slice(0, 300),
          imageSources: item.imageSources.slice(0, maxImages),
          note: "Market price only; not YoMart's approved selling price. YoMart stock is unverified and set to zero.",
        },
        createdBy: null,
      } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
    productsByCategory.get(item.category).push(product._id);
    productsByTitle.set(item.title, product);
  }

  // Legacy data created one brand document per subcategory. Consolidate those
  // records so one brand page represents every product carrying that brand.
  const duplicateBrandNames = await Brand.aggregate([
    { $group: { _id: "$name", ids: { $push: "$_id" }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  for (const duplicate of duplicateBrandNames) {
    const canonicalId = duplicate.ids[0];
    for (const oldId of duplicate.ids.slice(1)) {
      await Product.updateMany({ proBrandId: oldId }, { $set: { proBrandId: canonicalId } });
      await Brand.findByIdAndDelete(oldId);
    }
  }

  const posterSources = [
    { category: "mobile", contains: "iphone 18 pro max", subtitle: "Explore the latest iPhone range." },
    { category: "mobile", contains: "Samsung Galaxy S26 Ultra", subtitle: "Explore Samsung flagship phones." },
    { category: "laptop", contains: "MacBook Air 13-inch Laptop with M5", subtitle: "Find a Mac for work and study." },
    { category: "tablet", contains: "Galaxy Tab S10 Ultra", subtitle: "Explore tablets for work and entertainment." },
  ];
  for (const [index, poster] of posterSources.entries()) {
    const sourceIndex = manifest.items.findIndex((item) => item.category === poster.category && item.title.toLowerCase().includes(poster.contains.toLowerCase()));
    if (sourceIndex < 0) continue;
    const product = [...productsByCategory.get(poster.category)].find((id) => id.toString() === productsByTitle.get(manifest.items[sourceIndex].title)?._id.toString());
    if (!product) continue;
    const posterTitle = productsByTitle.get(manifest.items[sourceIndex].title).name;
    await Poster.findOneAndUpdate(
      { posterName: posterTitle },
      { $set: { posterName: posterTitle, subtitle: poster.subtitle, imageUrl: imageSets[sourceIndex][0].url, sortOrder: index, isActive: true, createdBy: null } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
  }

  const collectionDefinitions = [
    ["Smartphones", "Phones from the current catalog", "mobile"],
    ["Tablets", "Tablets for work, study, and entertainment", "tablet"],
    ["Laptops", "Laptops and notebooks", "laptop"],
    ["Smartwatches", "Smartwatches and wearables", "watch"],
    ["Accessories", "Audio, charging, and protection accessories", "accessory"],
  ];
  for (const [index, [title, subtitle, type]] of collectionDefinitions.entries()) {
    await Collection.findOneAndUpdate(
      { title },
      { $set: { title, subtitle, productIds: productsByCategory.get(type) || [], sortOrder: index, isActive: true, createdBy: null } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
  }

  const counts = {};
  for (const collection of ["categories", "subcategories", "brands", "products", "posters", "collections", "varianttypes", "variants", "users", "orders"]) {
    counts[collection] = await mongoose.connection.db.collection(collection).countDocuments();
  }
  console.log(`Catalog import complete: ${JSON.stringify(counts)}`);
  console.log("Inventory remains 0 until confirmed; imported ETB values are explicitly identified as CK Tech reference prices in product details and source metadata.");
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(async () => mongoose.disconnect());
