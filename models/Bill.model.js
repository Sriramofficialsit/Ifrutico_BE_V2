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
  //  - GST excluded: 5% is added on top of the line.
  //  - GST included: the line already contains it, so nothing is added; the GST portion is split out for display.
  // subTotal = value before GST, gstAmount = GST (added or contained), totalAmount = what the customer pays.
  const GST_RATE = 0.05;
  const r2 = (n) => Number(n.toFixed(2));
  let taxable = 0;
  let gst = 0;

  if (this.products && this.products.length > 0) {
    this.products.forEach((item) => {
      item.total = r2((item.price / (item.priceQty || 1)) * item.quantity);
      if (item.gstIncluded) {
        const contained = r2((item.total * GST_RATE) / (1 + GST_RATE));
        gst += contained;
        taxable += item.total - contained;
      } else {
        gst += r2(item.total * GST_RATE);
        taxable += item.total;
      }
    });
  }

  this.subTotal = r2(taxable);
  this.gstAmount = r2(gst);
  this.totalAmount = r2(this.subTotal + this.gstAmount);
});


BillSchema.index({ billedBy: 1, createdAt: -1 });
BillSchema.index({ mobileNumber: 1 });
BillSchema.index({ createdAt: -1 }); // admin list/stats (unfiltered by billedBy)


module.exports = mongoose.model("Bill", BillSchema);