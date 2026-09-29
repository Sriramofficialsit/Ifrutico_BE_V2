const express = require("express");
const auth = express.Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const Joi = require("joi");
const transporter = require("../utils/mailer");
const Salesperson = require("../models/Salesperson.model");
const LoginLog = require("../models/LoginLog.model");
const RevokedToken = require("../models/RevokedToken.model");
const { ipKeyGenerator } = require("express-rate-limit");
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");

require("dotenv").config();

// Specialized Rate Limiters
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: { success: false, message: "Too many login attempts, please try again after 15 minutes" }
});

// Second throttle keyed by the target email, so guessing one account from many IPs is still capped
const emailLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === "string" ? req.body.email.toLowerCase() : "";
    return email ? `login:${email}` : `ip:${ipKeyGenerator(req.ip)}`;
  },
  message: { success: false, message: "Too many login attempts for this account, please try again later" },
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: "Too many attempts, please try again later" }
});

const resendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { success: false, message: "Too many code requests, please try again in a few minutes" }
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { success: false, message: "Too many registration attempts, please try again later" }
});

const otpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { success: false, message: "Too many OTP requests, please try again after an hour" }
});

// Validation Schemas
const passwordPattern = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
const passwordErrorMessage = "Password must be at least 8 characters long and include uppercase, lowercase, a number, and a special character.";

const registerSchema = Joi.object({
  name: Joi.string().min(3).max(50).required(),
  email: Joi.string().email().required().lowercase(),
  password: Joi.string().regex(passwordPattern).required().messages({ 'string.pattern.base': passwordErrorMessage }),
  mobile: Joi.string().pattern(/^[0-9]{10}$/).required(),
});

const loginSchema = Joi.object({
  email: Joi.string().email().required().lowercase(),
  password: Joi.string().required(),
});

const otpSchema = Joi.object({
  email: Joi.string().email().required().lowercase(),
});

const verifyOtpSchema = Joi.object({
  email: Joi.string().email().required().lowercase(),
  otp: Joi.string().length(6).required(),
});

const resetPasswordSchema = Joi.object({
  email: Joi.string().email().required().lowercase(),
  otp: Joi.string().length(6).required(),
  newPassword: Joi.string().regex(passwordPattern).required().messages({ 'string.pattern.base': passwordErrorMessage }),
});

const loginVerifySchema = Joi.object({
  challenge: Joi.string().required(),
  otp: Joi.string().pattern(/^[0-9]{6}$/).required(),
});

const challengeSchema = Joi.object({ challenge: Joi.string().required() });

// Short-lived proof that the password step passed; the only way to reach the OTP step
const CHALLENGE_PURPOSE = "login-otp";
const signChallenge = (user) =>
  jwt.sign({ id: String(user._id), purpose: CHALLENGE_PURPOSE }, process.env.JWT_SECRET, { expiresIn: "10m", algorithm: "HS256" });

const readChallenge = (token) => {
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    return p.purpose === CHALLENGE_PURPOSE ? p : null;
  } catch {
    return null;
  }
};

const maskEmail = (email) => {
  const [n, d] = String(email).split("@");
  return `${n.slice(0, 2)}${"*".repeat(Math.max(n.length - 2, 1))}@${d}`;
};

// Emails a fresh login code. Throws if the mail can't be sent (caller must not let the user in).
const sendLoginOtp = async (user) => {
  const otp = crypto.randomInt(100000, 999999).toString();
  user.otp = otp;
  user.otpExpires = Date.now() + 5 * 60 * 1000;
  user.otpAttempts = 0;
  user.otpPurpose = "login";
  await user.save();
  try {
    await transporter.sendMail({
      from: process.env.MAIL_USER,
      to: user.email,
      subject: "Your Ifrutico login code",
      text: `Your login verification code is ${otp}. It is valid for 5 minutes. If you did not try to sign in, ignore this email and change your password.`,
    });
  } catch (e) {
    user.otp = undefined;
    user.otpExpires = undefined;
    user.otpPurpose = undefined;
    await user.save().catch(() => {});
    throw e;
  }
};

