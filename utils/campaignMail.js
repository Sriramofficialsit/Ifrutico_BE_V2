// Email templates for campaigns: coupon offer, event invitation, poster.
// Table layout + inline styles so they render in Gmail, Outlook and phone mail apps.
const { offerText } = require("./coupon");

const { P, esc, eyebrow, heading, paragraphs, button, infoPanel, layout } = require("./mailLayout");

const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "there";
// {name} in the subject / heading / message becomes the customer's first name
const personalise = (text, name) => String(text || "").replace(/\{name\}/gi, firstName(name));

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "");
const fmtShort = (d) => (d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "");

const image = (src, alt) =>
  src ? `<img src="${esc(src)}" alt="${esc(alt)}" width="536" style="display:block;width:100%;max-width:536px;height:auto;border-radius:12px;border:1px solid ${P.line};">` : "";

const greeting = (name) => `<p style="margin:0 0 14px;font-size:15px;color:${P.ink};">Hi ${esc(firstName(name))},</p>`;

// ── Template bodies ─────────────────────────────────────────

const couponBody = ({ campaign, coupon, name }) => {
  const conditions = [
    coupon?.minBill > 0 ? `Min. bill ₹${coupon.minBill}` : null,
    coupon?.validTo ? `Valid till ${fmtShort(coupon.validTo)}` : null,
    coupon?.perCustomerLimit === 1 ? "One use per customer" : null,
  ].filter(Boolean);
  return `
  <tr><td class="px" align="center" style="padding:36px 40px 4px;">
    ${eyebrow("A gift for you")}
    ${heading(personalise(campaign.heading || "A sweet treat, just for you", name))}
  </td></tr>
  <tr><td class="px" style="padding:24px 40px 4px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${P.tint};border:1px solid ${P.line};border-radius:14px;">
      <tr>
        <td class="stack" style="padding:22px 22px;vertical-align:middle;">
          <div style="font-size:12px;color:${P.faint};">Your offer</div>
          <div style="font-size:26px;font-weight:800;color:${P.accent};line-height:1.2;margin-top:2px;">${esc(coupon ? offerText(coupon) : "Special offer")}</div>
          ${coupon?.description ? `<div style="font-size:13px;color:${P.soft};margin-top:4px;">${esc(coupon.description)}</div>` : ""}
        </td>
        <td class="stack" align="center" style="padding:22px 22px;vertical-align:middle;border-left:1px dashed #cbd8d0;width:190px;">
          <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${P.faint};">Use code</div>
          <div style="margin-top:6px;display:inline-block;padding:10px 16px;background:#ffffff;border:1px dashed ${P.accent};border-radius:10px;
            font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:20px;font-weight:700;letter-spacing:3px;color:${P.ink};">${esc(coupon?.code || "CODE")}</div>
        </td>
      </tr>
    </table>
    ${conditions.length ? `<div style="margin-top:10px;text-align:center;font-size:12px;color:${P.faint};">${conditions.map(esc).join(" &nbsp;·&nbsp; ")}</div>` : ""}
  </td></tr>
  <tr><td class="px" style="padding:26px 40px 34px;">
    ${greeting(name)}${paragraphs(personalise(campaign.message, name))}
    <p style="margin:0;font-size:13px;color:${P.faint};">Just show this email or tell the code at billing.</p>
    ${button(campaign.ctaText, campaign.ctaUrl)}
  </td></tr>`;
};

const eventBody = ({ campaign, name, imageSrc }) => {
  const rows = [
    campaign.eventDate ? ["Date", esc(fmtDate(campaign.eventDate))] : null,
    campaign.eventTime ? ["Time", esc(campaign.eventTime)] : null,
    campaign.venue ? ["Venue", esc(campaign.venue)] : null,
  ].filter(Boolean);
  return `
  ${imageSrc ? `<tr><td class="px" style="padding:28px 32px 0;">${image(imageSrc, campaign.heading || "Event")}</td></tr>` : ""}
  <tr><td class="px" align="center" style="padding:32px 40px 4px;">
    ${eyebrow("You're invited")}
    ${heading(personalise(campaign.heading || "Join us for a special day", name))}
  </td></tr>
  ${rows.length ? `<tr><td class="px" style="padding:22px 40px 0;">${infoPanel(rows)}</td></tr>` : ""}
  <tr><td class="px" style="padding:24px 40px 34px;">
    ${greeting(name)}${paragraphs(personalise(campaign.message, name))}
    ${button(campaign.ctaText, campaign.ctaUrl)}
  </td></tr>`;
};

const posterBody = ({ campaign, name, imageSrc }) => {
  const h = personalise(campaign.heading, name);
  return `
  <tr><td class="px" style="padding:28px 32px 0;">${imageSrc
    ? image(imageSrc, h || campaign.subject)
    : `<div style="padding:70px 20px;text-align:center;background:${P.warm};border:1px dashed ${P.line};border-radius:12px;color:${P.faint};font-size:14px;">Upload a poster image</div>`}</td></tr>
  ${h ? `<tr><td class="px" align="center" style="padding:28px 40px 0;">${heading(h, 24)}</td></tr>` : ""}
  <tr><td class="px" align="center" style="padding:18px 40px 34px;">
    ${paragraphs(personalise(campaign.message, name), "center")}
    ${button(campaign.ctaText, campaign.ctaUrl)}
  </td></tr>`;
};

const BODIES = { coupon: couponBody, event: eventBody, poster: posterBody };

// Full email. imageSrc/logoSrc are "cid:..." when sending and plain URLs in the dashboard preview.
const buildCampaignEmail = ({ campaign, coupon, customerName, brand = {}, imageSrc, logoSrc, unsubscribeUrl }) => {
  const shop = brand.shopName || "Ifrutico";
  const subject = personalise(campaign.subject, customerName);
  const preheader = personalise(campaign.preheader || "", customerName);
  const body = (BODIES[campaign.template] || posterBody)({ campaign, coupon, name: customerName, imageSrc });

  const html = layout({
    title: subject,
    preheader,
    body,
    brand,
    logoSrc,
    footerNote: `You're receiving this because you've shopped with ${esc(shop)}.`,
    unsubscribeUrl: unsubscribeUrl || "#",
  });

  // Plain-text part for clients that don't render HTML (and better spam scores)
  const text = [
    `Hi ${firstName(customerName)},`,
    "",
    personalise(campaign.heading, customerName),
    campaign.template === "coupon" && coupon ? `${offerText(coupon)} — use code ${coupon.code} at billing.` : "",
    campaign.template === "event" ? [campaign.eventDate && `Date: ${fmtDate(campaign.eventDate)}`, campaign.eventTime && `Time: ${campaign.eventTime}`, campaign.venue && `Venue: ${campaign.venue}`].filter(Boolean).join("\n") : "",
    "",
    personalise(campaign.message, customerName),
    campaign.ctaText && campaign.ctaUrl ? `\n${campaign.ctaText}: ${campaign.ctaUrl}` : "",
    "",
    `— ${shop}`,
    unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : "",
  ].join("\n").replace(/\n{3,}/g, "\n\n");

  return { subject, html, text };
};

module.exports = { buildCampaignEmail, personalise };
