const mongoose = require("mongoose");

// One row per successful (OTP-verified) login. Read by the admin "Login Activity" page.
const LoginLogSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "SalesPerson", required: true, index: true },
    name: { type: String, default: "" },
    email: { type: String, default: "" },
    role: { type: String, enum: ["admin", "staff"], default: "staff" },
    loginAt: { type: Date, default: Date.now },
    ip: { type: String, default: "" },
    device: { type: String, default: "" },
  },
  { timestamps: false }
);

LoginLogSchema.index({ loginAt: -1 });
LoginLogSchema.index({ user: 1, loginAt: -1 });
// Keep a year of history
LoginLogSchema.index({ loginAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 });

module.exports = mongoose.model("LoginLog", LoginLogSchema);
