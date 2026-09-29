const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");

// Unauthenticated form endpoints (leads, feedback) are spam magnets — cap per-IP submissions
const publicSubmitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many submissions, please try again later." },
});

// Rejects malformed :id params up front (otherwise Mongoose throws a CastError -> 500)
const validateObjectId = (req, res, next) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid ID format" });
  }
  next();
};

module.exports = { publicSubmitLimiter, validateObjectId };
