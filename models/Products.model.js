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

  category: {
    type: String,
    enum: ["fruits", "vegetables", "flowers", "nuts", "spices", "herbals"],
    required: true,
  },

  price: {
    type: Number,
    required: true,
    min: 0
  },

  // Unit the price and stock are measured in (price is "per unit", stock is a quantity of that unit)
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
  if (this.stock <= 5) return "low_stock";
  return "in_stock";
});


ProductSchema.set("toJSON", { virtuals: true });
ProductSchema.set("toObject", { virtuals: true });

module.exports = mongoose.model("Product", ProductSchema);