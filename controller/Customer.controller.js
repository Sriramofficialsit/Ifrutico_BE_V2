const customer = require("express").Router();
const mongoose = require("mongoose");

const Customer = require("../models/Customer.model");
const Bill = require("../models/Bill.model");
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");

customer.use(verifyToken, authorizeRoles("admin", "staff"));

// Bills that count towards revenue
const VALID_BILL = { status: { $nin: ["cancelled", "refunded", "failed"] } };

// Staff only ever see figures/invoices from bills they created; admins see everything
const billScope = (req) =>
  req.user.role === "staff" ? { ...VALID_BILL, billedBy: new mongoose.Types.ObjectId(req.user.id) } : VALID_BILL;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isMobile = (m) => /^[0-9]{10}$/.test(m);

// GET /customers/search?q=  — billing autofill (profile fields only, shop-wide so repeat customers are found by any staff)
customer.get("/search", authorizeRoles("admin"), async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().slice(0, 50);
    if (q.length < 2) return res.json({ success: true, data: [] });

    const rx = escapeRegex(q);
    const filter = /^[0-9]+$/.test(q)
      ? { mobile: { $regex: `^${rx}` } }
      : { name: { $regex: rx, $options: "i" } };

    const data = await Customer.find(filter)
      .select("name mobile email gstNumber")
      .sort({ updatedAt: -1 })
      .limit(8)
      .lean();
    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// GET /customers?page=&limit=&search=  — customers with order count + lifetime revenue
customer.get("/", authorizeRoles("admin"), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 15));
    const search = String(req.query.search || "").trim().slice(0, 50);

    const pipeline = [
      { $match: billScope(req) },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$mobileNumber",
          orders: { $sum: 1 },
          revenue: { $sum: "$totalAmount" },
          lastOrderAt: { $first: "$createdAt" },
          billName: { $first: "$customerName" },
          billEmail: { $first: "$customerEmail" },
          billGst: { $first: "$customerGstNumber" },
        },
      },
      { $lookup: { from: "customers", localField: "_id", foreignField: "mobile", as: "profile" } },
      {
        $project: {
          _id: 0,
          mobile: "$_id",
          orders: 1,
          revenue: 1,
          lastOrderAt: 1,
          name: { $ifNull: [{ $arrayElemAt: ["$profile.name", 0] }, "$billName"] },
          email: { $ifNull: [{ $arrayElemAt: ["$profile.email", 0] }, "$billEmail"] },
          gstNumber: { $ifNull: [{ $arrayElemAt: ["$profile.gstNumber", 0] }, "$billGst"] },
        },
      },
    ];
    if (search) {
      const rx = escapeRegex(search);
      pipeline.push({ $match: { $or: [{ name: { $regex: rx, $options: "i" } }, { mobile: { $regex: rx } }] } });
    }

    const [result] = await Bill.aggregate([
      ...pipeline,
      {
        $facet: {
          data: [{ $sort: { lastOrderAt: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit }],
          meta: [{ $group: { _id: null, total: { $sum: 1 }, revenue: { $sum: "$revenue" }, orders: { $sum: "$orders" } } }],
        },
      },
    ]);

    const meta = result.meta[0] || { total: 0, revenue: 0, orders: 0 };
    return res.json({
      success: true,
      data: result.data,
      summary: { customers: meta.total, orders: meta.orders, revenue: meta.revenue },
      pagination: { total: meta.total, page, totalPages: Math.max(1, Math.ceil(meta.total / limit)) },
    });
  } catch (error) {
    console.error("Customer list error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// GET /customers/:mobile — profile, totals and every invoice
customer.get("/:mobile", authorizeRoles("admin"), async (req, res) => {
  try {
    const { mobile } = req.params;
    if (!isMobile(mobile)) return res.status(400).json({ success: false, message: "Invalid mobile number" });

    const scope = { ...billScope(req), mobileNumber: mobile };
    const [profile, invoices, totals] = await Promise.all([
      Customer.findOne({ mobile }).lean(),
      Bill.find(scope)
        .select("invoiceNumber createdAt totalAmount subTotal gstAmount paymentMethod status products customerGstNumber customerEmail customerName")
        .sort({ createdAt: -1 })
        .limit(200)
        .lean(),
      Bill.aggregate([
        { $match: scope },
        { $group: { _id: null, orders: { $sum: 1 }, revenue: { $sum: "$totalAmount" }, first: { $min: "$createdAt" }, last: { $max: "$createdAt" } } },
      ]),
    ]);

    if (!profile && invoices.length === 0) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }

    const t = totals[0] || { orders: 0, revenue: 0 };
    return res.json({
      success: true,
      data: {
        customer: profile || { mobile, name: invoices[0]?.customerName, email: invoices[0]?.customerEmail, gstNumber: invoices[0]?.customerGstNumber },
        stats: {
          orders: t.orders,
          revenue: t.revenue,
          averageOrder: t.orders ? Number((t.revenue / t.orders).toFixed(2)) : 0,
          firstOrderAt: t.first || null,
          lastOrderAt: t.last || null,
        },
        invoices,
      },
    });
  } catch (error) {
    console.error("Customer detail error:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

module.exports = customer;
