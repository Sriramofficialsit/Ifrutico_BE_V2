const mongoose = require("mongoose");

const recordRowSchema = new mongoose.Schema({
  sheet: { type: mongoose.Schema.Types.ObjectId, ref: "RecordSheet", required: true },
  order: { type: Number, required: true },
  cells: { type: mongoose.Schema.Types.Mixed, default: {} }, // { [columnKey]: string | number | boolean | null }
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "SalesPerson" },
}, { timestamps: true, minimize: false });

recordRowSchema.index({ sheet: 1, order: 1 });

module.exports = mongoose.model("RecordRow", recordRowSchema);
