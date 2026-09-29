const product = require("express").Router();
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");
const Product = require("../models/Products.model");
const BranchStock = require("../models/BranchStock.model");
const SalesPerson = require("../models/Salesperson.model");
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const Joi = require("joi");
const upload = require("../middleware/upload.middleware");

const uploadsDir = path.resolve(__dirname, "..", "uploads", "products");

// Best-effort removal of files on disk (paths are either multer files or stored "/uploads/products/x" URLs)
const removeImages = (imgPaths = []) => {
  imgPaths.forEach((imgPath) => {
    const fullPath = path.resolve(__dirname, "..", String(imgPath).replace(/^\//, ""));
    if (fullPath.startsWith(uploadsDir + path.sep)) fs.unlink(fullPath, () => {});
  });
};
const removeUploaded = (files = []) => removeImages(files.map((f) => `/uploads/products/${f.filename}`));

const withStatus = (p) => ({
  ...p,
  unit: p.unit || "pcs", // documents created before units existed
  status: p.stock === 0 ? "out_of_stock" : p.stock <= 5 ? "low_stock" : "in_stock",
});

// The browser-declared mimetype is attacker-controlled, so also check the file's real signature (magic bytes)
const looksLikeImage = (filePath) => {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const png = buf.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    return jpeg || png;
  } catch {
    return false;
  }
};

// Turns multer errors (type/size) into 400s instead of an unhandled 500
const handleUpload = (req, res, next) => {
  upload.array("images", 5)(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });
    const bad = (req.files || []).find((f) => !looksLikeImage(f.path));
    if (bad) {
      removeUploaded(req.files);
      return res.status(400).json({ success: false, message: "Uploaded file is not a valid JPG or PNG image" });
    }
    next();
  });
};

const UNITS = ["pcs", "g", "kg", "ml", "ltr"];

// Countable items can't be fractional; weights/volumes can (up to 3 decimals, e.g. 0.250 kg)
const stockError = (unit, stock) =>
  unit === "pcs" && !Number.isInteger(stock) ? "Stock must be a whole number for items counted in pcs." : null;

const productSchema = Joi.object({
  sku: Joi.string().trim().max(30).required(),
  itemName: Joi.string().trim().max(100).required(),
  category: Joi.string()
    .valid("fruits", "vegetables", "flowers", "nuts", "spices", "herbals")
    .required(),
  price: Joi.number().min(0).required(),
  unit: Joi.string().valid(...UNITS).default("pcs"),
  gstIncluded: Joi.boolean().default(false), // multipart sends "true"/"false"; Joi converts
  stock: Joi.number().min(0).precision(3).required()
});

const fetchSchema = Joi.object({
  page: Joi.number().min(1).default(1),
  limit: Joi.number().min(1).max(1000).default(10),
  category: Joi.string().valid(
    "fruits", "vegetables", "flowers", "nuts", "spices", "herbals"
  ),
  search: Joi.string().allow(""),
  // admin only: "central" (default) or a branch id. Staff are always pinned to their own branch.
  branch: Joi.string().allow("")
});

const transferSchema = Joi.object({
  sku: Joi.string().trim().max(30).required(),
  branchId: Joi.string().length(24).required(),
  quantity: Joi.number().min(0.001).precision(3).required(),
  // to_branch: central -> branch, to_central: branch -> central (return)
  direction: Joi.string().valid("to_branch", "to_central").default("to_branch"),
});

const updateProductSchema = Joi.object({
  itemName: Joi.string().trim().max(100),
  category: Joi.string().valid(
    "fruits", "vegetables", "flowers", "nuts", "spices", "herbals"
  ),
  price: Joi.number().min(0),
  unit: Joi.string().valid(...UNITS),
  gstIncluded: Joi.boolean(),
  stock: Joi.number().min(0).precision(3)
}).min(1); 



