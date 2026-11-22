const mongoose = require("mongoose");

// An email campaign: one template (coupon offer, event invitation or poster) sent to a customer segment.
const CampaignSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    template: { type: String, enum: ["coupon", "event", "poster"], required: true },
    subject: { type: String, required: true, trim: true, maxlength: 150 },
    preheader: { type: String, trim: true, maxlength: 150 },
    heading: { type: String, trim: true, maxlength: 120 },
    message: { type: String, trim: true, maxlength: 3000 },
    // Coupon template: the coupon whose code is shown
    coupon: { type: mongoose.Schema.Types.ObjectId, ref: "Coupon" },
    // Event template
    eventDate: { type: Date },
    eventTime: { type: String, trim: true, maxlength: 60 },
    venue: { type: String, trim: true, maxlength: 200 },
    // Poster / banner image (path under /uploads/campaigns)
    imageUrl: { type: String, trim: true, maxlength: 300 },
    ctaText: { type: String, trim: true, maxlength: 40 },
    ctaUrl: { type: String, trim: true, maxlength: 500 },
    // Who gets it: "regular" = customers with at least minBills bills (in the last withinDays days, 0 = ever); "all" = every customer with an email
    audience: {
      segment: { type: String, enum: ["regular", "all"], default: "regular" },
      minBills: { type: Number, min: 1, max: 1000, default: 3 },
      withinDays: { type: Number, min: 0, max: 3650, default: 0 },
    },
    status: { type: String, enum: ["draft", "sending", "sent", "failed"], default: "draft" },
    stats: {
      total: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },
    lastError: { type: String, maxlength: 300 },
    // Emails already sent this campaign, so a resend after an interruption skips them
    sentTo: { type: [String], select: false, default: [] },
    sentAt: { type: Date },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "SalesPerson" },
  },
  { timestamps: true }
);

CampaignSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Campaign", CampaignSchema);
