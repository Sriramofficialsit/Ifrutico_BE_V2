const mongoose = require("mongoose");

const testimonialSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  content: {
    type: String,
    required: true,
    trim: true,
  },
  rating: {
    type: Number,
    required: true,
    min: 1,
    max: 5,
  },
  gender: {
    type: String,
    enum: ["male", "female"],
    required: true,
  },
  isApproved: {
    type: Boolean,
    default: false,
  },
}, { timestamps: true });

testimonialSchema.index({ isApproved: 1, createdAt: -1 });

module.exports = mongoose.model("Testimonial", testimonialSchema);
