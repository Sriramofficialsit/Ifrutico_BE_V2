const bill = require("express").Router();
const { sendInvoiceEmail, buildInvoicePdf } = require("../utils/invoiceService");
const mongoose = require("mongoose");
const Joi = require("joi");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

const Bill = require("../models/Bill.model");
const Product = require("../models/Products.model");
const BranchStock = require("../models/BranchStock.model");
const Settings = require("../models/settings.model");
const { DEFAULT_GSTIN } = require("../utils/shop");
const Customer = require("../models/Customer.model");
const Salesperson = require("../models/Salesperson.model");
const BillingConfig = require("../models/BillingConfig.model");
const { MEASURABLE, litresToUnits, gramsToUnits } = require("../utils/billUnits");
const Coupon = require("../models/Coupon.model");
const { couponDiscount, couponProblem } = require("../utils/coupon");
const { buildReportPdf, buildCsv, istDayStart, istDayEnd, fmtDay, fmtDateTime, sendFile, IST } = require("../utils/reportService");

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
    billType: Joi.string().valid("retail", "event", "stall").default("retail"),  // keep before products: their rules read it
    products: Joi.array()
      .items(
        Joi.object({
          productId: Joi.string()
            .hex()
            .length(24)
            .required()
            .messages({ "string.length": "Invalid Product ID format" }),
          // Retail: quantity in the product's unit. Decimals allowed for weight/volume units (e.g. 0.5 kg); whole-number rule for "pcs" is enforced per product below
          quantity: Joi.number().min(0.001).max(100000).precision(3)
            .when("/billType", { is: "retail", then: Joi.required(), otherwise: Joi.forbidden() }),
          // Events & Functions: N boxes of a configured litre size
          boxSize: Joi.number().min(0.1).max(50).precision(2)
            .when("/billType", { is: "event", then: Joi.required(), otherwise: Joi.forbidden() }),
          boxes: Joi.number().integer().min(1).max(10000)
            .when("/billType", { is: "event", then: Joi.required(), otherwise: Joi.forbidden() }),
          // Stalls: number of scoops (scoop size is bill-level `scoopGrams`)
          scoops: Joi.number().integer().min(1).max(100000)
            .when("/billType", { is: "stall", then: Joi.required(), otherwise: Joi.forbidden() }),
          // Optional per-line discount: flat ₹ off this line or % of this line's value
          discountType: Joi.string().valid("amount", "percent").optional(),
          discountValue: Joi.number().min(0).precision(2).default(0)
            .when("discountType", { is: "percent", then: Joi.number().max(100).messages({ "number.max": "Item discount can't be more than 100%." }) }),
        })
      )
      .min(1)
      .required(),
    // Stalls only: grams per scoop for this bill (defaults to the central billing config)
    scoopGrams: Joi.number().min(10).max(1000).precision(1)
      .when("billType", { is: "stall", then: Joi.optional(), otherwise: Joi.forbidden() }),
    // Optional bill discount: a flat ₹ amount or a percentage of the items' value (applied before GST)
    discountType: Joi.string().valid("amount", "percent").optional(),
    // Coupon code (replaces the manual discount; the two can't be combined)
    couponCode: Joi.string().trim().uppercase().max(20).allow("").optional(),
    discountValue: Joi.number().min(0).precision(2).default(0)
      .when("discountType", { is: "percent", then: Joi.number().max(100).messages({ "number.max": "Discount can't be more than 100%." }) }),
  });
  return schema.validate(data);
};

