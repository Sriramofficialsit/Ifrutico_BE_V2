const mongoose = require("mongoose");

// Customer profile, saved/updated automatically every time a bill is created.
// Order counts, revenue and invoices are NOT stored here: they are computed from Bill so they can never drift.
const CustomerSchema = new mongoose.Schema(
  {
    mobile: {
      type: String,
      required: true,
      unique: true,
      match: /^[0-9]{10}$/,
    },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, trim: true, lowercase: true, maxlength: 150 },
    gstNumber: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 30,
    },
  },
  { timestamps: true }
);

CustomerSchema.index({ name: 1 });

module.exports = mongoose.model("Customer", CustomerSchema);
