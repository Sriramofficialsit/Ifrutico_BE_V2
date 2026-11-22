const mongoose = require("mongoose");
const crypto = require("crypto");

const BillSchema = new mongoose.Schema(
  {
    invoiceNumber: {
      type: String,
      unique: true,
    },

    customerName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },

    mobileNumber: {
      type: String,
      required: true,
      match: /^[0-9]{10}$/,
    },
    
    customerEmail: {
      type: String,
      required: false,
      trim: true,
      lowercase: true,
    },

    // Customer's GSTIN (optional, for B2B invoices)
    customerGstNumber: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 30,
    },

    // Which billing screen made it: retail (per unit), event (litre boxes), stall (scoops)
    billType: {
      type: String,
      enum: ["retail", "event", "stall"],
      default: "retail",
    },

    billedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesPerson",
      required: true,
    },

    products: {
      type: [
        {
          productId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Product",
            required: true,
          },
          itemName: {
            type: String,
            required: true,
            maxlength: 100,
          },
          price: {
            type: Number,
            required: true,
            min: 0,
          },
          // Snapshot of the product's price basis: price is for this many units (e.g. ₹120 per 500 g)
          priceQty: {
            type: Number,
            min: 0.001,
            default: 1,
          },
          quantity: {
            type: Number,
            required: true,
            min: 0.001,
          },
          unit: {
            type: String,
            enum: ["pcs", "g", "kg", "ml", "ltr"],
            default: "pcs",
          },
          // Snapshot of the product's GST mode at billing time, so later product edits never change old bills
          gstIncluded: {
            type: Boolean,
            default: false,
          },
          total: {
            type: Number,
            required: true,
            min: 0,
          },
          // Events & Functions: sold as `boxes` boxes of `boxSize` litres (quantity = their total, in the product's unit)
          boxSize: { type: Number, min: 0 },
          boxes: { type: Number, min: 0 },
          // Stalls: sold as `scoops` scoops of `scoopGrams` g each (quantity = their total, in the product's unit)
          scoops: { type: Number, min: 0 },
          scoopGrams: { type: Number, min: 0 },
          // Per-line discount (₹ or % of this line as priced), taken off before the bill discount and GST
          discountType: { type: String, enum: ["amount", "percent"] },
          discountValue: { type: Number, min: 0, default: 0 },
          // ₹ taken off this line (computed)
          discountAmount: { type: Number, min: 0, default: 0 },
        },
      ],
      validate: [(val) => val.length > 0, "At least one product required"],
    },

    subTotal: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },

    gstAmount: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },

    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },

    // Bill-level discount, entered as a flat amount (₹) or a percentage of the items' value.
    // It reduces the taxable value BEFORE GST (a discount shown on the invoice is not taxed).
    discountType: {
      type: String,
      enum: ["amount", "percent"],
    },
    discountValue: {
      type: Number,
      min: 0,
      default: 0,
    },
    // Coupon applied to this bill (its ₹ off is stored as an "amount" discount above)
    couponCode: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: 20,
    },
    // ₹ taken off by the bill-level discount / coupon (computed; what the invoice shows as "Discount")
    discountAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    // Sum of the per-line discounts (computed; shown as "Item discounts")
    itemDiscountAmount: {
      type: Number,
      min: 0,
      default: 0,
    },

    status: {
      type: String,
      enum: ["pending", "completed", "cancelled", "refunded", "failed"],
      default: "completed",
    },

    paymentMethod: {
      type: String,
      enum: ["cash", "upi", "card"],
      default: "cash",
      set: (v) => (v ? v.toLowerCase() : "cash"),
    },
  },
  { timestamps: true }
);


const GST_RATE = 0.05;
const r2 = (n) => Number(Number(n).toFixed(2));

// ₹ off for a bill whose lines (as priced) add up to `gross`. Never more than gross.
const discountOf = (gross, type, value) => {
  const v = Number(value) || 0;
  if (!(v > 0) || !(gross > 0)) return 0;
  if (type === "percent") return r2((gross * Math.min(v, 100)) / 100);
  if (type === "amount") return r2(Math.min(v, gross));
  return 0;
};

BillSchema.pre("validate", function () {
  if (!this.invoiceNumber) {
    this.invoiceNumber =
      "INV-" + Date.now() + "-" + crypto.randomInt(0, 100000);
  }

  // Normalise paymentMethod casing
  if (this.paymentMethod) {
    this.paymentMethod = this.paymentMethod.toLowerCase();
  }

  // item.total is the line as priced (price / priceQty x qty), e.g. ₹120 per 500 g, 750 g sold = ₹180.
  //  - Line discount: taken off that line first (item.discountAmount).
  //  - Bill discount: taken off the lines after their own discounts (split in proportion to their value).
  //  - GST excluded: 5% is added on top of the discounted line.
  //  - GST included: the line already contains it, so nothing is added; the GST portion is split out for display.
  // subTotal = value before GST, gstAmount = GST (added or contained), totalAmount = what the customer pays.
  // KEEP IN SYNC with FE/src/utils/gst.js (the New Bill preview).
  const products = this.products || [];
  const nets = products.map((item) => {
    item.total = r2((item.price / (item.priceQty || 1)) * item.quantity);
    item.discountAmount = discountOf(item.total, item.discountType, item.discountValue);
    if (!item.discountAmount) {
      item.discountType = undefined;
      item.discountValue = 0;
    }
    return r2(item.total - item.discountAmount);
  });
  this.itemDiscountAmount = r2(products.reduce((s, item) => s + item.discountAmount, 0));
  const gross = r2(nets.reduce((s, n) => s + n, 0));
  this.discountAmount = discountOf(gross, this.discountType, this.discountValue);
  if (!this.discountAmount) {
    this.discountType = undefined;
    this.discountValue = 0;
  }

  let taxable = 0;
  let gst = 0;
  let remaining = this.discountAmount;
  products.forEach((item, i) => {
    // Last line takes the rounding remainder so the shares add up to the discount exactly
    const share = i === products.length - 1 ? remaining : gross ? r2((nets[i] * this.discountAmount) / gross) : 0;
    remaining = r2(remaining - share);
    const net = Math.max(0, r2(nets[i] - share));
    if (item.gstIncluded) {
      const contained = r2((net * GST_RATE) / (1 + GST_RATE));
      gst += contained;
      taxable += net - contained;
    } else {
      gst += r2(net * GST_RATE);
      taxable += net;
    }
  });

  this.subTotal = r2(taxable);
  this.gstAmount = r2(gst);
  this.totalAmount = r2(this.subTotal + this.gstAmount);
});


BillSchema.index({ billedBy: 1, createdAt: -1 });
BillSchema.index({ mobileNumber: 1 });
BillSchema.index({ createdAt: -1 }); // admin list/stats (unfiltered by billedBy)
BillSchema.index({ billType: 1, createdAt: -1 });
BillSchema.index({ couponCode: 1, mobileNumber: 1 }, { sparse: true });


module.exports = mongoose.model("Bill", BillSchema);
module.exports.discountOf = discountOf;