const mongoose = require("mongoose");

const ProductSchema = new mongoose.Schema(
{
  sku: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true,
    maxlength: 30,
  },

  itemName: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100,
  },

  // Preset categories (fruits, vegetables, ...) or any custom one typed by the admin
  category: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    maxlength: 50,
  },

  price: {
    type: Number,
    required: true,
    min: 0
  },

  // How many units the price is for, e.g. price 120 + priceQty 500 + unit "g" = ₹120 per 500 g.
  // Billing charges price / priceQty for every unit sold, so any custom weight can be billed.
  priceQty: {
    type: Number,
    min: 0.001,
    default: 1,
  },

  // Unit the price and stock are measured in (price is "per priceQty units", stock is a quantity of that unit).
  // The dashboard enters/shows stock as packs of priceQty (5 x 1000 g); it is stored here in units (5000 g).
  unit: {
    type: String,
    enum: ["pcs", "g", "kg", "ml", "ltr"],
    default: "pcs",
  },

  // true  = the price already contains 5% GST (billing adds nothing on top)
  // false = the price is before GST (billing adds 5% on top) — also the behaviour of every product created before this flag existed
  gstIncluded: {
    type: Boolean,
    default: false,
  },

  stock: {
    type: Number,
    required: true,
    min: 0,
    default: 0
  },

  // 🖼️ NEW: images field
  images: [
    {
      type: String // stores image URLs
    }
  ]
},
{ timestamps: true }
);



ProductSchema.index({ itemName: "text" });
ProductSchema.index({ category: 1, price: 1 });
ProductSchema.index({ createdAt: -1 });



ProductSchema.virtual("status").get(function () {
  if (this.stock === 0) return "out_of_stock";
  if (this.stock / (this.priceQty || 1) <= 5) return "low_stock"; // 5 packs or fewer
  return "in_stock";
});


ProductSchema.set("toJSON", { virtuals: true });
ProductSchema.set("toObject", { virtuals: true });

module.exports = mongoose.model("Product", ProductSchema);