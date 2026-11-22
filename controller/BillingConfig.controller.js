const router = require("express").Router();
const Joi = require("joi");
const BillingConfig = require("../models/BillingConfig.model");
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");

const pick = (c) => ({ scoopGrams: c.scoopGrams, boxSizes: c.boxSizes, gramsPerLitre: c.gramsPerLitre });

// GET /billing-config — every logged-in user (billing screens need it)
router.get("/", verifyToken, async (req, res) => {
  try {
    return res.json({ success: true, data: pick(await BillingConfig.get()) });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

const schema = Joi.object({
  scoopGrams: Joi.number().min(10).max(1000).precision(1).required(),
  boxSizes: Joi.array().items(Joi.number().min(0.1).max(50).precision(2)).min(1).max(12).unique().required(),
  gramsPerLitre: Joi.number().min(100).max(2000).precision(1).required(),
});

// PUT /billing-config — admin only
router.put("/", verifyToken, authorizeRoles("admin"), async (req, res) => {
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });
  try {
    value.boxSizes = [...value.boxSizes].sort((a, b) => a - b);
    const doc = await BillingConfig.findOneAndUpdate({ key: "global" }, { $set: value }, { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }).lean();
    return res.json({ success: true, message: "Billing units saved", data: pick(doc) });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
