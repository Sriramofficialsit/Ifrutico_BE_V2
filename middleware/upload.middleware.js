const multer = require("multer");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Extension is derived from the validated mimetype, never from the client filename
const EXT_BY_MIME = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };

const makeUploader = ({ dir, prefix = () => "", maxSize, mimes }) => {
  fs.mkdirSync(dir, { recursive: true });
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, dir),
      filename: (req, file, cb) =>
        cb(null, `${prefix(req)}${Date.now()}-${crypto.randomBytes(6).toString("hex")}${EXT_BY_MIME[file.mimetype]}`),
    }),
    fileFilter: (req, file, cb) =>
      mimes.includes(file.mimetype) ? cb(null, true) : cb(new Error("Only JPG, PNG or WebP images are allowed")),
    limits: { fileSize: maxSize, files: 5 },
  });
};

const productUpload = makeUploader({
  dir: path.join(__dirname, "..", "uploads", "products"),
  maxSize: 8 * 1024 * 1024,
  mimes: ["image/jpeg", "image/png"],
});

module.exports = productUpload;
