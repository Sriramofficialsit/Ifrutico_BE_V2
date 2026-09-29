// Dev helper: creates (or resets) a local test admin. Refuses to run outside a localhost database.
require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const Salesperson = require("../models/Salesperson.model");

const EMAIL = "test.admin@example.com";
// Random per run: a fixed, published password would be a backdoor if this ever reached a real database
const PASSWORD = `Aa1@${require("crypto").randomBytes(9).toString("base64url")}`;

(async () => {
  const uri = process.env.MONGODB_URI || "";
  if (!/^mongodb:\/\/([^/@]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri)) {
    console.error("Refusing to run: MONGODB_URI is not a localhost database.");
    process.exit(1);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });

  let user = await Salesperson.findOne({ email: EMAIL });
  if (!user) user = new Salesperson({ name: "Test Admin", email: EMAIL, mobile: "9000000001" });
  Object.assign(user, { password: PASSWORD, role: "admin", status: "active", loginAttempts: 0, lockUntil: undefined });
  await user.save();

  console.log(`Test admin ready -> email: ${EMAIL}  password: ${PASSWORD}`);
  await mongoose.disconnect();
})().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
