// Shared look for every email Ifrutico sends (invoice, login / reset codes, campaigns):
// warm white page, white card with a hairline border, muted sage accent, no dark banners.
// Table layout + inline styles so it renders the same in Gmail, Outlook and phone mail apps.
const path = require("path");
const fs = require("fs");

const P = {
  page: "#f5f4f0",
  card: "#ffffff",
  line: "#e9e6df",
  ink: "#2e3633",
  soft: "#6b7570",
  faint: "#9ba49f",
  accent: "#3f7a63",
  tint: "#f1f5f2",
  warm: "#faf8f3",
};
const FONT = "'Inter','Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const LOGO_PATH = path.join(__dirname, "..", "assets", "logo.png");
const LOGO_CID = "logo@ifrutico";
const hasLogo = () => fs.existsSync(LOGO_PATH);
// Attach to any sendMail that uses logoSrc "cid:logo@ifrutico"
const logoAttachment = () => (hasLogo() ? [{ filename: "logo.png", path: LOGO_PATH, cid: LOGO_CID }] : []);

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Small uppercase label
const eyebrow = (text, color = P.accent) =>
  `<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700;color:${color};">${esc(text)}</div>`;

const heading = (text, size = 26) =>
  `<h1 style="margin:8px 0 0;font-size:${size}px;line-height:1.25;font-weight:700;color:${P.ink};letter-spacing:-0.3px;">${esc(text)}</h1>`;

// Plain text → paragraphs (blank line = new paragraph)
const paragraphs = (text, align = "left") =>
  esc(text)
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.7;color:${P.soft};text-align:${align};">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");

// Soft pill button (outlined look in sage)
const button = (text, url) =>
  text && url
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px auto 4px;"><tr>
        <td align="center" style="border-radius:10px;background:${P.accent};">
          <a href="${esc(url)}" style="display:inline-block;padding:13px 28px;font-family:${FONT};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;letter-spacing:.2px;">${esc(text)}</a>
        </td></tr></table>`
    : "";

// Two-column key/value rows inside a tinted panel
const infoPanel = (rows) =>
  rows.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${P.warm};border:1px solid ${P.line};border-radius:12px;">
        ${rows.map(([k, v], i) => `<tr>
          <td style="padding:13px 18px;${i ? `border-top:1px solid ${P.line};` : ""}width:110px;font-size:12px;color:${P.faint};vertical-align:top;">${esc(k)}</td>
          <td style="padding:13px 18px 13px 0;${i ? `border-top:1px solid ${P.line};` : ""}font-size:14px;font-weight:600;color:${P.ink};">${v}</td>
        </tr>`).join("")}
      </table>`
    : "";

/**
 * Full email document.
 * body: HTML rows (<tr>…</tr>) placed inside the card
 * brand: { shopName, address, phoneNumber, gstNumber }
 */
const layout = ({ title, preheader = "", body, brand = {}, logoSrc, footerNote = "", unsubscribeUrl }) => {
  const shop = brand.shopName || "Ifrutico";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${esc(title)}</title>
<style>
  body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
  table,td{mso-table-lspace:0;mso-table-rspace:0} img{border:0;outline:none;text-decoration:none}
  @media only screen and (max-width:620px){
    .wrap{padding:12px 8px !important} .card{border-radius:12px !important}
    .px{padding-left:22px !important;padding-right:22px !important}
    .stack{display:block !important;width:100% !important;padding:0 0 10px 0 !important}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${P.page};font-family:${FONT};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${P.page};">
    <tr><td align="center" class="wrap" style="padding:32px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" class="card"
        style="width:100%;max-width:600px;background:${P.card};border:1px solid ${P.line};border-radius:16px;overflow:hidden;">
        <tr><td style="height:4px;background:${P.accent};opacity:.85;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td align="center" style="padding:26px 32px 22px;border-bottom:1px solid ${P.line};">
          ${logoSrc
            ? `<img src="${esc(logoSrc)}" alt="${esc(shop)}" height="40" style="height:40px;width:auto;">`
            : `<span style="font-size:20px;font-weight:800;letter-spacing:1px;color:${P.accent};">${esc(shop.toUpperCase())}</span>`}
        </td></tr>
        ${body}
        <tr><td class="px" align="center" style="padding:26px 40px 28px;background:${P.warm};border-top:1px solid ${P.line};">
          <div style="font-size:13px;font-weight:600;color:${P.ink};">${esc(shop)}</div>
          <div style="font-size:12px;line-height:1.7;color:${P.faint};margin-top:4px;">
            ${[brand.address, brand.phoneNumber ? `+91 ${brand.phoneNumber}` : "", brand.gstNumber ? `GSTIN ${brand.gstNumber}` : ""].filter(Boolean).map(esc).join(" &nbsp;·&nbsp; ")}
          </div>
          <div style="font-size:12px;margin-top:8px;"><a href="https://ifrutico.com" style="color:${P.accent};text-decoration:none;">ifrutico.com</a></div>
          ${footerNote ? `<div style="font-size:11px;line-height:1.6;color:${P.faint};margin-top:12px;">${footerNote}</div>` : ""}
          ${unsubscribeUrl ? `<div style="font-size:11px;margin-top:8px;"><a href="${esc(unsubscribeUrl)}" style="color:${P.faint};text-decoration:underline;">Unsubscribe from offers</a></div>` : ""}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
};

// 6-digit code email (login verification / password reset)
const codeEmail = ({ title, intro, code, minutes, note, brand = {}, logoSrc }) =>
  layout({
    title,
    preheader: `${code} is your code. It expires in ${minutes} minutes.`,
    brand,
    logoSrc,
    footerNote: "This is an automated message. Please do not reply.",
    body: `
      <tr><td class="px" align="center" style="padding:36px 40px 8px;">
        ${eyebrow("Security code")}
        ${heading(title, 24)}
        <p style="margin:12px 0 0;font-size:15px;line-height:1.7;color:${P.soft};">${esc(intro)}</p>
      </td></tr>
      <tr><td class="px" align="center" style="padding:22px 40px 6px;">
        <div style="display:inline-block;padding:16px 26px;background:${P.tint};border:1px solid ${P.line};border-radius:14px;
          font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:10px;color:${P.ink};">${esc(code)}</div>
        <div style="margin-top:12px;font-size:13px;color:${P.faint};">Expires in ${minutes} minutes</div>
      </td></tr>
      <tr><td class="px" style="padding:22px 40px 34px;">
        <div style="padding:14px 16px;background:${P.warm};border:1px solid ${P.line};border-radius:10px;font-size:13px;line-height:1.6;color:${P.soft};">${esc(note)}</div>
      </td></tr>`,
  });

module.exports = { P, FONT, esc, eyebrow, heading, paragraphs, button, infoPanel, layout, codeEmail, logoAttachment, hasLogo, LOGO_CID };
