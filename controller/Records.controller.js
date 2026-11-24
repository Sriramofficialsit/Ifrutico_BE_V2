const express = require("express");
const router = express.Router();
const Joi = require("joi");
const mongoose = require("mongoose");
const RecordSheet = require("../models/RecordSheet.model");
const RecordRow = require("../models/RecordRow.model");
require("../models/Salesperson.model"); // registers "SalesPerson" for populate("updatedBy")
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const { validateObjectId } = require("../middleware/publicSubmit.middleware");

// Admin "Records": free-form spreadsheets kept in MongoDB.
router.use(verifyToken, authorizeRoles("admin"));

const MAX_SHEETS = 200;
const MAX_COLUMNS = 50;
const MAX_ROWS = 5000;
const MAX_ROWS_PER_CALL = 500;
const MAX_TEXT = 2000;
const COL_TYPES = ["text", "number", "date", "checkbox", "select"];

const columnSchema = Joi.object({
  key: Joi.string().pattern(/^c[a-z0-9]{4,16}$/).required(),
  name: Joi.string().trim().min(1).max(60).required(),
  type: Joi.string().valid(...COL_TYPES).default("text"),
  options: Joi.array().items(Joi.string().trim().min(1).max(60)).max(50).unique(),
  width: Joi.number().integer().min(60).max(600).default(160),
});
const columnsSchema = Joi.array().items(columnSchema).max(MAX_COLUMNS).unique("key");

const createSchema = Joi.object({
  name: Joi.string().trim().min(1).max(80).required(),
  description: Joi.string().trim().allow("").max(300).default(""),
  columns: columnsSchema.default([]),
});
const updateSchema = Joi.object({
  name: Joi.string().trim().min(1).max(80),
  description: Joi.string().trim().allow("").max(300),
  columns: columnsSchema,
}).min(1);
const cellValue = Joi.alternatives().try(Joi.string().allow("").max(MAX_TEXT), Joi.number(), Joi.boolean()).allow(null);
const cellsSchema = Joi.object().pattern(/^c[a-z0-9]{4,16}$/, cellValue);
const addRowsSchema = Joi.object({ rows: Joi.array().items(Joi.object({ cells: cellsSchema.default({}) })).min(1).max(MAX_ROWS_PER_CALL).required() });
const patchRowSchema = Joi.object({ cells: cellsSchema.min(1).required() });
const deleteRowsSchema = Joi.object({ ids: Joi.array().items(Joi.string().hex().length(24)).min(1).max(MAX_ROWS).unique().required() });

const bad = (res, message, code = 400) => res.status(code).json({ success: false, message });
const serverError = (res, err) => { console.error(err); return res.status(500).json({ success: false, message: "Server error." }); };

// Coerce a value to its column type; unknown keys are dropped. Returns the value to store.
function coerce(col, v) {
  if (v === null || v === undefined || v === "") return col.type === "checkbox" ? false : null;
  switch (col.type) {
    case "number": {
      const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
      return Number.isFinite(n) ? n : null;
    }
    case "checkbox":
      return v === true || v === 1 || /^(true|yes|y|1|✓|x)$/i.test(String(v).trim());
    case "date": {
      const s = String(v).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    }
    default:
      return String(v).slice(0, MAX_TEXT);
  }
}
function cleanCells(columns, cells) {
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const out = {};
  for (const [k, v] of Object.entries(cells || {})) {
    const col = byKey.get(k);
    if (col) out[k] = coerce(col, v);
  }
  return out;
}

// GET /records — list sheets
router.get("/", async (req, res) => {
  try {
    const sheets = await RecordSheet.find()
      .select("name description columns rowCount updatedAt createdAt")
      .populate("updatedBy", "name")
      .sort({ updatedAt: -1 })
      .limit(MAX_SHEETS)
      .lean();
    return res.json({ success: true, data: sheets.map((s) => ({ ...s, columnCount: s.columns.length, columns: undefined })) });
  } catch (err) { return serverError(res, err); }
});

// POST /records — create a sheet
router.post("/", async (req, res) => {
  try {
    const { error, value } = createSchema.validate(req.body);
    if (error) return bad(res, error.details[0].message);
    if ((await RecordSheet.estimatedDocumentCount()) >= MAX_SHEETS) return bad(res, `You can keep up to ${MAX_SHEETS} sheets. Delete an old one first.`);
    const sheet = await RecordSheet.create({ ...value, createdBy: req.user.id, updatedBy: req.user.id });
    return res.status(201).json({ success: true, message: "Sheet created", data: sheet });
  } catch (err) { return serverError(res, err); }
});

// GET /records/:id — sheet with all rows
router.get("/:id", validateObjectId, async (req, res) => {
  try {
    const sheet = await RecordSheet.findById(req.params.id).populate("updatedBy", "name").lean();
    if (!sheet) return bad(res, "Sheet not found", 404);
    const rows = await RecordRow.find({ sheet: sheet._id }).select("order cells updatedAt").sort({ order: 1 }).limit(MAX_ROWS).lean();
    return res.json({ success: true, data: { ...sheet, rows } });
  } catch (err) { return serverError(res, err); }
});

