const router = require("express").Router();
const Joi = require("joi");
const Settings = require("../models/settings.model");
const { seal } = require("../utils/secretBox");
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");


const validateSettings = (data) => {
  const schema = Joi.object({
    shopName: Joi.string().trim().max(150).required(),
    phoneNumber: Joi.string().pattern(/^[0-9]{10}$/).required(),
    address: Joi.string().trim().max(300).required(),
    gstNumber: Joi.string().pattern(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[A-Z0-9]{1}Z[0-9A-Z]{1}$/).allow("", null),
    openingHours: Joi.string().trim().max(100).allow(""),
    whatsappNumber: Joi.string().pattern(/^[0-9]{10}$/).allow("", null),
    whatsappApiKey: Joi.string().max(200).allow("", null),
    logoUrl: Joi.string().uri({ scheme: ["http", "https"] }).max(500).allow("", null),
    currency: Joi.string().max(10).default("INR"),
  });
  return schema.validate(data);
};


router.get("/", verifyToken, async (req, res) => {
  try {
    const settings = await Settings.findOne({ userId: req.user.id })
      .select("-whatsappApiKey")
      .lean();

    if (!settings) {
      return res.status(404).json({
        success: false,
        message: "Configuration not found. Please initialize settings.",
      });
    }

    return res.status(200).json({ success: true, data: settings });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/save", verifyToken, async (req, res) => {
  try {
    const { error, value } = validateSettings(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }
    if (value.whatsappApiKey) value.whatsappApiKey = seal(value.whatsappApiKey); // never stored in plaintext
    const updatedSettings = await Settings.findOneAndUpdate(
      { userId: req.user.id },
      { $set: value },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      }
    ).select("-whatsappApiKey");

    return res.status(200).json({
      success: true,
      message: "Settings saved successfully",
      data: updatedSettings,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "An error occurred while saving settings",
    });
  }
});

module.exports = router;