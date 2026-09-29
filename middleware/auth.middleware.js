const jwt = require("jsonwebtoken");
const Salesperson = require("../models/Salesperson.model");
const RevokedToken = require("../models/RevokedToken.model");

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is not defined");
}
if (process.env.NODE_ENV === "production" && process.env.JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET is too short for production (use at least 32 random characters)");
}

const verifyToken = async (req, res, next) => {
  try {
    const token =
      req.cookies?.token ||
      req.headers.authorization?.split(" ")[1];

    if (!token) {
      return res.status(401).json({ message: "Access denied. No token provided." });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });

    // Re-check the account on every request so deactivated/deleted users and
    // role changes take effect immediately instead of when the JWT expires.
    const [user, revoked] = await Promise.all([
      Salesperson.findById(decoded.id).select("role status passwordChangedAt").lean(),
      decoded.jti ? RevokedToken.exists({ jti: decoded.jti }) : null,
    ]);
    if (revoked) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }
    if (!user || user.status !== "active") {
      return res.status(401).json({ message: "Invalid or expired token" });
    }
    // A password change/reset invalidates every token issued before it (1s slack for same-second issue)
    if (user.passwordChangedAt && decoded.iat * 1000 < new Date(user.passwordChangedAt).getTime() - 1000) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }

    req.user = { id: String(user._id), role: user.role };
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

module.exports = { verifyToken };