// PUT /records/:id — rename / change columns. Cells of removed columns are dropped; changed types are re-coerced.
router.put("/:id", validateObjectId, async (req, res) => {
  try {
    const { error, value } = updateSchema.validate(req.body);
    if (error) return bad(res, error.details[0].message);
    const sheet = await RecordSheet.findById(req.params.id);
    if (!sheet) return bad(res, "Sheet not found", 404);

    if (value.columns) {
      const oldByKey = new Map(sheet.columns.map((c) => [c.key, c]));
      const newKeys = new Set(value.columns.map((c) => c.key));
      const removed = sheet.columns.filter((c) => !newKeys.has(c.key)).map((c) => c.key);
      const retyped = value.columns.filter((c) => oldByKey.has(c.key) && oldByKey.get(c.key).type !== c.type);

      if (removed.length) {
        await RecordRow.updateMany({ sheet: sheet._id }, { $unset: Object.fromEntries(removed.map((k) => [`cells.${k}`, ""])) });
      }
      if (retyped.length) {
        const rows = await RecordRow.find({ sheet: sheet._id }).select("cells").lean();
        const ops = [];
        for (const r of rows) {
          const set = {};
          for (const col of retyped) if (r.cells && col.key in r.cells) set[`cells.${col.key}`] = coerce(col, r.cells[col.key]);
          if (Object.keys(set).length) ops.push({ updateOne: { filter: { _id: r._id }, update: { $set: set } } });
        }
        if (ops.length) await RecordRow.bulkWrite(ops, { ordered: false });
      }
      sheet.columns = value.columns.map((c) => (c.type === "select" ? c : { ...c, options: undefined }));
    }
    if (value.name !== undefined) sheet.name = value.name;
    if (value.description !== undefined) sheet.description = value.description;
    sheet.updatedBy = req.user.id;
    await sheet.save();
    return res.json({ success: true, message: "Sheet saved", data: sheet });
  } catch (err) { return serverError(res, err); }
});

// DELETE /records/:id — delete a sheet and its rows
router.delete("/:id", validateObjectId, async (req, res) => {
  try {
    const sheet = await RecordSheet.findByIdAndDelete(req.params.id);
    if (!sheet) return bad(res, "Sheet not found", 404);
    await RecordRow.deleteMany({ sheet: sheet._id });
    return res.json({ success: true, message: "Sheet deleted" });
  } catch (err) { return serverError(res, err); }
});

// POST /records/:id/rows — append rows (also used in chunks by .xlsx import)
router.post("/:id/rows", validateObjectId, async (req, res) => {
  try {
    const { error, value } = addRowsSchema.validate(req.body);
    if (error) return bad(res, error.details[0].message);
    const n = value.rows.length;
    // Reserve row positions and capacity atomically so concurrent adds can't exceed the cap.
    const sheet = await RecordSheet.findOneAndUpdate(
      { _id: req.params.id, rowCount: { $lte: MAX_ROWS - n } },
      { $inc: { rowCount: n, nextOrder: n }, $set: { updatedBy: req.user.id } }
    ).lean(); // returns the sheet as it was before the update (the reserved range starts at its nextOrder)
    if (!sheet) {
      const exists = await RecordSheet.exists({ _id: req.params.id });
      return exists ? bad(res, `A sheet can hold up to ${MAX_ROWS} rows.`) : bad(res, "Sheet not found", 404);
    }
    const docs = value.rows.map((r, i) => ({ sheet: sheet._id, order: sheet.nextOrder + i, cells: cleanCells(sheet.columns, r.cells), updatedBy: req.user.id }));
    try {
      const created = await RecordRow.insertMany(docs);
      return res.status(201).json({ success: true, data: created.map((d) => ({ _id: d._id, order: d.order, cells: d.cells, updatedAt: d.updatedAt })) });
    } catch (err) {
      await RecordSheet.updateOne({ _id: sheet._id }, { $inc: { rowCount: -n } }); // give the capacity back
      throw err;
    }
  } catch (err) { return serverError(res, err); }
});

// PATCH /records/:id/rows/:rowId — set some cells of one row
router.patch("/:id/rows/:rowId", validateObjectId, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.rowId)) return bad(res, "Invalid ID format");
    const { error, value } = patchRowSchema.validate(req.body);
    if (error) return bad(res, error.details[0].message);
    const sheet = await RecordSheet.findById(req.params.id).select("columns").lean();
    if (!sheet) return bad(res, "Sheet not found", 404);
    const cells = cleanCells(sheet.columns, value.cells);
    if (!Object.keys(cells).length) return bad(res, "Unknown column");
    const row = await RecordRow.findOneAndUpdate(
      { _id: req.params.rowId, sheet: sheet._id },
      { $set: { ...Object.fromEntries(Object.entries(cells).map(([k, v]) => [`cells.${k}`, v])), updatedBy: req.user.id } },
      { returnDocument: "after", projection: "order cells updatedAt" }
    ).lean();
    if (!row) return bad(res, "Row not found", 404);
    await RecordSheet.updateOne({ _id: sheet._id }, { $set: { updatedBy: req.user.id } });
    return res.json({ success: true, data: row });
  } catch (err) { return serverError(res, err); }
});

// POST /records/:id/rows/delete — delete rows by id
router.post("/:id/rows/delete", validateObjectId, async (req, res) => {
  try {
    const { error, value } = deleteRowsSchema.validate(req.body);
    if (error) return bad(res, error.details[0].message);
    const { deletedCount } = await RecordRow.deleteMany({ sheet: req.params.id, _id: { $in: value.ids } });
    await RecordSheet.updateOne({ _id: req.params.id }, { $inc: { rowCount: -deletedCount }, $set: { updatedBy: req.user.id } });
    return res.json({ success: true, message: `${deletedCount} row${deletedCount === 1 ? "" : "s"} deleted`, deleted: deletedCount });
  } catch (err) { return serverError(res, err); }
});

module.exports = router;
