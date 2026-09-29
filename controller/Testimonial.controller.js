const express = require("express");
const router = express.Router();
const Joi = require("joi");
const Testimonial = require("../models/Testimonial.model");
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");
const { publicSubmitLimiter, validateObjectId } = require("../middleware/publicSubmit.middleware");

const approveSchema = Joi.object({ isApproved: Joi.boolean().required() });

const testimonialSchema = Joi.object({
  name: Joi.string().trim().max(80).required(),
  content: Joi.string().trim().required().max(500),
  rating: Joi.number().min(1).max(5).required(),
  gender: Joi.string().valid("male", "female").required(),
});

// POST /api/testimonials — Public submission
router.post("/", publicSubmitLimiter, async (req, res) => {
  try {
    const { error, value } = testimonialSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }
    const testimonial = new Testimonial(value);
    await testimonial.save();
    return res.status(201).json({ success: true, message: "Thank you! Your feedback will be visible after review." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

// GET /api/testimonials/approved — Public list
router.get("/approved", async (req, res) => {
  try {
    const testimonials = await Testimonial.find({ isApproved: true })
      .select("name content rating gender createdAt")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.set("Cache-Control", "public, max-age=300");
    return res.json({ success: true, data: testimonials });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

// GET /api/testimonials — Admin only (all)
router.get("/", verifyToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const testimonials = await Testimonial.find().sort({ createdAt: -1 }).limit(1000).lean();
    return res.json({ success: true, data: testimonials });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

// PATCH /api/testimonials/:id/approve — Admin only
router.patch("/:id/approve", verifyToken, authorizeRoles("admin"), validateObjectId, async (req, res) => {
  try {
    const { error, value } = approveSchema.validate(req.body);
    if (error) return res.status(400).json({ success: false, message: error.details[0].message });
    await Testimonial.findByIdAndUpdate(req.params.id, { isApproved: value.isApproved });
    return res.json({ success: true, message: value.isApproved ? "Approved" : "Unapproved" });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

// DELETE /api/testimonials/:id — Admin only
router.delete("/:id", verifyToken, authorizeRoles("admin"), validateObjectId, async (req, res) => {
  try {
    await Testimonial.findByIdAndDelete(req.params.id);
    return res.json({ success: true, message: "Deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error." });
  }
});

module.exports = router;
