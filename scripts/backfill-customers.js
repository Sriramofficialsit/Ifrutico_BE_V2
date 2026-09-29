// One-off: builds Customer profiles from bills that were created before the Customers feature existed.
// Safe to re-run (upserts). Uses the most recent non-empty name/email/GST per mobile number.
require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const Bill = require("../models/Bill.model");
const Customer = require("../models/Customer.model");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  const rows = await Bill.aggregate([
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$mobileNumber",
        name: { $first: "$customerName" },
        email: { $first: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ["$customerEmail", ""] } }, 0] }, "$customerEmail", "$$REMOVE"] } },
        gst: { $first: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ["$customerGstNumber", ""] } }, 0] }, "$customerGstNumber", "$$REMOVE"] } },
      },
    },
  ]);
  let n = 0;
  for (const r of rows) {
    const set = { name: r.name };
    if (r.email) set.email = String(r.email).toLowerCase();
    if (r.gst) set.gstNumber = r.gst;
    await Customer.updateOne({ mobile: r._id }, { $set: set }, { upsert: true });
    n++;
  }
  console.log(`Backfilled ${n} customer(s) from existing bills.`);
  await mongoose.disconnect();
})().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
