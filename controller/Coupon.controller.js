const router = require("express").Router();
const Joi = require("joi");
const mongoose = require("mongoose");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const Coupon = require("../models/Coupon.model");
const Bill = require("../models/Bill.model");
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const { couponDiscount, couponProblem, publicCoupon } = require("../utils/coupon");

const couponSchema = Joi.object({
  code: Joi.string().trim().uppercase().pattern(/^[A-Z0-9_-]+$/).min(3).max(20).required()
    .messages({ "string.pattern.base": "Code can use letters, numbers, - and _ only." }),
  description: Joi.string().trim().max(200).allow(""),
  type: Joi.string().valid("percent", "amount").required(),
  value: Joi.number().min(0.01).precision(2).required()
    .when("type", { is: "percent", then: Joi.number().max(100).messages({ "number.max": "Percent can't be more than 100." }) }),
  maxDiscount: Joi.number().min(0).precision(2).default(0),
  minBill: Joi.number().min(0).precision(2).default(0),
  validFrom: Joi.date().allow(null, ""),
  validTo: Joi.date().allow(null, "").when("validFrom", {
    is: Joi.date().required(),
    then: Joi.date().min(Joi.ref("validFrom")).messages({ "date.min": "End date must be after the start date." }),
  }),
  usageLimit: Joi.number().integer().min(0).max(1000000).default(0),
  perCustomerLimit: Joi.number().integer().min(0).max(1000).default(1),
  billTypes: Joi.array().items(Joi.string().valid("retail", "event", "stall")).unique().default([]),
  active: Joi.boolean().default(true),
});

const clean = (v) => ({ ...v, validFrom: v.validFrom || null, validTo: v.validTo || null });

// GET /coupons — admin list (newest first) with a status the page can badge
router.get("/", verifyToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const now = new Date();
    const coupons = await Coupon.find().sort({ createdAt: -1 }).lean();
    const data = coupons.map((c) => ({
      ...c,
      state: !c.active ? "paused"
        : c.validTo && now > c.validTo ? "expired"
        : c.validFrom && now < c.validFrom ? "scheduled"
        : c.usageLimit > 0 && c.usedCount >= c.usageLimit ? "used_up"
        : "live",
    }));
    return res.json({ success: true, data });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// GET /coupons/active — live coupons for the campaign builder
router.get("/active", verifyToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const now = new Date();
    const list = await Coupon.find({
      active: true,
      $and: [{ $or: [{ validTo: null }, { validTo: { $gte: now } }] }],
    }).sort({ createdAt: -1 }).lean();
    return res.json({ success: true, data: list.filter((c) => !(c.usageLimit > 0 && c.usedCount >= c.usageLimit)) });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/", verifyToken, authorizeRoles("admin"), async (req, res) => {
  const { error, value } = couponSchema.validate(req.body);
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });
  try {
    const coupon = await Coupon.create({ ...clean(value), createdBy: req.user.id });
    return res.status(201).json({ success: true, message: "Coupon created", data: coupon });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ success: false, message: "That code already exists." });
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.put("/:id", verifyToken, authorizeRoles("admin"), async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid coupon ID" });
  const { error, value } = couponSchema.validate(req.body);
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });
  try {
    const coupon = await Coupon.findByIdAndUpdate(req.params.id, { $set: clean(value) }, { new: true, runValidators: true });
    if (!coupon) return res.status(404).json({ success: false, message: "Coupon not found" });
    return res.json({ success: true, message: "Coupon updated", data: coupon });
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ success: false, message: "That code already exists." });
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.patch("/:id/active", verifyToken, authorizeRoles("admin"), async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid coupon ID" });
  try {
    const coupon = await Coupon.findByIdAndUpdate(req.params.id, { $set: { active: !!req.body.active } }, { new: true });
    if (!coupon) return res.status(404).json({ success: false, message: "Coupon not found" });
    return res.json({ success: true, message: coupon.active ? "Coupon resumed" : "Coupon paused", data: coupon });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// Used coupons are kept (bills reference the code); only unused ones can be deleted
router.delete("/:id", verifyToken, authorizeRoles("admin"), async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid coupon ID" });
  try {
    const deleted = await Coupon.findOneAndDelete({ _id: req.params.id, usedCount: 0 });
    if (!deleted) return res.status(400).json({ success: false, message: "This coupon has been used on bills. Pause it instead of deleting." });
    return res.json({ success: true, message: "Coupon deleted" });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// Slow down code guessing from the billing screen
const validateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
  message: { success: false, message: "Too many coupon attempts, wait a minute." },
});

const validateSchema = Joi.object({
  code: Joi.string().trim().uppercase().max(20).required(),
  gross: Joi.number().min(0).required(),
  billType: Joi.string().valid("retail", "event", "stall").default("retail"),
  mobile: Joi.string().pattern(/^[0-9]{10}$/).allow(""),
});

// POST /coupons/validate — billing screen preview. The bill itself re-checks everything.
router.post("/validate", verifyToken, authorizeRoles("admin", "staff"), validateLimiter, async (req, res) => {
  const { error, value } = validateSchema.validate(req.body);
  if (error) return res.status(400).json({ success: false, message: "Enter a coupon code." });
  try {
    const coupon = await Coupon.findOne({ code: value.code }).lean();
    const problem = couponProblem(coupon, { gross: value.gross, billType: value.billType });
    if (problem) return res.status(400).json({ success: false, message: problem });
    if (value.mobile && coupon.perCustomerLimit > 0) {
      const used = await Bill.countDocuments({ couponCode: coupon.code, mobileNumber: value.mobile });
      if (used >= coupon.perCustomerLimit) return res.status(400).json({ success: false, message: "This customer has already used this coupon." });
    }
    return res.json({ success: true, data: { ...publicCoupon(coupon), discount: couponDiscount(coupon, value.gross) } });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
