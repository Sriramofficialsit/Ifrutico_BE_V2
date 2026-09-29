const express = require("express");
const router = express.Router();
const Joi = require("joi");
const MenuLead = require("../models/MenuLead.model");
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const { publicSubmitLimiter, validateObjectId } = require("../middleware/publicSubmit.middleware");

const leadSchema = Joi.object({
  mobile: Joi.string().pattern(/^[0-9]{10}$/).required().messages({
    "string.pattern.base": "Please provide a valid 10-digit mobile number",
    "any.required": "Mobile number is required",
  }),
});

// POST /api/menu-leads — public, saves mobile number before menu download
router.post("/", publicSubmitLimiter, async (req, res) => {
  try {
    const { error } = leadSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }
    const { mobile } = req.body; // validated above
    const lead = new MenuLead({ mobile });
    await lead.save();
    return res.status(201).json({ success: true, message: "Thank you! Your menu is downloading." });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error. Please try again." });
  }
});

// GET /api/menu-leads — admin only, list all leads
router.get("/", verifyToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const leads = await MenuLead.find().sort({ createdAt: -1 }).limit(1000).lean();
    return res.json({ success: true, data: leads, total: leads.length });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

// DELETE /api/menu-leads/:id — admin only
router.delete("/:id", verifyToken, authorizeRoles("admin"), validateObjectId, async (req, res) => {
  try {
    await MenuLead.findByIdAndDelete(req.params.id);
    return res.json({ success: true, message: "Lead deleted." });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

module.exports = router;