product.post("/add", verifyToken, authorizeRoles("admin"), handleUpload, async (req, res) => {
    try {
      const { error, value } = productSchema.validate(req.body, {
        abortEarly: false
      });

      if (error) {
        removeUploaded(req.files);
        return res.status(400).json({
          success: false,
          message: error.details.map(err => err.message)
        });
      }

      let { sku, itemName, category, price, unit, stock, gstIncluded } = value;

      const unitStockError = stockError(unit, stock);
      if (unitStockError) {
        removeUploaded(req.files);
        return res.status(400).json({ success: false, message: [unitStockError] });
      }

      
      const imageUrls = req.files?.map(
        (file) => `/uploads/products/${file.filename}`
      ) || [];

      
      const existing = await Product.findOne({ sku });
      if (existing) {
        removeUploaded(req.files);
        return res.status(400).json({
          success: false,
          message: "SKU already exists"
        });
      }
      const newProduct = await Product.create({
        sku,
        itemName,
        category,
        price,
        unit,
        gstIncluded,
        stock,
        images: imageUrls
      });

      return res.status(201).json({
        success: true,
        data: newProduct
      });

    } catch (error) {
      removeUploaded(req.files);
      if (error.code === 11000) {
        return res.status(400).json({
          success: false,
          message: "SKU already exists"
        });
      }

      return res.status(500).json({
        success: false,
        message: "Internal Server Error"
      });
    }
  }
);
product.get("/fetch", verifyToken, async (req, res) => {
  try {
    const { error, value } = fetchSchema.validate(req.query, { abortEarly: false });
    if (error) {
      return res.status(400).json({ success: false, message: error.details.map((err) => err.message) });
    }
    const { page, limit, category, search } = value;
    const skip = (page - 1) * limit;
    const isAdmin = req.user.role === "admin";

    // Which stock the `stock` field reports: staff -> own branch; admin -> chosen branch or central
    let branchId = null;
    if (!isAdmin) branchId = req.user.id;
    else if (value.branch && value.branch !== "central") {
      if (!mongoose.Types.ObjectId.isValid(value.branch)) {
        return res.status(400).json({ success: false, message: "Invalid branch ID" });
      }
      branchId = value.branch;
    }

    const query = {};
    if (category) query.category = category;
    if (search) query.$text = { $search: search };

    const [products, total] = await Promise.all([
      Product.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Product.countDocuments(query),
    ]);

    const ids = products.map((p) => p._id);
    const rows = await BranchStock.find({ product: { $in: ids }, ...(isAdmin ? {} : { branch: branchId }) })
      .populate("branch", "name")
      .lean();

    const data = products.map((p) => {
      const mine = rows.filter((r) => String(r.product) === String(p._id));
      const out = { ...p };
      if (isAdmin) out.centralStock = p.stock; // central (warehouse) stock is admin-only
      if (branchId) out.stock = mine.find((r) => String(r.branch?._id || r.branch) === String(branchId))?.stock || 0;
      if (isAdmin) {
        out.branchStocks = mine
          .filter((r) => r.branch)
          .map((r) => ({ branchId: r.branch._id, branchName: r.branch.name, stock: r.stock }));
      }
      return withStatus(out);
    });

    return res.status(200).json({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      data,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// Admin: move stock between central and a branch. Each step is an atomic guarded update.
product.post("/transfer", verifyToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const { error, value } = transferSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({ success: false, message: error.details.map((e) => e.message) });
    }
    const { branchId, quantity, direction } = value;
    const sku = value.sku.toUpperCase();

    const branch = await SalesPerson.findOne({ _id: branchId, role: "staff" }).select("name").lean();
    if (!branch) return res.status(404).json({ success: false, message: "Branch not found" });

    const prod = await Product.findOne({ sku }).select("unit itemName").lean();
    if (!prod) return res.status(404).json({ success: false, message: "Product not found" });
    const unitStockErr = stockError(prod.unit || "pcs", quantity);
    if (unitStockErr) return res.status(400).json({ success: false, message: [unitStockErr] });

    if (direction === "to_branch") {
      const from = await Product.findOneAndUpdate({ _id: prod._id, stock: { $gte: quantity } }, { $inc: { stock: -quantity } });
      if (!from) return res.status(400).json({ success: false, message: "Not enough central stock" });
      try {
        await BranchStock.findOneAndUpdate(
          { product: prod._id, branch: branchId },
          { $inc: { stock: quantity } },
          { upsert: true, setDefaultsOnInsert: true }
        );
      } catch (e) {
        await Product.updateOne({ _id: prod._id }, { $inc: { stock: quantity } });
        throw e;
      }
    } else {
      const from = await BranchStock.findOneAndUpdate(
        { product: prod._id, branch: branchId, stock: { $gte: quantity } },
        { $inc: { stock: -quantity } }
      );
      if (!from) return res.status(400).json({ success: false, message: `${branch.name} doesn't have that much stock` });
      await Product.updateOne({ _id: prod._id }, { $inc: { stock: quantity } });
    }

    return res.status(200).json({ success: true, message: "Stock transferred" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});
// Admin: move many products at once between central and one branch. All-or-nothing:
// if any line fails, the lines already applied are reversed and nothing changes.
const bulkTransferSchema = Joi.object({
  branchId: Joi.string().length(24).required(),
  direction: Joi.string().valid("to_branch", "to_central").default("to_branch"),
  items: Joi.array()
    .items(Joi.object({ sku: Joi.string().trim().max(30).required(), quantity: Joi.number().min(0.001).precision(3).required() }))
    .min(1).max(200).required(),
});

product.post("/transfer-bulk", verifyToken, authorizeRoles("admin"), async (req, res) => {
  const applied = []; // { productId, quantity } already moved, for rollback
  let direction = "to_branch";
  let branchId;
  const undo = async () => {
    for (const a of applied.reverse()) {
      try {
        if (direction === "to_branch") {
          await Product.updateOne({ _id: a.productId }, { $inc: { stock: a.quantity } });
          await BranchStock.updateOne({ product: a.productId, branch: branchId }, { $inc: { stock: -a.quantity } });
        } else {
          await BranchStock.updateOne({ product: a.productId, branch: branchId }, { $inc: { stock: a.quantity } });
          await Product.updateOne({ _id: a.productId }, { $inc: { stock: -a.quantity } });
        }
      } catch (e) {
        console.error("Bulk transfer rollback failed:", e);
      }
    }
  };

  try {
    const { error, value } = bulkTransferSchema.validate(req.body, { abortEarly: false });
    if (error) return res.status(400).json({ success: false, message: error.details.map((e) => e.message) });
    ({ branchId, direction } = value);

    const branch = await SalesPerson.findOne({ _id: branchId, role: "staff" }).select("name").lean();
    if (!branch) return res.status(404).json({ success: false, message: "Branch not found" });

    // Merge duplicate SKUs so one product can't be listed twice
    const wanted = new Map();
    value.items.forEach((i) => {
      const sku = i.sku.toUpperCase();
      wanted.set(sku, Math.round(((wanted.get(sku) || 0) + i.quantity) * 1000) / 1000);
    });

    const prods = await Product.find({ sku: { $in: [...wanted.keys()] } }).select("sku itemName unit").lean();
    const bySku = new Map(prods.map((p) => [p.sku, p]));
    const missing = [...wanted.keys()].filter((k) => !bySku.has(k));
    if (missing.length) return res.status(404).json({ success: false, message: `Product not found: ${missing.join(", ")}` });

    for (const [sku, quantity] of wanted) {
      const prod = bySku.get(sku);
      const unitErr = stockError(prod.unit || "pcs", quantity);
      if (unitErr) { await undo(); return res.status(400).json({ success: false, message: `${prod.itemName}: ${unitErr}` }); }

      if (direction === "to_branch") {
        const from = await Product.findOneAndUpdate({ _id: prod._id, stock: { $gte: quantity } }, { $inc: { stock: -quantity } });
        if (!from) { await undo(); return res.status(400).json({ success: false, message: `Not enough central stock for ${prod.itemName}` }); }
        try {
          await BranchStock.findOneAndUpdate({ product: prod._id, branch: branchId }, { $inc: { stock: quantity } }, { upsert: true, setDefaultsOnInsert: true });
        } catch (e) {
          await Product.updateOne({ _id: prod._id }, { $inc: { stock: quantity } });
          throw e;
        }
      } else {
        const from = await BranchStock.findOneAndUpdate({ product: prod._id, branch: branchId, stock: { $gte: quantity } }, { $inc: { stock: -quantity } });
        if (!from) { await undo(); return res.status(400).json({ success: false, message: `${branch.name} doesn't have enough ${prod.itemName}` }); }
        await Product.updateOne({ _id: prod._id }, { $inc: { stock: quantity } });
      }
      applied.push({ productId: prod._id, quantity });
    }

    return res.status(200).json({ success: true, message: `${applied.length} product${applied.length === 1 ? "" : "s"} transferred`, count: applied.length });
  } catch (error) {
    await undo();
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

product.delete("/delete/:sku", verifyToken, authorizeRoles("admin"),async (req, res) => {
  try {
    const sku = req.params.sku.trim().toUpperCase();

    const deleted = await Product.findOneAndDelete({ sku });

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: "Product not found"
      });
    }
    removeImages(deleted.images);
    await BranchStock.deleteMany({ product: deleted._id });

    return res.status(200).json({
      success: true,
      message: "Product deleted"
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Internal Server Error"
    });
  }
});
product.put(
  "/update/:sku",
  verifyToken,
  authorizeRoles("admin"),
  handleUpload,
  async (req, res) => {
    try {
      const sku = req.params.sku.trim().toUpperCase();
      const { error, value } = updateProductSchema.validate(req.body, {
        abortEarly: false,
        stripUnknown: true,   // silently drop any extra keys (e.g. sku echoed back)
      });

      if (error) {
        removeUploaded(req.files);
        return res.status(400).json({
          success: false,
          message: error.details.map((err) => err.message),
        });
      }

      const productDoc = await Product.findOne({ sku });

      if (!productDoc) {
        removeUploaded(req.files);
        return res.status(404).json({
          success: false,
          message: "Product not found",
        });
      }

      // Build the $set payload from validated fields
      const setPayload = { ...value };

      const unitStockError = stockError(value.unit ?? productDoc.unit ?? "pcs", value.stock ?? productDoc.stock);
      if (unitStockError) {
        removeUploaded(req.files);
        return res.status(400).json({ success: false, message: [unitStockError] });
      }

      if (req.files && req.files.length > 0) {
        // Delete old images from disk before replacing
        removeImages(productDoc.images);
        setPayload.images = req.files.map(
          (file) => `/uploads/products/${file.filename}`
        );
      }

      // Use $set so only the supplied fields are updated — prevents
      // overwriting required subdocuments like `products` on a Bill document.
      const updatedProduct = await Product.findOneAndUpdate(
        { sku },
        { $set: setPayload },
        { new: true, runValidators: true }
      );

      return res.status(200).json({
        success: true,
        data: updatedProduct,
      });
    } catch (error) {
      removeUploaded(req.files);
      return res.status(500).json({
        success: false,
        message: "Internal Server Error",
      });
    }
  }
);

module.exports = product;
