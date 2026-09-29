const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const mongoSanitize = require("express-mongo-sanitize");
const compression = require("compression");
require("dotenv").config();

const dbconnect = require("./config/db");

const product = require("./controller/Products.controller");
const bill = require("./controller/Bill.controller");
const salesperson = require("./controller/salesperson.controller");
const Auth = require("./controller/Auth.controller");
const settings = require("./controller/Settings.controller");
const menuLeads = require("./controller/MenuLead.controller");
const orderLeads = require("./controller/OrderLead.controller");
const testimonials = require("./controller/Testimonial.controller");
const dealershipLeads = require("./controller/DealershipLead.controller");
const customers = require("./controller/Customer.controller");

const morgan = require("morgan");
const path = require("path");
const app = express();

// Behind nginx: without this every client shares the proxy's IP, so the per-IP
// rate limiters (5 logins / 15 min) would lock out ALL users after 5 failures.
app.set("trust proxy", 1);

app.use(helmet());
app.disable("x-powered-by");
app.use(compression());
// Upload filenames are unique (timestamp + random), so they can be cached "forever"
app.use("/uploads", (req, res, next) => {
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
}, express.static(path.join(__dirname, "uploads"), {
  maxAge: "30d",
  immutable: true,
  index: false,
  dotfiles: "deny",
  setHeaders: (res) => {
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; sandbox");
    res.setHeader("X-Content-Type-Options", "nosniff");
  },
}));

app.use(cors({
  origin: process.env.FRONTEND_URL || "https://ifrutico.com",
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
}));

// File uploads go through multer; JSON/form bodies are small
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));
app.use(cookieParser());
app.use(mongoSanitize()); // Prevent NoSQL injection (Moved after body parsers)

// Logging
if (process.env.NODE_ENV === "production") {
  app.use(morgan("combined"));
} else {
  app.use(morgan("dev"));
}


const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: {
    success: false,
    message: "Too many requests, please try again later"
  },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// API JSON can contain PII/financial data: keep it out of shared and browser caches
// (routes that opt in to caching, like public testimonials, set their own header afterwards)
app.use((req, res, next) => {
  if (!req.path.startsWith("/uploads")) res.set("Cache-Control", "no-store");
  next();
});

dbconnect();


app.use("/product", product);
app.use("/bill", bill);
app.use("/sales", salesperson);
app.use("/", Auth);
app.use("/settings", settings);
app.use("/menu-leads", menuLeads);
app.use("/order-leads", orderLeads);
app.use("/testimonials", testimonials);
app.use("/dealership-leads", dealershipLeads);
app.use("/customers", customers);

app.get("/", (req, res) => {
  res.json({ message: "Server Working!!", success: true });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found"
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  const status = err.status || 500;
  const message = process.env.NODE_ENV === "production"
    ? "Internal Server Error"
    : err.message;

  res.status(status).json({
    success: false,
    message: message,
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack })
  });
});

const PORT = process.env.PORT || 5001;

if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = app;
