const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const salespersonSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      maxlength: 100,
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Please provide a valid email"],
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [8, "Password must be at least 8 characters"],
      select: false, // Hidden from queries by default
    },
    mobile: {
      type: String,
      required: [true, "Mobile number is required"],
      unique: true,
      match: [/^[0-9]{10}$/, "Mobile number must be 10 digits"],
    },
    role: {
      type: String,
      enum: ["admin", "staff"],
      default: "staff",
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    // Login Security
    // Tokens issued before this moment are rejected (password change/reset signs everyone out)
    passwordChangedAt: {
      type: Date,
    },
    loginAttempts: {
      type: Number,
      default: 0,
      required: true,
    },
    lockUntil: {
      type: Date,
    },
    // OTP Security
    otp: {
      type: String,
      select: false,
    },
    otpExpires: {
      type: Date,
      select: false,
    },
    // What the pending OTP may be used for: "login" (2-step sign-in) or "reset" (forgot password)
    otpPurpose: {
      type: String,
      enum: ["login", "reset"],
      select: false,
    },
    otpAttempts: {
      type: Number,
      default: 0,
      max: 5,
    },
  },
  { 
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true } 
  }
);

// -------------------------------------------------------------------------
// PRE-SAVE HOOK (Hashing)
// -------------------------------------------------------------------------
salespersonSchema.pre("save", async function () {
  // Hash Password if modified
  if (this.isModified("password")) {
    this.password = await bcrypt.hash(this.password, 12); // Slightly higher salt for production
    this.passwordChangedAt = new Date();
  }

  // Hash OTP if modified
  if (this.isModified("otp") && this.otp) {
    this.otp = await bcrypt.hash(this.otp, 10);
  }
});

// -------------------------------------------------------------------------
// INSTANCE METHODS
// -------------------------------------------------------------------------

// Compare Password
salespersonSchema.methods.comparePassword = async function (inputPassword) {
  // Note: Ensure password was selected in the query (e.g., .select('+password'))
  if (!this.password) return false;
  return await bcrypt.compare(inputPassword, this.password);
};

// Check if account is locked
salespersonSchema.methods.isLocked = function () {
  return !!(this.lockUntil && this.lockUntil > Date.now());
};

// Increment Login Attempts (Atomic Update)
salespersonSchema.methods.incrementLoginAttempts = async function () {
  const updates = { $inc: { loginAttempts: 1 } };
  
  // Lock account if attempts exceed 5
  if (this.loginAttempts + 1 >= 5 && !this.isLocked()) {
    updates.$set = { lockUntil: Date.now() + 15 * 60 * 1000 }; // 15 mins lock
  }

  return await this.constructor.updateOne({ _id: this._id }, updates);
};

// Reset Login Attempts
salespersonSchema.methods.resetLoginAttempts = async function () {
  return await this.constructor.updateOne(
    { _id: this._id },
    { $set: { loginAttempts: 0 }, $unset: { lockUntil: 1 } }
  );
};

// OTP Validation & Comparison
salespersonSchema.methods.compareOtp = async function (inputOtp) {
  if (!this.otp || !this.otpExpires || this.otpExpires < Date.now()) {
    return false;
  }
  return await bcrypt.compare(inputOtp, this.otp);
};

// Increment OTP Attempts
salespersonSchema.methods.incrementOtpAttempts = async function () {
  this.otpAttempts += 1;
  if (this.otpAttempts >= 5) {
    this.otp = undefined;
    this.otpExpires = undefined;
    this.otpAttempts = 0;
  }
  return await this.save(); // Save used here because we want to clear fields
};

module.exports = mongoose.model("SalesPerson", salespersonSchema);