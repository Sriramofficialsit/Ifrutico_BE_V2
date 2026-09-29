const mongoose = require("mongoose");

// Session tokens that were logged out before they expired. Rows delete themselves once the token would have expired anyway.
const RevokedTokenSchema = new mongoose.Schema({
  jti: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
});

module.exports = mongoose.model("RevokedToken", RevokedTokenSchema);
