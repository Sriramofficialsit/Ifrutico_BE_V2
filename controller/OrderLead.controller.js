const express = require("express");
const router = express.Router();
const Joi = require("joi");
const OrderLead = require("../models/OrderLead.model");
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const { publicSubmitLimiter, validateObjectId } = require("../middleware/publicSubmit.middleware");

const orderLeadSchema = Joi.object({
  productName: Joi.string().trim().max(150).required(),
  mobile: Joi.string().pattern(/^[0-9]{10}$/).required().messages({
    "string.pattern.base": "Please provide a valid 10-digit mobile number",
  }),
  message: Joi.string().trim().max(500).allow(""),
});

const statusSchema = Joi.object({
  status: Joi.string().valid("pending", "contacted", "completed").required(),
});

// POST /api/order-leads — public enquiry
router.post("/", publicSubmitLimiter, async (req, res) => {
  try {
    const { error, value } = orderLeadSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }
    const lead = new OrderLead(value);
    await lead.save();
    return res.status(201).json({ success: true, message: "Enquiry sent successfully! We will contact you soon." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// GET /api/order-leads — admin only
router.get("/", verifyToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const leads = await OrderLead.find().sort({ createdAt: -1 }).limit(1000).lean();
    return res.json({ success: true, data: leads });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

// PATCH /api/order-leads/:id — admin only (update status)
router.patch("/:id", verifyToken, authorizeRoles("admin"), validateObjectId, async (req, res) => {
  try {
    const { error, value } = statusSchema.validate(req.body);
    if (error) return res.status(400).json({ success: false, message: error.details[0].message });
    await OrderLead.findByIdAndUpdate(req.params.id, { status: value.status });
    return res.json({ success: true, message: "Lead updated." });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

// DELETE /api/order-leads/:id — admin only
router.delete("/:id", verifyToken, authorizeRoles("admin"), validateObjectId, async (req, res) => {
  try {
    await OrderLead.findByIdAndDelete(req.params.id);
    return res.json({ success: true, message: "Lead deleted." });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

module.exports = router;
