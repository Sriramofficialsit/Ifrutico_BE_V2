const express = require("express");
const router = express.Router();
const Joi = require("joi");
const DealershipLead = require("../models/DealershipLead.model");
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const { publicSubmitLimiter, validateObjectId } = require("../middleware/publicSubmit.middleware");

const dealershipSchema = Joi.object({
  name: Joi.string().trim().max(100).required(),
  location: Joi.string().trim().max(200).required(),
  email: Joi.string().email().max(150).required(),
  contact: Joi.string().trim().max(20).required(),
});

const statusSchema = Joi.object({
  status: Joi.string().valid("Pending", "Contacted", "Approved", "Rejected").required(),
});

// POST /api/dealership-leads — public submission
router.post("/", publicSubmitLimiter, async (req, res) => {
  try {
    const { error, value } = dealershipSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }
    const lead = new DealershipLead(value);
    await lead.save();
    return res.status(201).json({ success: true, message: "Enquiry sent successfully! Our team will contact you soon." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// GET /api/dealership-leads — admin only
router.get("/", verifyToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const leads = await DealershipLead.find().sort({ createdAt: -1 }).limit(1000).lean();
    return res.json({ success: true, data: leads });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

// PATCH /api/dealership-leads/:id — admin only
router.patch("/:id", verifyToken, authorizeRoles("admin"), validateObjectId, async (req, res) => {
  try {
    const { error, value } = statusSchema.validate(req.body);
    if (error) return res.status(400).json({ success: false, message: error.details[0].message });
    await DealershipLead.findByIdAndUpdate(req.params.id, { status: value.status });
    return res.json({ success: true, message: "Status updated." });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

// DELETE /api/dealership-leads/:id — admin only
router.delete("/:id", verifyToken, authorizeRoles("admin"), validateObjectId, async (req, res) => {
  try {
    await DealershipLead.findByIdAndDelete(req.params.id);
    return res.json({ success: true, message: "Deleted." });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

module.exports = router;
