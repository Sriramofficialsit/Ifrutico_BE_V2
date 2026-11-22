const mongoose = require("mongoose");

const settingsSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Salesperson",
      required: true,
      unique: true
    },

    shopName: {
      type: String,
      required: [true, "Shop name is required"],
      trim: true,
      maxlength: 150,
    },

    phoneNumber: {
      type: String,
      required: [true, "Phone number is required"],
      match: [/^[0-9]{10}$/, "Please provide a valid 10-digit phone number"],
    },

    address: {
      type: String,
      required: [true, "Address is required"],
      trim: true,
      maxlength: 300,
    },

    gstNumber: {
      type: String,
      trim: true,
      uppercase: true, // Auto-convert to uppercase
      match: [
        /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[A-Z0-9]{1}Z[0-9A-Z]{1}$/,
        "Please provide a valid GST number",
      ],
    },

    openingHours: {
      type: String,
      trim: true,
      maxlength: 100,
      default: "9:00 AM - 9:00 PM",
    },

    whatsappNumber: {
      type: String,
      match: [/^[0-9]{10}$/, "WhatsApp number must be 10 digits"],
    },

    // Security: sensitive keys should not be returned in general queries
    whatsappApiKey: {
      type: String,
      select: false, 
    },

    logoUrl: {
      type: String,
      trim: true,
      default: "https://via.placeholder.com/150", // Fallback logo
    },

    currency: {
      type: String,
      default: "INR",
      uppercase: true,
    },
    
    // Bill printing (per branch, since each counter can have a different printer)
    // Paper: thermal roll width or a full A4 page
    printPaper: { type: String, enum: ["58mm", "80mm", "104mm", "a4"], default: "80mm" },
    // Size of everything on the bill, in % (100 = normal)
    printScale: { type: Number, min: 60, max: 160, default: 100 },
    // Blank space around the bill, in mm
    printMargin: { type: Number, min: 0, max: 15, default: 3 },

    // Low stock alert threshold (Useful for global notifications)
    lowStockThreshold: {
      type: Number,
      default: 10,
    }
  },
  { 
    timestamps: true,
    // Prevents Mongoose from adding the __v version key for this simple config
    versionKey: false 
  }
);

module.exports = mongoose.model("Settings", settingsSchema);