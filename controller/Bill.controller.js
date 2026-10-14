const bill = require("express").Router();
const { sendInvoiceEmail, buildInvoicePdf } = require("../utils/invoiceService");
const mongoose = require("mongoose");
const Joi = require("joi");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

const Bill = require("../models/Bill.model");
const Product = require("../models/Products.model");
const BranchStock = require("../models/BranchStock.model");
const Settings = require("../models/settings.model");
const Customer = require("../models/Customer.model");
const Salesperson = require("../models/Salesperson.model");

const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");


const validateBill = (data) => {
  const schema = Joi.object({
    customerName: Joi.string().trim().min(2).max(50).required(),
    mobileNumber: Joi.string()
      .pattern(/^[0-9]{10}$/)
      .messages({ "string.pattern.base": "Mobile number must be 10 digits." })
      .required(),
    customerEmail: Joi.string().email().allow("").optional(),
    // Free-form on purpose (no GSTIN format check); only length-capped
    customerGstNumber: Joi.string().trim().uppercase().max(30).allow("").optional(),
    paymentMethod: Joi.string()
      .valid("Cash", "UPI", "cash", "upi", "card")
      .default("Cash")
      .optional(),
    products: Joi.array()
      .items(
        Joi.object({
          productId: Joi.string()
            .hex()
            .length(24)
            .required()
            .messages({ "string.length": "Invalid Product ID format" }),
          // Decimals allowed for weight/volume units (e.g. 0.5 kg); whole-number rule for "pcs" is enforced per product below
          quantity: Joi.number().min(0.001).max(100000).precision(3).required(),
        })
      )
      .min(1)
      .required(),
  });
  return schema.validate(data);
};

// Staff bill from their own branch stock; admin bills from central stock.
// Puts stock back for items already decremented when a later step of bill creation fails.
const restoreStock = (items, branchId) =>
  items.length
    ? branchId
      ? BranchStock.bulkWrite(items.map((i) => ({ updateOne: { filter: { product: i.productId, branch: branchId }, update: { $inc: { stock: i.quantity } } } })))
      : Product.bulkWrite(items.map((i) => ({ updateOne: { filter: { _id: i.productId }, update: { $inc: { stock: i.quantity } } } })))
    : Promise.resolve();

const billLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
  message: { success: false, message: "Too many bills created, slow down." },
});

