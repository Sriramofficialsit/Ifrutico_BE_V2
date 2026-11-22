const mongoose = require("mongoose");

// Coupon code applied at billing. Rules are checked by utils/coupon.js on the server for every bill.
const CouponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, trim: true, uppercase: true, minlength: 3, maxlength: 20, match: /^[A-Z0-9_-]+$/ },
    description: { type: String, trim: true, maxlength: 200 },
    type: { type: String, enum: ["percent", "amount"], required: true },
    value: { type: Number, required: true, min: 0.01 },
    // Percent coupons only: never take off more than this many ₹ (0 / empty = no cap)
    maxDiscount: { type: Number, min: 0, default: 0 },
    // Items' value must be at least this much (₹)
    minBill: { type: Number, min: 0, default: 0 },
    validFrom: { type: Date },
    validTo: { type: Date },
    // Total uses across all customers (0 = unlimited) and uses per customer mobile (0 = unlimited)
    usageLimit: { type: Number, min: 0, default: 0 },
    perCustomerLimit: { type: Number, min: 0, default: 1 },
    usedCount: { type: Number, min: 0, default: 0 },
    // Which billing screens accept it; empty = all
    billTypes: { type: [{ type: String, enum: ["retail", "event", "stall"] }], default: [] },
    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "SalesPerson" },
  },
  { timestamps: true }
);

CouponSchema.index({ active: 1, validTo: 1 });

module.exports = mongoose.model("Coupon", CouponSchema);