// Staff bill from their own branch stock; admin bills from central stock.
// Puts stock back for items already decremented when a later step of bill creation fails.
// Line as priced, minus its own discount — same rounding as Bill.model
const lineNet = (p) => {
  const total = Number(((p.price / (p.priceQty || 1)) * p.quantity).toFixed(2));
  const v = Number(p.discountValue) || 0;
  const off = !(v > 0) ? 0 : p.discountType === "percent" ? Number(((total * Math.min(v, 100)) / 100).toFixed(2)) : p.discountType === "amount" ? Math.min(v, total) : 0;
  return Number((total - off).toFixed(2));
};
// Value the bill discount / coupon applies to: all lines after their own discounts
const netGross = (lines) => Number(lines.reduce((s, p) => s + lineNet(p), 0).toFixed(2));

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
    const { customerName, mobileNumber, customerEmail, customerGstNumber, paymentMethod, products, billType } = value;
    let { discountType, discountValue } = value;
    const couponCode = value.couponCode || "";
    if (couponCode && discountValue > 0) {
      return res.status(400).json({ success: false, message: "Use either a coupon or a manual discount, not both." });
    }
    const billProducts = [];
    const decremented = [];
    const branchId = req.user.role === "staff" ? req.user.id : null;

    // Events (litre boxes) and Stalls (scoops) are converted to the product's own stock unit here,
    // so all three bill types draw from the same inventory. Units are read before any stock is touched.
    let scoopGrams;
    const unitById = new Map();
    if (billType !== "retail") {
      const config = await BillingConfig.get();
      scoopGrams = billType === "stall" ? (value.scoopGrams || config.scoopGrams) : undefined;
      const found = await Product.find({ _id: { $in: products.map((p) => p.productId) } }).select("unit itemName").lean();
      found.forEach((p) => unitById.set(String(p._id), p));
      for (const item of products) {
        const p = unitById.get(item.productId);
        if (!p) return res.status(400).json({ success: false, message: `Product ${item.productId} not found` });
        if (!MEASURABLE.includes(p.unit)) {
          return res.status(400).json({ success: false, message: `${p.itemName} is sold in pcs and can't be billed by ${billType === "event" ? "litre box" : "scoop"}.` });
        }
        if (billType === "event") {
          if (!config.boxSizes.some((b) => Math.abs(b - item.boxSize) < 1e-9)) {
            return res.status(400).json({ success: false, message: `${item.boxSize} L is not one of the configured box sizes.` });
          }
          item.quantity = litresToUnits(item.boxSize * item.boxes, p.unit, config.gramsPerLitre);
        } else {
          item.quantity = gramsToUnits(scoopGrams * item.scoops, p.unit, config.gramsPerLitre);
        }
        if (!(item.quantity > 0)) {
          return res.status(400).json({ success: false, message: `Quantity for ${p.itemName} is too small.` });
        }
      }
    }

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
      if (billType !== "retail" && unitById.get(item.productId)?.unit !== unit) {
        await restoreStock(decremented, branchId).catch((e) => console.error("Stock rollback failed:", e));
        return res.status(409).json({ success: false, message: `${dbProduct.itemName} was just changed. Please try again.` });
      }
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
        ...(billType === "event" ? { boxSize: item.boxSize, boxes: item.boxes } : {}),
        ...(billType === "stall" ? { scoops: item.scoops, scoopGrams } : {}),
        ...(item.discountValue > 0 && item.discountType ? { discountType: item.discountType, discountValue: item.discountValue } : {}),
      });
      // A flat line discount larger than the line is a typo, not a free item
      if (item.discountType === "amount" && item.discountValue > 0) {
        const line = billProducts[billProducts.length - 1];
        const lineTotal = Number(((line.price / (line.priceQty || 1)) * line.quantity).toFixed(2));
        if (item.discountValue > lineTotal) {
          await restoreStock(decremented, branchId).catch((e) => console.error("Stock rollback failed:", e));
          return res.status(400).json({ success: false, message: `Discount on ${dbProduct.itemName} can't be more than its value (₹${lineTotal.toFixed(2)}).` });
        }
      }
    }

    // Coupon: re-check every rule here (the billing screen's preview is not trusted), then claim one use atomically
    let claimedCoupon = null;
    if (couponCode) {
      const gross = netGross(billProducts);
      const coupon = await Coupon.findOne({ code: couponCode }).lean();
      let problem = couponProblem(coupon, { gross, billType });
      if (!problem && coupon.perCustomerLimit > 0) {
        const used = await Bill.countDocuments({ couponCode: coupon.code, mobileNumber });
        if (used >= coupon.perCustomerLimit) problem = "This customer has already used this coupon.";
      }
      if (!problem) {
        claimedCoupon = await Coupon.findOneAndUpdate(
          { _id: coupon._id, active: true, ...(coupon.usageLimit > 0 ? { usedCount: { $lt: coupon.usageLimit } } : {}) },
          { $inc: { usedCount: 1 } }
        );
        if (!claimedCoupon) problem = "This coupon has just been fully used.";
      }
      if (problem) {
        await restoreStock(decremented, branchId).catch((e) => console.error("Stock rollback failed:", e));
        return res.status(400).json({ success: false, message: problem });
      }
      discountType = "amount";
      discountValue = couponDiscount(coupon, gross);
    }
    const releaseCoupon = () =>
      claimedCoupon ? Coupon.updateOne({ _id: claimedCoupon._id, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } }) : Promise.resolve();

    // A flat discount larger than the bill is a typo, not a free bill: reject it instead of silently capping
    if (discountType === "amount" && discountValue > 0) {
      // Same rounding as Bill.model (each line to paise after its own discount, then summed)
      const gross = netGross(billProducts);
      if (discountValue > gross) {
        await restoreStock(decremented, branchId).catch((e) => console.error("Stock rollback failed:", e));
        await releaseCoupon().catch(() => {});
        return res.status(400).json({ success: false, message: `Discount can't be more than the bill value (₹${gross.toFixed(2)}).` });
      }
    }

    let newBill;
    try {
      newBill = await Bill.create({
        customerName: customerName.trim(),
        mobileNumber: mobileNumber,
        billedBy: req.user.id,
        billType,
        paymentMethod: paymentMethod || "cash",
        products: billProducts,
        customerEmail: customerEmail ? customerEmail.toLowerCase() : null,
        customerGstNumber: customerGstNumber || undefined,
        discountType: discountValue > 0 ? discountType : undefined,
        discountValue: discountType ? discountValue : 0,
        couponCode: claimedCoupon ? couponCode : undefined,
      });
    } catch (createErr) {
      await restoreStock(decremented, branchId).catch((e) => console.error("Stock rollback failed:", e));
      await releaseCoupon().catch((e) => console.error("Coupon release failed:", e));
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
    if (req.query.type === "retail") filter.billType = { $in: ["retail", null] }; // bills made before bill types existed are retail
    else if (["event", "stall"].includes(req.query.type)) filter.billType = req.query.type;
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
// ---------- Analytics (dashboard) ----------
// GET /bill/analytics?days=7|30|90 — staff see only their own bills, admins see everything.
// All day / hour / weekday buckets are in India time.
const VALID_BILL = { status: { $nin: ["cancelled", "refunded", "failed"] } };
bill.get("/analytics", verifyToken, authorizeRoles("admin", "staff"), async (req, res) => {
  try {
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const scope = req.user.role === "staff" ? { billedBy: new mongoose.Types.ObjectId(req.user.id) } : {};
    // Period = the last `days` whole days in IST, including today; previous period = the same length just before it
    const todayIst = new Date().toLocaleDateString("en-CA", { timeZone: IST });
    const end = istDayEnd(todayIst);
    const start = new Date(istDayStart(todayIst).getTime() - (days - 1) * 86400000);
    const prevStart = new Date(start.getTime() - days * 86400000);
    const inPeriod = { ...scope, ...VALID_BILL, createdAt: { $gte: start, $lte: end } };
    const tz = IST;

    const totalsOf = (match) => Bill.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          revenue: { $sum: "$totalAmount" },
          bills: { $sum: 1 },
          gst: { $sum: "$gstAmount" },
          discounts: { $sum: { $add: [{ $ifNull: ["$discountAmount", 0] }, { $ifNull: ["$itemDiscountAmount", 0] }] } },
          customers: { $addToSet: "$mobileNumber" },
        },
      },
      { $project: { _id: 0, revenue: 1, bills: 1, gst: 1, discounts: 1, customers: { $size: "$customers" } } },
    ]);

    const [cur, prev, daily, hourly, weekday, payments, types, products, firstSeen] = await Promise.all([
      totalsOf(inPeriod),
      totalsOf({ ...scope, ...VALID_BILL, createdAt: { $gte: prevStart, $lt: start } }),
      Bill.aggregate([
        { $match: inPeriod },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: tz } }, revenue: { $sum: "$totalAmount" }, bills: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      Bill.aggregate([
        { $match: inPeriod },
        { $group: { _id: { $hour: { date: "$createdAt", timezone: tz } }, revenue: { $sum: "$totalAmount" }, bills: { $sum: 1 } } },
      ]),
      Bill.aggregate([
        { $match: inPeriod },
        { $group: { _id: { $dayOfWeek: { date: "$createdAt", timezone: tz } }, revenue: { $sum: "$totalAmount" }, bills: { $sum: 1 } } },
      ]),
      Bill.aggregate([
        { $match: inPeriod },
        { $group: { _id: { $ifNull: ["$paymentMethod", "cash"] }, revenue: { $sum: "$totalAmount" }, bills: { $sum: 1 } } },
      ]),
      Bill.aggregate([
        { $match: inPeriod },
        { $group: { _id: { $ifNull: ["$billType", "retail"] }, revenue: { $sum: "$totalAmount" }, bills: { $sum: 1 } } },
      ]),
      Bill.aggregate([
        { $match: inPeriod },
        { $unwind: "$products" },
        {
          $group: {
            _id: "$products.itemName",
            revenue: { $sum: { $subtract: ["$products.total", { $ifNull: ["$products.discountAmount", 0] }] } },
            qty: { $sum: "$products.quantity" },
            unit: { $first: "$products.unit" },
            bills: { $sum: 1 },
          },
        },
        { $sort: { revenue: -1 } },
        { $limit: 8 },
      ]),
      // New vs returning: customers in this period whose first-ever bill (in scope) falls inside it are "new"
      Bill.aggregate([
        { $match: inPeriod },
        { $group: { _id: "$mobileNumber" } },
        { $lookup: { from: "bills", let: { m: "$_id" }, pipeline: [
          { $match: { $expr: { $eq: ["$mobileNumber", "$$m"] }, ...scope } },
          { $sort: { createdAt: 1 } }, { $limit: 1 }, { $project: { createdAt: 1 } },
        ], as: "first" } },
        { $project: { isNew: { $gte: [{ $arrayElemAt: ["$first.createdAt", 0] }, start] } } },
        { $group: { _id: "$isNew", n: { $sum: 1 } } },
      ]),
    ]);

    const blank = { revenue: 0, bills: 0, gst: 0, discounts: 0, customers: 0 };
    const c = cur[0] || blank;
    const p = prev[0] || blank;
    const avg = (t) => (t.bills ? t.revenue / t.bills : 0);
    const newCustomers = firstSeen.find((f) => f._id === true)?.n || 0;
    const returning = firstSeen.find((f) => f._id === false)?.n || 0;

    return res.json({
      success: true,
      data: {
        days,
        from: start, to: end,
        totals: { ...c, avgBill: avg(c), newCustomers, returningCustomers: returning },
        previous: { ...p, avgBill: avg(p) },
        daily: daily.map((d) => ({ date: d._id, revenue: d.revenue, bills: d.bills })),
        hourly: Array.from({ length: 24 }, (_, h) => {
          const f = hourly.find((x) => x._id === h);
          return { hour: h, revenue: f?.revenue || 0, bills: f?.bills || 0 };
        }),
        // Mon..Sun (Mongo: 1 = Sunday)
        weekday: [2, 3, 4, 5, 6, 7, 1].map((d) => {
          const f = weekday.find((x) => x._id === d);
          return { day: ["", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d], revenue: f?.revenue || 0, bills: f?.bills || 0 };
        }),
        payments: payments.map((x) => ({ method: x._id, revenue: x.revenue, bills: x.bills })),
        billTypes: types.map((x) => ({ type: x._id, revenue: x.revenue, bills: x.bills })),
        topProducts: products.map((x) => ({ name: x._id, revenue: x.revenue, qty: x.qty, unit: x.unit, bills: x.bills })),
      },
    });
  } catch (error) {
    console.error("Analytics error:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ---------- Bill list report ----------
// GET /bill/report?from=YYYY-MM-DD&to=YYYY-MM-DD&format=pdf|csv[&payment&type&search&branch]
// Every bill in the date range (India time), as a branded PDF or an Excel-ready CSV.
const REPORT_MAX_ROWS = 20000;
const PAY_LABEL = { cash: "Cash", upi: "UPI", card: "Card" };
const TYPE_LABEL = { retail: "Retail", event: "Events", stall: "Stall" };
const rs = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num2 = (n) => Number(Number(n || 0).toFixed(2));

bill.get("/report", verifyToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const from = istDayStart(req.query.from);
    const to = istDayEnd(req.query.to);
    if (!from || !to) return res.status(400).json({ success: false, message: "Choose a valid from and to date." });
    if (from > to) return res.status(400).json({ success: false, message: "The from date must be before the to date." });
    const format = req.query.format === "csv" ? "csv" : "pdf";

    const filter = { createdAt: { $gte: from, $lte: to } };
    if (req.query.branch) {
      if (!mongoose.Types.ObjectId.isValid(req.query.branch)) return res.status(400).json({ success: false, message: "Invalid branch ID" });
      filter.billedBy = new mongoose.Types.ObjectId(req.query.branch);
    }
    const search = String(req.query.search || "").trim().slice(0, 60);
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ invoiceNumber: rx }, { customerName: rx }, { mobileNumber: rx }];
    }
    if (["cash", "upi", "card"].includes(req.query.payment)) filter.paymentMethod = req.query.payment;
    if (req.query.type === "retail") filter.billType = { $in: ["retail", null] };
    else if (["event", "stall"].includes(req.query.type)) filter.billType = req.query.type;

    const count = await Bill.countDocuments(filter);
    if (count > REPORT_MAX_ROWS) {
      return res.status(400).json({ success: false, message: `That range has ${count.toLocaleString("en-IN")} bills. Choose a shorter range (max ${REPORT_MAX_ROWS.toLocaleString("en-IN")}).` });
    }
    const bills = await Bill.find(filter).populate("billedBy", "name").sort({ createdAt: 1 }).lean();
    const settings = await Settings.findOne({ userId: req.user.id }).lean();
    const brand = { name: settings?.shopName || "Ifrutico", address: settings?.address, phone: settings?.phoneNumber, gst: settings?.gstNumber || DEFAULT_GSTIN };

    const t = bills.reduce((a, b) => {
      a.revenue += b.totalAmount || 0;
      a.gst += b.gstAmount || 0;
      a.taxable += b.subTotal || 0;
      a.discount += (b.discountAmount || 0) + (b.itemDiscountAmount || 0);
      const pm = b.paymentMethod || "cash";
      a.pay[pm] = (a.pay[pm] || 0) + (b.totalAmount || 0);
      a.customers.add(b.mobileNumber);
      return a;
    }, { revenue: 0, gst: 0, taxable: 0, discount: 0, pay: {}, customers: new Set() });

    const period = from.getTime() === istDayStart(req.query.to).getTime() ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`;
    const fileBase = `Ifrutico_Bills_${req.query.from}_to_${req.query.to}`;
    const filtersNote = [
      req.query.payment && PAY_LABEL[req.query.payment] ? `Payment: ${PAY_LABEL[req.query.payment]}` : "",
      req.query.type && TYPE_LABEL[req.query.type] ? `Type: ${TYPE_LABEL[req.query.type]}` : "",
      search ? `Search: "${search}"` : "",
    ].filter(Boolean).join("  ·  ");

    if (format === "csv") {
      const headers = ["Date", "Time", "Invoice", "Customer", "Mobile", "Email", "Customer GSTIN", "Branch / billed by", "Bill type", "Payment",
        "Items", "Items total", "Item discounts", "Bill discount", "Coupon", "Taxable value", "GST", "Total"];
      const rows = bills.map((b) => {
        const d = new Date(b.createdAt);
        const itemsTotal = (b.products || []).reduce((s, p) => s + (p.total || 0), 0);
        return [
          d.toLocaleDateString("en-CA", { timeZone: IST }),
          d.toLocaleTimeString("en-IN", { timeZone: IST, hour: "2-digit", minute: "2-digit" }),
          b.invoiceNumber, b.customerName, b.mobileNumber, b.customerEmail || "", b.customerGstNumber || "",
          b.billedBy?.name || "", TYPE_LABEL[b.billType || "retail"], PAY_LABEL[b.paymentMethod] || b.paymentMethod,
          (b.products || []).map((p) => `${p.itemName} x ${p.boxes ? `${p.boxes} box (${p.boxSize} L)` : p.scoops ? `${p.scoops} scoops` : `${p.quantity} ${p.unit || "pcs"}`}`).join("; "),
          num2(itemsTotal), num2(b.itemDiscountAmount), num2(b.discountAmount), b.couponCode || "",
          num2(b.subTotal), num2(b.gstAmount), num2(b.totalAmount),
        ];
      });
      rows.push([], ["TOTAL", "", `${bills.length} bills`, "", "", "", "", "", "", "", "", "", "", "", "", num2(t.taxable), num2(t.gst), num2(t.revenue)]);
      const csv = buildCsv(headers, rows, [`${brand.name} — Bill report`, `Period: ${period}`, ...(filtersNote ? [filtersNote] : [])]);
      return sendFile(res, Buffer.from(csv, "utf8"), `${fileBase}.csv`, "text/csv; charset=utf-8");
    }

    const pdf = await buildReportPdf({
      title: "Bill Report",
      subtitle: `${period}${filtersNote ? `  ·  ${filtersNote}` : ""}`,
      brand,
      summary: [
        { label: "Total revenue", value: rs(t.revenue), note: `${bills.length} ${bills.length === 1 ? "bill" : "bills"}` },
        { label: "Bills", value: bills.length.toLocaleString("en-IN"), note: `${t.customers.size} ${t.customers.size === 1 ? "customer" : "customers"}` },
        { label: "Average bill", value: rs(bills.length ? t.revenue / bills.length : 0) },
        { label: "Taxable value", value: rs(t.taxable) },
        { label: "GST collected", value: rs(t.gst), note: "CGST + SGST" },
        { label: "Discounts given", value: rs(t.discount) },
      ],
      breakdownTitle: "Payment methods",
      breakdown: ["cash", "upi", "card"].filter((m) => t.pay[m]).map((m) => ({ label: PAY_LABEL[m], value: rs(t.pay[m]), pct: t.revenue ? (t.pay[m] / t.revenue) * 100 : 0 })),
      columns: [
        { key: "n", label: "#", width: 3, align: "right", muted: true },
        { key: "date", label: "Date & time", width: 13 },
        { key: "invoice", label: "Invoice", width: 11, muted: true },
        { key: "customer", label: "Customer", width: 12, bold: true },
        { key: "mobile", label: "Mobile", width: 8.5 },
        { key: "branch", label: "Billed by", width: 9 },
        { key: "type", label: "Type", width: 5.5 },
        { key: "pay", label: "Pay", width: 4.5 },
        { key: "items", label: "Qty", width: 4.5, align: "center" },
        { key: "disc", label: "Discount", width: 7.5, align: "right" },
        { key: "gst", label: "GST", width: 7, align: "right" },
        { key: "total", label: "Total", width: 8.5, align: "right", bold: true },
      ],
      rows: bills.map((b, i) => ({
        n: i + 1,
        date: fmtDateTime(b.createdAt),
        invoice: b.invoiceNumber,
        customer: b.customerName,
        mobile: b.mobileNumber,
        branch: b.billedBy?.name || "—",
        type: TYPE_LABEL[b.billType || "retail"],
        pay: PAY_LABEL[b.paymentMethod] || b.paymentMethod,
        items: (b.products || []).length,
        disc: (b.discountAmount || 0) + (b.itemDiscountAmount || 0) > 0 ? rs((b.discountAmount || 0) + (b.itemDiscountAmount || 0)) : "—",
        gst: rs(b.gstAmount),
        total: rs(b.totalAmount),
      })),
      totals: { customer: `${bills.length} ${bills.length === 1 ? "bill" : "bills"}`, disc: rs(t.discount), gst: rs(t.gst), total: rs(t.revenue) },
      emptyText: "No bills in this period.",
    });
    return sendFile(res, pdf, `${fileBase}.pdf`, "application/pdf");
  } catch (error) {
    console.error("Bill report error:", error);
    return res.status(500).json({ success: false, message: "Could not build the report" });
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

    // A deleted bill no longer counts as a coupon use
    if (deleted.couponCode) {
      Coupon.updateOne({ code: deleted.couponCode, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } })
        .catch((e) => console.error("Coupon release after bill delete failed:", e));
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