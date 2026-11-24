const mongoose = require("mongoose");

// One shared (global) document: how Retail, Events & Functions and Stalls billing measure and convert into inventory units.
// Every branch reads the same values, so a change by admin applies everywhere at once.
const BillingConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: "global", unique: true },
    // Stalls: grams in one scoop (default for every stall bill; the bill can override it)
    scoopGrams: { type: Number, min: 10, max: 1000, default: 75 },
    // Events & Functions: box sizes offered, in litres
    boxSizes: {
      type: [{ type: Number, min: 0.1, max: 50 }],
      default: [0.5, 1, 2, 5],
    },
    // Weight of 1 litre of ice cream in grams — converts litres <-> grams for products stocked by weight
    // (or scoops in grams <-> products stocked by volume). 1000 = treat 1 g as 1 ml.
    gramsPerLitre: { type: Number, min: 100, max: 2000, default: 1000 },
    // Retail: measure a new bill line starts in (e.g. "kg"). "" = each product's own stock unit.
    // Products that can't be converted to it keep their own unit.
    retailUnit: { type: String, enum: ["", "pcs", "scoop", "g", "kg", "ml", "ltr"], default: "" },
  },
  { timestamps: true, versionKey: false }
);

BillingConfigSchema.statics.get = async function () {
  return this.findOneAndUpdate({ key: "global" }, { $setOnInsert: { key: "global" } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
};

module.exports = mongoose.model("BillingConfig", BillingConfigSchema);
