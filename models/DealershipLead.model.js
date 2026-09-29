const mongoose = require("mongoose");

const dealershipLeadSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  location: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    required: true,
    trim: true,
  },
  contact: {
    type: String,
    required: true,
    trim: true,
  },
  status: {
    type: String,
    enum: ["Pending", "Contacted", "Approved", "Rejected"],
    default: "Pending",
  },
}, { timestamps: true });

module.exports = mongoose.model("DealershipLead", dealershipLeadSchema);