bill.post("/add", verifyToken, authorizeRoles("admin", "staff"), billLimiter, async (req, res) => {

  const { error, value } = validateBill(req.body);
  if (error) {
    return res.status(400).json({ success: false, message: error.details[0].message });
  }

  try {
    const { customerName, mobileNumber, customerEmail, customerGstNumber, paymentMethod, products } = value;
    const billProducts = [];
    const decremented = [];
    const branchId = req.user.role === "staff" ? req.user.id : null;

    // Process products and update stock atomically per document
    for (const item of products) {
      let dbProduct = null;
      if (branchId) {
        const held = await BranchStock.findOneAndUpdate(
          { product: item.productId, branch: branchId, stock: { $gte: item.quantity } }, // only decrement if enough branch stock
          { $inc: { stock: -item.quantity } }
        );
        if (held) dbProduct = await Product.findById(item.productId);
      } else {
        dbProduct = await Product.findOneAndUpdate(
          { _id: item.productId, stock: { $gte: item.quantity } }, // only decrement if enough stock
          { $inc: { stock: -item.quantity } },
          { new: true, runValidators: true }
        );
      }

      if (!dbProduct) {
        await restoreStock(decremented, branchId).catch((e) => console.error("Stock rollback failed:", e));
        return res.status(400).json({
          success: false,
          message: `Product ${item.productId} not found or insufficient stock`,
        });
      }

      decremented.push({ productId: dbProduct._id, quantity: item.quantity });

      const unit = dbProduct.unit || "pcs";
      if (unit === "pcs" && !Number.isInteger(item.quantity)) {
        await restoreStock(decremented, branchId).catch((e) => console.error("Stock rollback failed:", e));
        return res.status(400).json({
          success: false,
          message: `${dbProduct.itemName} is sold in pcs — quantity must be a whole number`,
        });
      }
      billProducts.push({
        productId: dbProduct._id,
        itemName: dbProduct.itemName,
        price: dbProduct.price,
        priceQty: dbProduct.priceQty || 1,
        quantity: item.quantity,
        unit,
        gstIncluded: !!dbProduct.gstIncluded,
      });
    }

    let newBill;
    try {
      newBill = await Bill.create({
        customerName: customerName.trim(),
        mobileNumber: mobileNumber,
        billedBy: req.user.id,
        paymentMethod: paymentMethod || "cash",
        products: billProducts,
        customerEmail: customerEmail ? customerEmail.toLowerCase() : null,
        customerGstNumber: customerGstNumber || undefined,
      });
    } catch (createErr) {
      await restoreStock(decremented, branchId).catch((e) => console.error("Stock rollback failed:", e));
      throw createErr;
    }

    // Remember the customer for autofill / the Customers page. Never blocks or fails the bill.
    // Blank email/GST on a later bill must not wipe what we already know, so only non-empty values are written.
    const profileUpdate = { name: customerName.trim() };
    if (customerEmail) profileUpdate.email = customerEmail.toLowerCase();
    if (customerGstNumber) profileUpdate.gstNumber = customerGstNumber;
    Customer.findOneAndUpdate(
      { mobile: mobileNumber },
      { $set: profileUpdate },
      { upsert: true, runValidators: true, setDefaultsOnInsert: true }
    ).catch((err) => console.error("Customer save failed:", err.message));

    // Trigger Email asynchronously if email is provided — capped so the shop's mailbox can't be used as a spam relay
    const EMAIL_PER_USER_DAILY = 100;
    const EMAIL_PER_RECIPIENT_DAILY = 5;
    let mayEmail = !!(customerEmail && customerEmail.trim() !== "");
    if (mayEmail) {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const [byUser, byRecipient] = await Promise.all([
        Bill.countDocuments({ billedBy: req.user.id, customerEmail: { $ne: null }, createdAt: { $gte: startOfDay } }),
        Bill.countDocuments({ customerEmail: customerEmail.toLowerCase(), createdAt: { $gte: startOfDay } }),
      ]);
      if (byUser > EMAIL_PER_USER_DAILY || byRecipient > EMAIL_PER_RECIPIENT_DAILY) {
        mayEmail = false;
        console.warn(`Invoice email skipped (daily cap) for user ${req.user.id}`);
      }
    }
    if (mayEmail) {
      Settings.findOne({ userId: req.user.id })
        .lean()
        .then(settings => {
          sendInvoiceEmail(newBill, customerEmail, settings).catch(err => console.error("Auto email failed:", err));
        })
        .catch(err => console.error("Failed to fetch settings for email:", err));
    }

    return res.status(201).json({
      success: true,
      message: "Bill generated successfully",
      data: newBill,
    });

  } catch (error) {
    console.error("Bill create error:", error);
    return res.status(400).json({
      success: false,
      message: "An error occurred while creating the bill",
    });
  }
});
// GET /bill/stats — dashboard summary
bill.get("/stats", verifyToken, async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const filter = req.user.role === "staff" ? { billedBy: new mongoose.Types.ObjectId(req.user.id) } : {};

    const [todayData, allTimeData, weeklyData, topProducts] = await Promise.all([
      Bill.aggregate([
        { $match: { ...filter, createdAt: { $gte: today, $lt: tomorrow } } },
        { $group: { _id: null, sales: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
      ]),
      Bill.aggregate([
        { $match: filter },
        { $group: { _id: null, revenue: { $sum: "$totalAmount" }, bills: { $sum: 1 } } },
      ]),
      Bill.aggregate([
        { $match: { ...filter, createdAt: { $gte: sevenDaysAgo } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, total: { $sum: "$totalAmount" } } },
        { $sort: { _id: 1 } },
      ]),
      Bill.aggregate([
        { $match: { ...filter, createdAt: { $gte: sevenDaysAgo } } },
        { $unwind: "$products" },
        { $group: { _id: "$products.itemName", sold: { $sum: "$products.quantity" }, revenue: { $sum: "$products.total" } } },
        { $sort: { sold: -1 } },
        { $limit: 5 },
      ]),
    ]);

    return res.json({
      success: true,
      data: {
        today: { sales: todayData[0]?.sales || 0, bills: todayData[0]?.count || 0 },
        allTime: { revenue: allTimeData[0]?.revenue || 0, bills: allTimeData[0]?.bills || 0 },
        weekly: weeklyData,
        topProducts,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// GET /bill/branch-analytics?days=7|30 — admin: sales grouped by branch (the billing user)
bill.get("/branch-analytics", verifyToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const days = req.query.days === "30" ? 30 : 7;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const since = new Date(startOfToday);
    since.setDate(since.getDate() - (days - 1));

    const [perBranch, daily, payments] = await Promise.all([
      Bill.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: "$billedBy",
            revenue: { $sum: "$totalAmount" },
            bills: { $sum: 1 },
            today: { $sum: { $cond: [{ $gte: ["$createdAt", startOfToday] }, "$totalAmount", 0] } },
          },
        },
        { $lookup: { from: "salespeople", localField: "_id", foreignField: "_id", as: "u" } },
        { $unwind: { path: "$u", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            revenue: 1, bills: 1, today: 1,
            name: { $ifNull: ["$u.name", "Removed branch"] },
            role: { $ifNull: ["$u.role", "staff"] },
          },
        },
        { $sort: { revenue: -1 } },
      ]),
      Bill.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: { date: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, branch: "$billedBy" },
            total: { $sum: "$totalAmount" },
          },
        },
      ]),
      Bill.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: "$paymentMethod", total: { $sum: "$totalAmount" }, bills: { $sum: 1 } } },
      ]),
    ]);

    return res.json({
      success: true,
      data: {
        days,
        branches: perBranch.map((b) => ({
          id: b._id, name: b.name, role: b.role, revenue: b.revenue, bills: b.bills, today: b.today,
          avgBill: b.bills ? Math.round(b.revenue / b.bills) : 0,
        })),
        daily: daily.map((d) => ({ date: d._id.date, branch: d._id.branch, total: d.total })),
        payments,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// GET /bill/monthly — reports analytics
bill.get("/monthly", verifyToken, authorizeRoles("admin", "staff"), async (req, res) => {
  try {
    const requestedYear = parseInt(req.query.year);
    const year = requestedYear >= 2000 && requestedYear <= 2100 ? requestedYear : new Date().getFullYear();
    const startOfYear = new Date(year, 0, 1);
    const endOfYear = new Date(year + 1, 0, 1);

    const filter = req.user.role === "staff" ? { billedBy: new mongoose.Types.ObjectId(req.user.id) } : {};

    const [monthly, topItems, salespersonStats] = await Promise.all([
      Bill.aggregate([
        { $match: { ...filter, createdAt: { $gte: startOfYear, $lt: endOfYear } } },
        { $group: { _id: { $month: "$createdAt" }, revenue: { $sum: "$totalAmount" }, bills: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      Bill.aggregate([
        { $match: { ...filter, createdAt: { $gte: startOfYear, $lt: endOfYear } } },
        { $unwind: "$products" },
        { $group: { _id: "$products.itemName", sold: { $sum: "$products.quantity" }, revenue: { $sum: "$products.total" } } },
        { $sort: { sold: -1 } },
        { $limit: 5 },
      ]),
      Bill.aggregate([
        { $match: { ...filter, createdAt: { $gte: startOfYear, $lt: endOfYear } } },
        { $group: { _id: "$billedBy", sales: { $sum: "$totalAmount" }, bills: { $sum: 1 } } },
        { $lookup: { from: "salespeople", localField: "_id", foreignField: "_id", as: "person" } },
        { $project: { name: { $arrayElemAt: ["$person.name", 0] }, sales: 1, bills: 1 } },
        { $sort: { sales: -1 } },
      ]),
    ]);

    const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const monthlyFilled = monthNames.map((name, i) => {
      const found = monthly.find((m) => m._id === i + 1);
      return { month: name, revenue: found?.revenue || 0, bills: found?.bills || 0 };
    });

    return res.json({ success: true, data: { monthly: monthlyFilled, topItems, salespersonStats } });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

bill.get("/fetch", verifyToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 10); // Cap limit at 100
    const skip = (page - 1) * limit;

    const filter = req.user.role === "staff" ? { billedBy: req.user.id } : {};
    // Admin can drill into one branch's bills
    if (req.user.role === "admin" && req.query.branch) {
      if (!mongoose.Types.ObjectId.isValid(req.query.branch)) {
        return res.status(400).json({ success: false, message: "Invalid branch ID" });
      }
      filter.billedBy = new mongoose.Types.ObjectId(req.query.branch);
    }

    // Optional filters: text search (invoice / customer / mobile), payment method, date range start
    const search = String(req.query.search || "").trim().slice(0, 60);
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ invoiceNumber: rx }, { customerName: rx }, { mobileNumber: rx }];
    }
    if (["cash", "upi", "card"].includes(req.query.payment)) filter.paymentMethod = req.query.payment;
    const from = new Date(req.query.from);
    if (req.query.from && !isNaN(from)) filter.createdAt = { $gte: from };

    const [bills, total] = await Promise.all([
      Bill.find(filter)
        .populate("billedBy", "name email role")
        .populate("products.productId", "itemName price")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(), 
      Bill.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalRecords: total,
        pageSize: bills.length,
      },
      data: bills,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error while fetching bills",
    });
  }
});
// GET /bill/:id/pdf — the exact same invoice PDF that is attached to the customer email
bill.get("/:id/pdf", verifyToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid bill ID format" });
    }

    const filter = req.user.role === "staff" ? { _id: id, billedBy: req.user.id } : { _id: id };
    const singleBill = await Bill.findOne(filter).lean();
    if (!singleBill) {
      return res.status(404).json({ success: false, message: "Bill not found" });
    }

    // Same shop details the email uses: those of the user who created the bill
    const settings = await Settings.findOne({ userId: singleBill.billedBy }).lean();
    const pdf = await buildInvoicePdf(singleBill, settings);

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="Invoice_${singleBill.invoiceNumber}.pdf"`,
      "Content-Length": pdf.length,
      "Cache-Control": "private, no-store",
    });
    return res.send(pdf);
  } catch (error) {
    console.error("Invoice PDF error:", error);
    return res.status(500).json({ success: false, message: "Could not generate invoice PDF" });
  }
});

bill.get("/:id", verifyToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid bill ID format" });
    }

    const filter = req.user.role === "staff" ? { _id: id, billedBy: req.user.id } : { _id: id };

    const singleBill = await Bill.findOne(filter)
      .populate("billedBy", "name email role")
      .populate("products.productId", "itemName price")
      .lean();

    if (!singleBill) {
      return res.status(404).json({ success: false, message: "Bill not found" });
    }

    return res.status(200).json({ success: true, data: singleBill });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// Admin: delete a bill. Unless ?restock=false, the sold quantities go back where they came from:
// the billing branch's stock for staff bills, central stock for admin bills (or if that branch no longer exists).
bill.delete("/:id", verifyToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid bill ID format" });
    }
    const restock = req.query.restock !== "false";

    // Deleting first is the atomic claim: a double click can't restock twice
    const deleted = await Bill.findOneAndDelete({ _id: id }).lean();
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Bill not found" });
    }

    if (restock) {
      const qtyByProduct = new Map();
      for (const p of deleted.products || []) {
        if (!p.productId) continue;
        const key = String(p.productId);
        qtyByProduct.set(key, (qtyByProduct.get(key) || 0) + p.quantity);
      }
      // Skip products deleted since the sale, so no orphan branch stock is created
      const existing = new Set((await Product.find({ _id: { $in: [...qtyByProduct.keys()] } }).distinct("_id")).map(String));
      const items = [...qtyByProduct].filter(([pid]) => existing.has(pid)).map(([productId, quantity]) => ({ productId, quantity }));

      const biller = await Salesperson.findById(deleted.billedBy).select("role").lean();
      const branchId = biller?.role === "staff" ? biller._id : null;
      try {
        if (branchId) {
          await BranchStock.bulkWrite(items.map((i) => ({
            updateOne: { filter: { product: i.productId, branch: branchId }, update: { $inc: { stock: i.quantity } }, upsert: true },
          })));
        } else if (items.length) {
          await restoreStock(items, null);
        }
      } catch (e) {
        console.error("Restock after bill delete failed:", e);
        return res.status(200).json({ success: true, message: "Bill deleted, but stock could not be restored. Adjust it on the Stock page." });
      }
    }

    return res.status(200).json({ success: true, message: restock ? "Bill deleted and stock restored" : "Bill deleted" });
  } catch (error) {
    console.error("Delete bill error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = bill;