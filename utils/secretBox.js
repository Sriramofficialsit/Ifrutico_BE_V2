const crypto = require("crypto");

// AES-256-GCM for secrets stored in the database (e.g. third-party API keys). Key is derived from DATA_ENC_KEY,
// falling back to JWT_SECRET, so a database leak alone does not expose them.
const key = () => crypto.createHash("sha256").update(`secretbox:${process.env.DATA_ENC_KEY || process.env.JWT_SECRET}`).digest();

const seal = (plain) => {
  if (!plain || String(plain).startsWith("enc:v1:")) return plain; // empty or already sealed
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return `enc:v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
};

const open = (sealed) => {
  if (!sealed || !String(sealed).startsWith("enc:v1:")) return sealed;
  const [, , iv, tag, ct] = String(sealed).split(":");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
};

module.exports = { seal, open };
