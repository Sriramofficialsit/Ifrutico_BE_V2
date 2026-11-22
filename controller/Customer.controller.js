const customer = require("express").Router();
const mongoose = require("mongoose");

const Customer = require("../models/Customer.model");
const Bill = require("../models/Bill.model");
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const Settings = require("../models/settings.model");
const { DEFAULT_GSTIN } = require("../utils/shop");
const { buildReportPdf, buildCsv, fmtDay, sendFile, IST } = require("../utils/reportService");

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

// One row per customer (by mobile): orders, lifetime revenue, last order, profile fields
const customerPipeline = (req, search) => {
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
  return pipeline;
};

// GET /customers?page=&limit=&search=  — customers with order count + lifetime revenue
customer.get("/", authorizeRoles("admin"), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 15));
    const search = String(req.query.search || "").trim().slice(0, 50);

    const pipeline = customerPipeline(req, search);

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

// GET /customers/report?format=pdf|csv&search= — the whole customer list as a branded PDF or Excel-ready CSV
const rs = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
customer.get("/report", authorizeRoles("admin"), async (req, res) => {
  try {
    const format = req.query.format === "csv" ? "csv" : "pdf";
    const search = String(req.query.search || "").trim().slice(0, 50);
    const rows = await Bill.aggregate([...customerPipeline(req, search), { $sort: { revenue: -1 } }, { $limit: 20000 }]);
    const settings = await Settings.findOne({ userId: req.user.id }).lean();
    const brand = { name: settings?.shopName || "Ifrutico", address: settings?.address, phone: settings?.phoneNumber, gst: settings?.gstNumber || DEFAULT_GSTIN };

    const revenue = rows.reduce((s, r) => s + (r.revenue || 0), 0);
    const orders = rows.reduce((s, r) => s + (r.orders || 0), 0);
    const repeat = rows.filter((r) => r.orders > 1).length;
    const withEmail = rows.filter((r) => r.email).length;
    const today = new Date().toLocaleDateString("en-CA", { timeZone: IST });
    const fileBase = `Ifrutico_Customers_${today}`;
    const subtitle = `As of ${fmtDay(new Date())}${search ? `  ·  Search: "${search}"` : ""}  ·  ranked by lifetime spend`;

    if (format === "csv") {
      const csv = buildCsv(
        ["Rank", "Name", "Mobile", "Email", "GSTIN", "Orders", "Lifetime spend", "Average order", "Last order", "Customer type"],
        rows.map((r, i) => [
          i + 1, r.name || "", r.mobile, r.email || "", r.gstNumber || "", r.orders,
          Number((r.revenue || 0).toFixed(2)), Number(((r.revenue || 0) / (r.orders || 1)).toFixed(2)),
          r.lastOrderAt ? new Date(r.lastOrderAt).toLocaleDateString("en-CA", { timeZone: IST }) : "",
          r.orders > 1 ? "Repeat" : "One-time",
        ]),
        [`${brand.name} — Customer report`, subtitle.replace(/  ·  /g, " | ")]
      );
      return sendFile(res, Buffer.from(csv, "utf8"), `${fileBase}.csv`, "text/csv; charset=utf-8");
    }

    const pdf = await buildReportPdf({
      title: "Customer Report",
      subtitle,
      brand,
      summary: [
        { label: "Lifetime revenue", value: rs(revenue), note: `${orders.toLocaleString("en-IN")} ${orders === 1 ? "order" : "orders"}` },
        { label: "Customers", value: rows.length.toLocaleString("en-IN") },
        { label: "Repeat customers", value: `${rows.length ? Math.round((repeat / rows.length) * 100) : 0}%`, note: `${repeat} ordered more than once` },
        { label: "Avg per customer", value: rs(rows.length ? revenue / rows.length : 0) },
        { label: "Avg order value", value: rs(orders ? revenue / orders : 0) },
        { label: "Reachable by email", value: withEmail.toLocaleString("en-IN"), note: `${rows.length ? Math.round((withEmail / rows.length) * 100) : 0}% of customers` },
      ],
      columns: [
        { key: "n", label: "#", width: 3, align: "right", muted: true },
        { key: "name", label: "Customer", width: 15, bold: true },
        { key: "mobile", label: "Mobile", width: 9 },
        { key: "email", label: "Email", width: 16, muted: true },
        { key: "gst", label: "GSTIN", width: 10, muted: true },
        { key: "orders", label: "Orders", width: 6, align: "center" },
        { key: "revenue", label: "Lifetime spend", width: 10, align: "right", bold: true },
        { key: "avg", label: "Avg order", width: 8.5, align: "right" },
        { key: "last", label: "Last order", width: 9 },
        { key: "kind", label: "Type", width: 6.5 },
      ],
      rows: rows.map((r, i) => ({
        n: i + 1, name: r.name || "—", mobile: r.mobile, email: r.email || "—", gst: r.gstNumber || "—",
        orders: r.orders, revenue: rs(r.revenue), avg: rs((r.revenue || 0) / (r.orders || 1)),
        last: r.lastOrderAt ? fmtDay(r.lastOrderAt) : "—", kind: r.orders > 1 ? "Repeat" : "One-time",
      })),
      totals: { name: `${rows.length} ${rows.length === 1 ? "customer" : "customers"}`, orders: orders.toLocaleString("en-IN"), revenue: rs(revenue) },
      emptyText: "No customers yet.",
    });
    return sendFile(res, pdf, `${fileBase}.pdf`, "application/pdf");
  } catch (error) {
    console.error("Customer report error:", error);
    return res.status(500).json({ success: false, message: "Could not build the report" });
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
