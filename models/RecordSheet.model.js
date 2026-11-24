const mongoose = require("mongoose");

// A free-form admin spreadsheet ("Records"). Rows live in RecordRow so a sheet can grow
// without hitting the 16MB document limit and each cell edit is a small update.
const columnSchema = new mongoose.Schema({
  key: { type: String, required: true },            // stable id used as the cell key in rows
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: ["text", "number", "date", "checkbox", "select"], default: "text" },
  options: { type: [String], default: undefined },  // choices for "select"
  width: { type: Number, default: 160 },
}, { _id: false });

const recordSheetSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  description: { type: String, trim: true, maxlength: 300, default: "" },
  columns: { type: [columnSchema], default: [] },
  rowCount: { type: Number, default: 0 },
  nextOrder: { type: Number, default: 0 },          // monotonically increasing row position
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "SalesPerson" },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "SalesPerson" },
}, { timestamps: true });

recordSheetSchema.index({ updatedAt: -1 });

module.exports = mongoose.model("RecordSheet", recordSheetSchema);
