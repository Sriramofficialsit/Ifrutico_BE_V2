const mongoose = require("mongoose");

// Stock of one product held at one branch (a branch is a SalesPerson/staff account).
// Product.stock stays the central (warehouse) stock that admin transfers from.
const BranchStockSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: "SalesPerson", required: true },
    stock: { type: Number, required: true, min: 0, default: 0 },
  },
  { timestamps: true }
);

BranchStockSchema.index({ product: 1, branch: 1 }, { unique: true });
BranchStockSchema.index({ branch: 1 });

module.exports = mongoose.model("BranchStock", BranchStockSchema);
