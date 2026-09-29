const mongoose = require("mongoose");

const menuLeadSchema = new mongoose.Schema({
  mobile: {
    type: String,
    required: true,
    match: [/^[0-9]{10}$/, "Please provide a valid 10-digit mobile number"],
    trim: true,
  },
  downloadedAt: {
    type: Date,
    default: Date.now,
  },
}, { timestamps: true });

module.exports = mongoose.model("MenuLead", menuLeadSchema);
