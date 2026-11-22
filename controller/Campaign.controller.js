const router = require("express").Router();
const Joi = require("joi");
const mongoose = require("mongoose");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

const Campaign = require("../models/Campaign.model");
const Coupon = require("../models/Coupon.model");
const Customer = require("../models/Customer.model");
const Bill = require("../models/Bill.model");
const Settings = require("../models/settings.model");
const transporter = require("../utils/mailer");
const { buildCampaignEmail } = require("../utils/campaignMail");
const { campaignUpload } = require("../middleware/upload.middleware");
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");

const MAX_RECIPIENTS = 1000; // per campaign, keeps us inside the mailbox's daily sending limit
const SEND_GAP_MS = 1200; // pause between emails so the SMTP server doesn't flag us as spam
const STALE_SEND_MS = 15 * 60 * 1000; // "sending" with no progress for this long = interrupted (e.g. server restart)
const UPLOAD_DIR = path.join(__dirname, "..", "uploads", "campaigns");
const LOGO = path.join(__dirname, "..", "assets", "logo.png");
const IMAGE_RX = /^\/uploads\/campaigns\/[\w.-]+\.(jpg|png)$/;
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const admin = [verifyToken, authorizeRoles("admin")];

// ── Unsubscribe links ───────────────────────────────────────
const unsubToken = (mobile) => crypto.createHmac("sha256", process.env.JWT_SECRET).update(`unsub:${mobile}`).digest("hex").slice(0, 32);
const publicBase = () => (process.env.PUBLIC_URL || process.env.FRONTEND_URL || "https://ifrutico.com").replace(/\/+$/, "");
const unsubUrl = (mobile) => `${publicBase()}/api/campaigns/unsubscribe?m=${mobile}&t=${unsubToken(mobile)}`;

// ── Validation ──────────────────────────────────────────────
const campaignSchema = Joi.object({
  name: Joi.string().trim().max(100).required(),
  template: Joi.string().valid("coupon", "event", "poster").required(),
  subject: Joi.string().trim().max(150).required(),
  preheader: Joi.string().trim().max(150).allow(""),
  heading: Joi.string().trim().max(120).allow(""),
  message: Joi.string().trim().max(3000).allow(""),
  coupon: Joi.string().hex().length(24).allow(null, "")
    .when("template", { is: "coupon", then: Joi.required().invalid(null, "").messages({ "any.invalid": "Pick a coupon for this campaign.", "any.required": "Pick a coupon for this campaign." }) }),
  eventDate: Joi.date().allow(null, ""),
  eventTime: Joi.string().trim().max(60).allow(""),
  venue: Joi.string().trim().max(200).allow(""),
  imageUrl: Joi.string().pattern(IMAGE_RX).allow(null, "")
    .when("template", { is: "poster", then: Joi.required().invalid(null, "").messages({ "any.invalid": "Upload a poster image.", "any.required": "Upload a poster image." }) }),
  ctaText: Joi.string().trim().max(40).allow(""),
  ctaUrl: Joi.string().uri({ scheme: ["http", "https"] }).max(500).allow("")
    .messages({ "string.uriCustomScheme": "Button link must start with http:// or https://" }),
  audience: Joi.object({
    segment: Joi.string().valid("regular", "all").default("regular"),
    minBills: Joi.number().integer().min(1).max(1000).default(3),
    withinDays: Joi.number().integer().min(0).max(3650).default(0),
  }).default(),
});
const clean = (v) => ({ ...v, coupon: v.coupon || null, eventDate: v.eventDate || null, imageUrl: v.imageUrl || null });

