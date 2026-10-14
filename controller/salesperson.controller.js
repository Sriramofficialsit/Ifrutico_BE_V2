const router = require("express").Router();
const mongoose = require("mongoose");
const Joi = require("joi");

const SalesPerson = require("../models/Salesperson.model");
const Product = require("../models/Products.model");
const BranchStock = require("../models/BranchStock.model");
const Bill = require("../models/Bill.model");
const { verifyToken } = require("../middleware/auth.middleware");
const { authorizeRoles } = require("../middleware/role.middleware");


const passwordPattern = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
const passwordErrorMessage = "Password must be at least 8 characters long and include uppercase, lowercase, a number, and a special character.";

const validateSalesPerson = (data, isUpdate = false) => {
  const schema = Joi.object({
    name: isUpdate ? Joi.string().trim().min(2) : Joi.string().trim().min(2).required(),
    email: isUpdate ? Joi.string().email() : Joi.string().email().required(),
    password: isUpdate ? Joi.forbidden() : Joi.string().regex(passwordPattern).required().messages({ 'string.pattern.base': passwordErrorMessage }),
    mobile: isUpdate
      ? Joi.string().pattern(/^[0-9]{10}$/).messages({ "string.pattern.base": "Mobile must be 10 digits" })
      : Joi.string().pattern(/^[0-9]{10}$/).required().messages({ "string.pattern.base": "Mobile must be 10 digits" }),
    role: Joi.string().valid("admin", "staff"),
    status: Joi.string().valid("active", "inactive"),
  });
  return schema.validate(data);
};



router.post("/add", verifyToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const { error, value } = validateSalesPerson(req.body);
    if (error) return res.status(400).json({ success: false, message: error.details[0].message });
    const newSalesPerson = await SalesPerson.create(value);
    const responseData = newSalesPerson.toObject();
    delete responseData.password;

    return res.status(201).json({
      success: true,
      message: "SalesPerson created successfully",
      data: responseData,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "Email or mobile already registered" });
    }
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});
router.get("/all", verifyToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      SalesPerson.find().select("-password -otp -otpExpires -otpAttempts -loginAttempts -lockUntil").sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      SalesPerson.countDocuments()
    ]);

    const visible = data;

    return res.status(200).json({
      success: true,
      pagination: { total, page, totalPages: Math.ceil(total / limit) },
      data: visible,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});
router.put("/update/:id", verifyToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid ID format" });
    }

    const { error, value } = validateSalesPerson(req.body, true);
    if (error) return res.status(400).json({ success: false, message: error.details[0].message });

    if (id === req.user.id && (value.role === "staff" || value.status === "inactive")) {
      return res.status(400).json({ success: false, message: "You cannot demote or deactivate your own account" });
    }

    const updated = await SalesPerson.findByIdAndUpdate(
      id,
      { $set: value },
      { new: true, runValidators: true }
    ).select("-password");

    if (!updated) return res.status(404).json({ success: false, message: "User not found" });

    return res.status(200).json({ success: true, message: "Updated successfully", data: updated });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "Email or mobile already registered" });
    }
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});


// GET /sales/:id/overview — admin: one branch's profile, sales figures and stock summary
router.get("/:id/overview", verifyToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid ID format" });
    }
    const branch = await SalesPerson.findById(id).select("-password -otp -otpExpires -otpAttempts -loginAttempts -lockUntil").lean();
    if (!branch) return res.status(404).json({ success: false, message: "Branch not found" });

    const oid = new mongoose.Types.ObjectId(id);
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const since = new Date(startOfDay);
    since.setDate(since.getDate() - 6);

    const [totals, today, weekly, customers, stock] = await Promise.all([
      Bill.aggregate([{ $match: { billedBy: oid } }, { $group: { _id: null, revenue: { $sum: "$totalAmount" }, bills: { $sum: 1 } } }]),
      Bill.aggregate([{ $match: { billedBy: oid, createdAt: { $gte: startOfDay } } }, { $group: { _id: null, sales: { $sum: "$totalAmount" }, bills: { $sum: 1 } } }]),
      Bill.aggregate([
        { $match: { billedBy: oid, createdAt: { $gte: since } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, total: { $sum: "$totalAmount" } } },
        { $sort: { _id: 1 } },
      ]),
      Bill.distinct("mobileNumber", { billedBy: oid }),
      BranchStock.aggregate([
        { $match: { branch: oid, stock: { $gt: 0 } } },
        { $lookup: { from: "products", localField: "product", foreignField: "_id", as: "p" } },
        { $unwind: "$p" },
        { $group: { _id: null, items: { $sum: 1 }, value: { $sum: { $multiply: ["$stock", { $divide: ["$p.price", { $ifNull: ["$p.priceQty", 1] }] }] } } } },
      ]),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        branch,
        stats: {
          revenue: totals[0]?.revenue || 0,
          bills: totals[0]?.bills || 0,
          todaySales: today[0]?.sales || 0,
          todayBills: today[0]?.bills || 0,
          customers: customers.length,
          stockItems: stock[0]?.items || 0,
          stockValue: Math.round((stock[0]?.value || 0) * 100) / 100,
        },
        weekly,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

// GET /sales/:id/customers — admin: customers this branch has billed, with spend
router.get("/:id/customers", verifyToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid ID format" });
    }
    const data = await Bill.aggregate([
      { $match: { billedBy: new mongoose.Types.ObjectId(id) } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$mobileNumber",
          name: { $first: "$customerName" },
          email: { $first: "$customerEmail" },
          bills: { $sum: 1 },
          spent: { $sum: "$totalAmount" },
          lastPurchase: { $first: "$createdAt" },
        },
      },
      { $sort: { lastPurchase: -1 } },
      { $limit: 500 },
    ]);
    return res.status(200).json({ success: true, data: data.map(({ _id, ...c }) => ({ mobile: _id, ...c })) });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

router.delete("/delete/:id", verifyToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid ID format" });
    }

    if (id === req.user.id) {
      return res.status(400).json({ success: false, message: "You cannot delete your own account" });
    }

    const deleted = await SalesPerson.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ success: false, message: "User not found" });

    // Return whatever the branch was holding to central stock instead of losing it
    const held = await BranchStock.find({ branch: id, stock: { $gt: 0 } }).lean();
    if (held.length) {
      await Product.bulkWrite(held.map((h) => ({ updateOne: { filter: { _id: h.product }, update: { $inc: { stock: h.stock } } } })));
    }
    await BranchStock.deleteMany({ branch: id });

    return res.status(200).json({ success: true, message: "User removed successfully" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

router.put("/change-password", verifyToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const { userId, newPassword } = req.body;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, message: "Invalid user ID format" });
    }
    if (!newPassword || !passwordPattern.test(newPassword)) {
      return res.status(400).json({ success: false, message: passwordErrorMessage });
    }

    const user = await SalesPerson.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    user.password = newPassword;
    await user.save();

    return res.status(200).json({ success: true, message: "Password changed successfully" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

module.exports = router;