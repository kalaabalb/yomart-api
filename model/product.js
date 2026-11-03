const mongoose = require("mongoose");

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Product name is required"],
      trim: true,
      minlength: [2, "Product name must be at least 2 characters long"],
      maxlength: [100, "Product name cannot exceed 100 characters"],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [1000, "Description cannot exceed 1000 characters"],
    },
    quantity: {
      type: Number,
      required: [true, "Product quantity is required"],
      min: [0, "Quantity cannot be negative"],
      default: 0,
    },
    sortOrder: {
      type: Number,
      min: [0, "Sort order cannot be negative"],
      default: 0,
    },
    price: {
      type: Number,
      required: [true, "Product price is required"],
      min: [0, "Price cannot be negative"],
    },
    offerPrice: {
      type: Number,
      min: [0, "Offer price cannot be negative"],
      validate: {
        validator: function (value) {
          return value === null || value <= this.price;
        },
        message: "Offer price cannot be higher than regular price",
      },
    },
    proCategoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: [true, "Product category is required"],
    },
    proSubCategoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubCategory",
      required: [true, "Product subcategory is required"],
    },
    proBrandId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Brand",
    },
    proVariantTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "VariantType",
    },
    proVariantId: [
      {
        type: String,
        trim: true,
      },
    ],
    images: [
      {
        image: {
          type: Number,
          required: true,
          min: 1,
          max: 5,
        },
        url: {
          type: String,
          required: true,
        },
      },
    ],
    // Keep imported listing provenance with the product so administrators can
    // verify market prices and image origins before changing the listing.
    catalogSource: {
      retailer: { type: String, trim: true, maxlength: 100 },
      productUrl: { type: String, trim: true, maxlength: 1000 },
      checkedAt: { type: Date },
      originalTitle: { type: String, trim: true, maxlength: 300 },
      imageSources: [{ type: String, trim: true, maxlength: 1000 }],
      note: { type: String, trim: true, maxlength: 300 },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    // Public search engines should only receive listings whose product data,
    // price, stock, and media have been confirmed by an administrator.
    isSearchVerified: {
      type: Boolean,
      default: false,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdminUser",
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Virtual for checking if product is in stock
productSchema.virtual("inStock").get(function () {
  return this.quantity > 0;
});

// Virtual for checking if product has discount
productSchema.virtual("hasDiscount").get(function () {
  return this.offerPrice && this.offerPrice < this.price;
});

// Index for better search performance
productSchema.index({ name: "text", description: "text" });
productSchema.index({ proCategoryId: 1 });
productSchema.index({ proSubCategoryId: 1 });
productSchema.index({ createdAt: -1 });

const Product = mongoose.model("Product", productSchema);
module.exports = Product;
