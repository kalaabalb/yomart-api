require("dotenv").config();

const mongoose = require("mongoose");
const Brand = require("../model/brand");
const Category = require("../model/category");
const SubCategory = require("../model/subCategory");

const referenceBrands = [
  "Apple",
  "Samsung",
  "Google",
  "OnePlus",
  "Xiaomi",
  "Sony",
  "Nothing",
  "Oppo",
];

async function main() {
  const mongoUrl = process.env.MONGO_URL;
  if (!mongoUrl) throw new Error("MONGO_URL is not configured.");

  const target = new URL(mongoUrl);
  const databaseName = target.pathname.replace(/^\//, "").split("/")[0];
  if (databaseName !== "rapid") {
    throw new Error("Refusing to update: expected the project's rapid database.");
  }

  await mongoose.connect(mongoUrl, { serverSelectionTimeoutMS: 15000 });
  try {
    const phoneCategory = await Category.findOne({ name: "Phones" });
    if (!phoneCategory) throw new Error('The "Phones" category is missing.');

    const smartphones = await SubCategory.findOne({
      name: "Smartphones",
      categoryId: phoneCategory._id,
    });
    if (!smartphones) throw new Error('The "Smartphones" subcategory is missing.');

    const missing = [];
    for (const name of referenceBrands) {
      const exists = await Brand.exists({
        name: { $regex: `^${name}$`, $options: "i" },
      });
      if (!exists) missing.push(name);
    }

    console.log(`Database: ${databaseName}`);
    console.log(`Reference brands present: ${referenceBrands.length - missing.length}/8`);
    console.log(`Brands to add: ${missing.length ? missing.join(", ") : "none"}`);

    if (!process.argv.includes("--apply")) {
      console.log("Read-only preview. Re-run with --apply to add missing brand records.");
      return;
    }

    for (const name of missing) {
      await Brand.create({
        name,
        subcategoryId: smartphones._id,
        createdBy: null,
      });
    }
    console.log("Reference brand records are ready.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
  mongoose.disconnect();
});