// ── Audience ────────────────────────────────────────────────
// Regular customers = at least `minBills` bills (optionally within the last `withinDays` days), with an email, not unsubscribed
const findAudience = async ({ segment = "regular", minBills = 3, withinDays = 0 } = {}) => {
  const base = { email: { $nin: [null, ""] }, marketingOptOut: { $ne: true } };
  let filter = base;
  const billsByMobile = new Map();
  if (segment === "regular") {
    const match = withinDays > 0 ? { createdAt: { $gte: new Date(Date.now() - withinDays * 864e5) } } : {};
    const groups = await Bill.aggregate([
      { $match: match },
      { $group: { _id: "$mobileNumber", bills: { $sum: 1 } } },
      { $match: { bills: { $gte: minBills } } },
    ]);
    groups.forEach((g) => billsByMobile.set(g._id, g.bills));
    filter = { ...base, mobile: { $in: [...billsByMobile.keys()] } };
  }
  const customers = await Customer.find(filter).select("name email mobile").sort({ updatedAt: -1 }).lean();
  const seen = new Set();
  return customers
    .filter((c) => EMAIL_RX.test(c.email) && !seen.has(c.email) && seen.add(c.email))
    .map((c) => ({ ...c, bills: billsByMobile.get(c.mobile) }));
};

// ── Email assembly ──────────────────────────────────────────
const brandFor = (userId) => Settings.findOne({ userId }).select("shopName address phoneNumber").lean();

const mailFor = (campaign, coupon, brand, customer) => {
  const imagePath = campaign.imageUrl && IMAGE_RX.test(campaign.imageUrl) ? path.join(UPLOAD_DIR, path.basename(campaign.imageUrl)) : null;
  const hasImage = imagePath && fs.existsSync(imagePath);
  const hasLogo = fs.existsSync(LOGO);
  const unsubscribeUrl = customer.mobile ? unsubUrl(customer.mobile) : null;
  const { subject, html, text } = buildCampaignEmail({
    campaign, coupon, brand, customerName: customer.name,
    imageSrc: hasImage ? "cid:banner@ifrutico" : null,
    logoSrc: hasLogo ? "cid:logo@ifrutico" : null,
    unsubscribeUrl,
  });
  const safeName = String(brand?.shopName || "Ifrutico").replace(/["\r\n<>]/g, "");
  return {
    from: `"${safeName}" <${process.env.MAIL_USER}>`,
    to: customer.email,
    subject,
    html,
    text,
    headers: unsubscribeUrl ? { "List-Unsubscribe": `<${unsubscribeUrl}>` } : undefined,
    attachments: [
      ...(hasLogo ? [{ filename: "logo.png", path: LOGO, cid: "logo@ifrutico" }] : []),
      ...(hasImage ? [{ filename: path.basename(imagePath), path: imagePath, cid: "banner@ifrutico" }] : []),
    ],
  };
};

// ── Routes ──────────────────────────────────────────────────

// Public: one-click unsubscribe from the link in every campaign email
router.get("/unsubscribe", async (req, res) => {
  const m = String(req.query.m || "");
  const t = String(req.query.t || "");
  const page = (title, msg) =>
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
    `<body style="margin:0;font-family:Segoe UI,Roboto,Arial,sans-serif;background:#F7F3EC;display:flex;min-height:100vh;align-items:center;justify-content:center;">` +
    `<div style="background:#fff;padding:40px 32px;border-radius:20px;max-width:420px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.06)">` +
    `<h1 style="color:#1E3932;font-size:24px;margin:0 0 10px">${title}</h1><p style="color:#6b7671;line-height:1.6;margin:0">${msg}</p></div></body>`;
  const valid = /^[0-9]{10}$/.test(m) && t.length === 32 &&
    crypto.timingSafeEqual(Buffer.from(t), Buffer.from(unsubToken(m)));
  if (!valid) return res.status(400).send(page("Link not valid", "This unsubscribe link is incomplete or has been changed."));
  try {
    await Customer.updateOne({ mobile: m }, { $set: { marketingOptOut: true } });
    return res.send(page("You're unsubscribed", "You won't receive offer or event emails from us any more. Bills and invoices are not affected."));
  } catch (e) {
    return res.status(500).send(page("Something went wrong", "Please try the link again in a moment."));
  }
});

// Brand logo for the dashboard preview (real emails embed it as an attachment)
router.get("/logo.png", (req, res) => {
  res.set("Cache-Control", "public, max-age=86400");
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  return res.sendFile(LOGO);
});

router.get("/", ...admin, async (req, res) => {
  try {
    // Mark sends that stopped making progress (server restarted mid-send) as failed so they can be retried
    await Campaign.updateMany(
      { status: "sending", updatedAt: { $lt: new Date(Date.now() - STALE_SEND_MS) } },
      { $set: { status: "failed", lastError: "Sending was interrupted. Send again to continue; customers already emailed are skipped." } }
    );
    const data = await Campaign.find().sort({ createdAt: -1 }).populate("coupon", "code type value maxDiscount").lean();
    return res.json({ success: true, data });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/audience", ...admin, async (req, res) => {
  const { error, value } = campaignSchema.extract("audience").validate({
    segment: req.query.segment, minBills: req.query.minBills, withinDays: req.query.withinDays,
  });
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });
  try {
    const list = await findAudience(value);
    return res.json({
      success: true,
      data: {
        count: Math.min(list.length, MAX_RECIPIENTS),
        matched: list.length,
        capped: list.length > MAX_RECIPIENTS,
        sample: list.slice(0, 8).map((c) => ({ name: c.name, email: c.email, bills: c.bills })),
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// Poster / banner upload
router.post("/upload", ...admin, (req, res) => {
  campaignUpload.single("image")(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.code === "LIMIT_FILE_SIZE" ? "Image must be under 3 MB." : err.message });
    if (!req.file) return res.status(400).json({ success: false, message: "Choose an image." });
    // Check the real file type, not just what the browser claimed
    const buf = Buffer.alloc(8);
    const fd = fs.openSync(req.file.path, "r");
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    const ok = (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) || buf.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!ok) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ success: false, message: "That file is not a valid JPG or PNG image." });
    }
    return res.json({ success: true, data: { url: `/uploads/campaigns/${req.file.filename}` } });
  });
});

