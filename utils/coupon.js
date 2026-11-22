// Coupon rules shared by the coupon validate endpoint and bill creation.
// KEEP IN SYNC with FE/src/utils/coupon.js (the New Bill preview).
const r2 = (n) => Number(Number(n).toFixed(2));

// ₹ a coupon takes off a bill whose items add up to `gross`
const couponDiscount = (coupon, gross) => {
  if (!(gross > 0)) return 0;
  let d = coupon.type === "percent" ? (gross * Math.min(coupon.value, 100)) / 100 : coupon.value;
  if (coupon.type === "percent" && coupon.maxDiscount > 0) d = Math.min(d, coupon.maxDiscount);
  return r2(Math.min(d, gross));
};

const BILL_TYPE_LABEL = { retail: "Retail", event: "Events & Functions", stall: "Stalls" };

// Everything except per-customer usage (needs a DB count). Returns an error message or null.
const couponProblem = (coupon, { gross, billType, now = new Date() }) => {
  if (!coupon || !coupon.active) return "This coupon code is not valid.";
  if (coupon.validFrom && now < coupon.validFrom) return `This coupon starts on ${coupon.validFrom.toLocaleDateString("en-IN")}.`;
  if (coupon.validTo && now > coupon.validTo) return "This coupon has expired.";
  if (coupon.usageLimit > 0 && coupon.usedCount >= coupon.usageLimit) return "This coupon has been fully used.";
  if (coupon.billTypes?.length && !coupon.billTypes.includes(billType)) {
    return `This coupon is only for ${coupon.billTypes.map((t) => BILL_TYPE_LABEL[t]).join(", ")} bills.`;
  }
  if (coupon.minBill > 0 && gross < coupon.minBill) return `Add ₹${r2(coupon.minBill - gross)} more to use this coupon (minimum bill ₹${coupon.minBill}).`;
  return null;
};

// "20% off (up to ₹100)" / "₹50 off"
const offerText = (c) =>
  c.type === "percent" ? `${c.value}% OFF${c.maxDiscount > 0 ? ` (up to ₹${c.maxDiscount})` : ""}` : `₹${c.value} OFF`;

// Public fields the billing screen needs to preview the discount
const publicCoupon = (c) => ({
  code: c.code, description: c.description, type: c.type, value: c.value, maxDiscount: c.maxDiscount,
  minBill: c.minBill, validTo: c.validTo, billTypes: c.billTypes, perCustomerLimit: c.perCustomerLimit,
});

module.exports = { couponDiscount, couponProblem, offerText, publicCoupon };