const deviceOf = (ua = "") => {
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Unknown browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iOS/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "Unknown OS";
  return `${browser} on ${os}`;
};

// Never blocks or fails a login
const recordLogin = (req, user) =>
  LoginLog.create({
    user: user._id, name: user.name, email: user.email, role: user.role,
    ip: req.ip || "", device: deviceOf(req.headers["user-agent"]),
  }).catch((e) => console.error("Login log failed:", e.message));

const setAuthCookie = (res, user) => {
  const token = jwt.sign(
    { id: user._id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "1d", algorithm: "HS256", jwtid: crypto.randomUUID() }
  );
  res.cookie("token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Strict",
    maxAge: 24 * 60 * 60 * 1000,
  });
};

// Used to burn the same bcrypt time when the account does not exist (prevents timing-based user enumeration)
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", 12);

const MAX_OTP_ATTEMPTS = 5;

// Routes
auth.post("/register-user", registerLimiter, async (req, res) => {
  // Accounts are created by admins (POST /sales/add). Public sign-up only exists if explicitly enabled.
  if (process.env.ALLOW_PUBLIC_REGISTER !== "true") {
    return res.status(404).json({ success: false, message: "Route not found" });
  }
  try {
    const { error, value } = registerSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }
    const { name, email, password, mobile } = value;
    
    const existingUser = await Salesperson.findOne({ email });
    if (existingUser) {
      return res.json({ success: true, message: "If an account exists with this email, you will be notified." });
    }

    // Public sign-ups are never trusted: always a staff account that an admin must activate
    const newUser = new Salesperson({ name, email, password, mobile, role: "staff", status: "inactive" });
    await newUser.save();

    return res.json({ success: true, message: "Registration request received. Please check your email if your account is approved." });

  } catch (error) {
    if (error.code === 11000) {
      return res.json({ success: true, message: "Registration request received. Please check your email if your account is approved." });
    }
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

auth.post("/login-password", loginLimiter, emailLoginLimiter, async (req, res) => {
  try {
    const { error, value } = loginSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }
    const { email, password } = value;

    const user = await Salesperson.findOne({ email }).select("+password");
    if (!user) {
      await bcrypt.compare(password, DUMMY_HASH);
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    // Always check the password first: lock/inactive states are only revealed to someone who knows it,
    // so the response can't be used to discover which emails have accounts.
    const locked = await user.isLocked();
    const matched = await user.comparePassword(password);
    if (!matched) {
      if (!locked) await user.incrementLoginAttempts();
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }
    if (locked) {
      // Anyone can lock a known email by failing 5 times. The correct password from an IP that has signed in
      // before still gets through to the OTP step, so the owner isn't locked out by an attacker elsewhere.
      const knownIp = await LoginLog.exists({ user: user._id, ip: req.ip });
      if (!knownIp) {
        return res.status(423).json({ success: false, message: "Account temporarily locked. Please try again later." });
      }
    }
    if (user.status !== "active") {
      return res.status(403).json({ success: false, message: "Account is unavailable. Contact your administrator." });
    }

    await user.resetLoginAttempts();

    // Escape hatch for when email is unavailable: LOGIN_OTP=off skips the second step
    if (process.env.LOGIN_OTP === "off") {
      setAuthCookie(res, user);
      recordLogin(req, user);
      return res.json({ success: true, message: "Login successful" });
    }

    try {
      await sendLoginOtp(user);
    } catch (mailErr) {
      console.error("Login OTP email failed:", mailErr.message);
      return res.status(500).json({ success: false, message: "Could not send the verification code. Please try again." });
    }

    return res.json({
      success: true,
      otpRequired: true,
      challenge: signChallenge(user),
      emailHint: maskEmail(user.email),
      message: "Verification code sent to your email",
    });

  } catch (err) {
    console.error("Login Password Error:", err);
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// Step 2 of sign-in: verify the emailed code, then (and only then) create the session
auth.post("/login-verify", verifyLimiter, async (req, res) => {
  try {
    const { error, value } = loginVerifySchema.validate(req.body);
    if (error) return res.status(400).json({ success: false, message: "Enter the 6-digit code" });

    const claim = readChallenge(value.challenge);
    if (!claim) return res.status(401).json({ success: false, message: "Session expired. Please sign in again.", restart: true });

    const user = await Salesperson.findById(claim.id).select("+otp +otpExpires +otpAttempts +otpPurpose");
    if (!user || user.status !== "active" || user.otpPurpose !== "login") {
      return res.status(401).json({ success: false, message: "Session expired. Please sign in again.", restart: true });
    }
    if (!user.otp || !user.otpExpires || user.otpExpires < Date.now()) {
      return res.status(400).json({ success: false, message: "Code expired. Request a new one." });
    }
    if (user.otpAttempts >= MAX_OTP_ATTEMPTS) {
      return res.status(429).json({ success: false, message: "Too many wrong codes. Please sign in again.", restart: true });
    }
    if (!(await user.compareOtp(value.otp))) {
      user.otpAttempts += 1;
      await user.save();
      return res.status(400).json({ success: false, message: "Incorrect code" });
    }

    user.otp = undefined;
    user.otpExpires = undefined;
    user.otpAttempts = 0;
    user.otpPurpose = undefined;
    await user.save();

    setAuthCookie(res, user);
    recordLogin(req, user);
    return res.json({ success: true, message: "Login successful" });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

auth.post("/login-resend", resendLimiter, async (req, res) => {
  try {
    const { error, value } = challengeSchema.validate(req.body);
    if (error) return res.status(400).json({ success: false, message: "Invalid request" });
    const claim = readChallenge(value.challenge);
    if (!claim) return res.status(401).json({ success: false, message: "Session expired. Please sign in again.", restart: true });

    const user = await Salesperson.findById(claim.id).select("+otpExpires +otpPurpose");
    if (!user || user.status !== "active") {
      return res.status(401).json({ success: false, message: "Session expired. Please sign in again.", restart: true });
    }
    // Codes live 5 min; refuse another within 30s of the last one (stops email flooding)
    if (user.otpPurpose === "login" && user.otpExpires && user.otpExpires.getTime() - 5 * 60 * 1000 + 30 * 1000 > Date.now()) {
      return res.status(429).json({ success: false, message: "Please wait a few seconds before requesting another code" });
    }
    try {
      await sendLoginOtp(user);
    } catch (mailErr) {
      console.error("Login OTP resend failed:", mailErr.message);
      return res.status(500).json({ success: false, message: "Could not send the code. Please try again." });
    }
    return res.json({ success: true, message: "A new code has been sent", emailHint: maskEmail(user.email) });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// Step 2 of the forgot-password flow: checks the OTP without consuming it (POST /reset-password consumes it)
auth.post("/verify-forgot-otp", verifyLimiter, async (req, res) => {
  try {
    const { error, value } = verifyOtpSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }
    const { email, otp } = value;

    const user = await Salesperson.findOne({ email }).select("+otp +otpExpires +otpAttempts +otpPurpose");
    if (!user || user.role !== "admin" || user.status !== "active" || user.otpPurpose !== "reset") {
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }
    if (!user.otp || !user.otpExpires || user.otpExpires < Date.now()) {
      return res.status(400).json({ success: false, message: "OTP has expired" });
    }
    if (user.otpAttempts >= MAX_OTP_ATTEMPTS) {
      return res.status(429).json({ success: false, message: "Too many failed attempts. Please request a new OTP." });
    }
    if (!(await user.compareOtp(otp))) {
      user.otpAttempts += 1;
      await user.save();
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }
    return res.json({ success: true, message: "OTP verified" });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

auth.post("/logout", async (req, res) => {
  try {
    const token = req.cookies?.token || req.headers.authorization?.split(" ")[1];
    const p = token && jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    if (p?.jti) await RevokedToken.updateOne({ jti: p.jti }, { $set: { expiresAt: new Date(p.exp * 1000) } }, { upsert: true });
  } catch { /* invalid/expired token: nothing to revoke */ }

  res.clearCookie("token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Strict",
  });
  return res.json({ success: true, message: "Logged out successfully" });
});

auth.get("/me", verifyToken, async (req, res) => {
  try {
    const user = await Salesperson.findById(req.user.id).select("name email role status").lean();
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    return res.json({ success: true, data: user });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

auth.post("/forgot-password", otpLimiter, async (req, res) => {
  try {
    const { error, value } = otpSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }
    const { email } = value;

    const user = await Salesperson.findOne({ email });
    const genericReply = { success: true, message: "If an admin account exists for this email, a reset OTP has been sent." };
    if (!user || user.role !== "admin" || user.status !== "active") {
      return res.json(genericReply);
    }

    const otp = crypto.randomInt(100000, 999999).toString();
    user.otp = otp;
    user.otpExpires = Date.now() + 10 * 60 * 1000;
    user.otpAttempts = 0;
    user.otpPurpose = "reset";
    await user.save();

    await transporter.sendMail({
      from: process.env.MAIL_USER,
      to: user.email,
      subject: "Password Reset OTP",
      text: `Your OTP for password reset is ${otp}. It is valid for 10 minutes.`,
    });

    return res.json(genericReply);
  } catch (err) {
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

auth.post("/reset-password", verifyLimiter, async (req, res) => {
  try {
    const { error, value } = resetPasswordSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }
    const { email, otp, newPassword } = value;

    const user = await Salesperson.findOne({ email }).select("+otp +otpExpires +otpAttempts +otpPurpose");
    if (!user || user.role !== "admin" || user.status !== "active" || user.otpPurpose !== "reset") {
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }

    if (!user.otp || !user.otpExpires || user.otpExpires < Date.now()) {
      return res.status(400).json({ success: false, message: "OTP has expired" });
    }

    if (user.otpAttempts >= MAX_OTP_ATTEMPTS) {
      return res.status(429).json({ success: false, message: "Too many failed attempts. Please request a new OTP." });
    }

    const isMatch = await user.compareOtp(otp);
    if (!isMatch) {
      user.otpAttempts += 1;
      await user.save();
      return res.status(400).json({ success: false, message: "Invalid OTP" });
    }

    user.password = newPassword;
    user.loginAttempts = 0;
    user.lockUntil = undefined;
    user.otp = undefined;
    user.otpExpires = undefined;
    user.otpAttempts = 0;
    user.otpPurpose = undefined;
    await user.save();

    return res.json({ success: true, message: "Password reset successful. You can now login with your new password." });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// ---- Admin: who signed in and when ----
// GET /login-activity?page&limit&user&from — newest first, plus today's headline numbers
auth.get("/login-activity", verifyToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const mongoose = require("mongoose");
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));

    const filter = {};
    if (req.query.user) {
      if (!mongoose.Types.ObjectId.isValid(req.query.user)) return res.status(400).json({ success: false, message: "Invalid user" });
      filter.user = new mongoose.Types.ObjectId(req.query.user);
    }
    const from = new Date(req.query.from);
    if (req.query.from && !isNaN(from)) filter.loginAt = { $gte: from };

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [data, total, today, activeToday] = await Promise.all([
      LoginLog.find(filter).sort({ loginAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      LoginLog.countDocuments(filter),
      LoginLog.countDocuments({ loginAt: { $gte: startOfDay } }),
      LoginLog.distinct("user", { loginAt: { $gte: startOfDay } }),
    ]);

    return res.json({
      success: true,
      data,
      pagination: { page, totalPages: Math.ceil(total / limit), total },
      summary: { today, activeToday: activeToday.length },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// GET /login-activity/users — every account with its last login and login count
auth.get("/login-activity/users", verifyToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const [users, stats] = await Promise.all([
      Salesperson.find().select("name email role status").lean(),
      LoginLog.aggregate([{ $group: { _id: "$user", lastLogin: { $max: "$loginAt" }, logins: { $sum: 1 } } }]),
    ]);
    const byUser = new Map(stats.map((x) => [String(x._id), x]));
    const data = users
      .map((u) => ({ ...u, lastLogin: byUser.get(String(u._id))?.lastLogin || null, logins: byUser.get(String(u._id))?.logins || 0 }))
      .sort((a, b) => new Date(b.lastLogin || 0) - new Date(a.lastLogin || 0));
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

module.exports = auth;