// Live preview of unsaved changes (the dashboard shows it in an iframe)
router.post("/preview", ...admin, async (req, res) => {
  const { error, value } = campaignSchema.validate(req.body, { abortEarly: false });
  // Preview even half-filled drafts: missing fields are fine, malformed ones are not
  const bad = error?.details.find((d) => !["any.required", "any.invalid"].includes(d.type));
  if (bad) return res.status(400).json({ success: false, message: bad.message });
  const v = value;
  try {
    const [coupon, brand] = await Promise.all([
      v.coupon && mongoose.Types.ObjectId.isValid(v.coupon) ? Coupon.findById(v.coupon).lean() : null,
      brandFor(req.user.id),
    ]);
    const { subject, html } = buildCampaignEmail({
      campaign: { ...v, template: v.template || "poster" },
      coupon,
      brand: brand || {},
      customerName: "Priya Sharma",
      imageSrc: v.imageUrl ? `/api${v.imageUrl}` : null,
      logoSrc: fs.existsSync(LOGO) ? "/api/campaigns/logo.png" : null,
      unsubscribeUrl: "#",
    });
    return res.json({ success: true, data: { subject, html } });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/", ...admin, async (req, res) => {
  const { error, value } = campaignSchema.validate(req.body);
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });
  try {
    const campaign = await Campaign.create({ ...clean(value), createdBy: req.user.id });
    return res.status(201).json({ success: true, message: "Campaign saved", data: campaign });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.put("/:id", ...admin, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid campaign ID" });
  const { error, value } = campaignSchema.validate(req.body);
  if (error) return res.status(400).json({ success: false, message: error.details[0].message });
  try {
    const campaign = await Campaign.findOneAndUpdate(
      { _id: req.params.id, status: { $in: ["draft", "failed"] } },
      { $set: clean(value) },
      { new: true, runValidators: true }
    );
    if (!campaign) return res.status(400).json({ success: false, message: "Sent campaigns can't be edited. Duplicate it instead." });
    return res.json({ success: true, message: "Campaign saved", data: campaign });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

router.delete("/:id", ...admin, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid campaign ID" });
  try {
    const deleted = await Campaign.findOneAndDelete({ _id: req.params.id, status: { $ne: "sending" } });
    if (!deleted) return res.status(400).json({ success: false, message: "Can't delete a campaign while it's sending." });
    return res.json({ success: true, message: "Campaign deleted" });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

const testLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
  message: { success: false, message: "Too many test emails this hour." },
});

// Send one copy to the admin (or any address they type) before the real send
router.post("/:id/test", ...admin, testLimiter, async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!EMAIL_RX.test(email) || email.length > 150) return res.status(400).json({ success: false, message: "Enter a valid email address." });
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid campaign ID" });
  try {
    const campaign = await Campaign.findById(req.params.id).lean();
    if (!campaign) return res.status(404).json({ success: false, message: "Campaign not found" });
    const [coupon, brand] = await Promise.all([campaign.coupon ? Coupon.findById(campaign.coupon).lean() : null, brandFor(req.user.id)]);
    const mail = mailFor(campaign, coupon, brand || {}, { name: "Test Customer", email });
    await transporter.sendMail({ ...mail, subject: `[TEST] ${mail.subject}` });
    return res.json({ success: true, message: `Test email sent to ${email}` });
  } catch (e) {
    console.error("Campaign test send failed:", e.message);
    return res.status(500).json({ success: false, message: "Could not send the test email. Check the mail settings." });
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Background send: one email at a time, progress saved as it goes
const runSend = async (campaignId, userId) => {
  const campaign = await Campaign.findById(campaignId).lean();
  try {
    const [coupon, brand, audience] = await Promise.all([
      campaign.coupon ? Coupon.findById(campaign.coupon).lean() : null,
      brandFor(userId),
      findAudience(campaign.audience),
    ]);
    if (campaign.template === "coupon" && !coupon) throw new Error("The coupon for this campaign was deleted.");
    const already = new Set((await Campaign.findById(campaignId).select("+sentTo").lean()).sentTo || []);
    const recipients = audience.filter((c) => !already.has(c.email)).slice(0, Math.max(0, MAX_RECIPIENTS - already.size));
    await Campaign.updateOne({ _id: campaignId }, { $set: { "stats.total": already.size + recipients.length, "stats.sent": already.size, "stats.failed": 0 } });
    let lastError = null;
    for (const customer of recipients) {
      try {
        await transporter.sendMail(mailFor(campaign, coupon, brand || {}, customer));
        await Campaign.updateOne({ _id: campaignId }, { $inc: { "stats.sent": 1 }, $addToSet: { sentTo: customer.email } });
      } catch (e) {
        lastError = e.message;
        await Campaign.updateOne({ _id: campaignId }, { $inc: { "stats.failed": 1 } });
      }
      await sleep(SEND_GAP_MS);
    }
    const done = await Campaign.findById(campaignId).select("stats").lean();
    const allFailed = done.stats.total > 0 && done.stats.sent === 0;
    await Campaign.updateOne({ _id: campaignId }, {
      $set: { status: allFailed ? "failed" : "sent", sentAt: new Date(), lastError: lastError ? String(lastError).slice(0, 300) : undefined },
    });
  } catch (e) {
    console.error("Campaign send failed:", e.message);
    await Campaign.updateOne({ _id: campaignId }, { $set: { status: "failed", lastError: String(e.message).slice(0, 300) } });
  }
};

const sendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
  message: { success: false, message: "Too many campaign sends this hour." },
});

router.post("/:id/send", ...admin, sendLimiter, async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid campaign ID" });
  try {
    // Atomic claim: a double click can't start two sends
    const campaign = await Campaign.findOneAndUpdate(
      { _id: req.params.id, status: { $in: ["draft", "failed"] } },
      { $set: { status: "sending", lastError: null } },
      { new: true }
    );
    if (!campaign) return res.status(400).json({ success: false, message: "This campaign is already sending or was sent." });
    runSend(campaign._id, req.user.id); // not awaited: the page polls for progress
    return res.status(202).json({ success: true, message: "Sending started", data: campaign });
  } catch (e) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
