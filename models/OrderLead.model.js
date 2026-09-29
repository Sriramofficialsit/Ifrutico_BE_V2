const mongoose = require("mongoose");

const orderLeadSchema = new mongoose.Schema({
  productName: {
    type: String,
    required: true,
    trim: true,
  },
  mobile: {
    type: String,
    required: true,
    match: [/^[0-9]{10}$/, "Please provide a valid 10-digit mobile number"],
    trim: true,
  },
  message: {
    type: String,
    trim: true,
  },
  status: {
    type: String,
    enum: ["pending", "contacted", "completed"],
    default: "pending",
  },
}, { timestamps: true });

module.exports = mongoose.model("OrderLead", orderLeadSchema);
