const mail = require("./mailLayout");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const transporter = require("./mailer");

// ---------- shared helpers ----------
const escapeHtml = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Names go into the From header: strip anything that could break out of it
const headerSafe = (v) => String(v ?? "").replace(/[\r\n"<>]/g, "").trim().slice(0, 60);

const money = (n) =>
  `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;


// Small units are shown in their larger unit so rates read per litre / per kg: 500 g -> 0.5 kg
const BIG_UNIT = { g: "kg", ml: "ltr" };
const fmtNum = (n) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))));

// "16 ltr × ₹255.00/ltr", "2 × ₹50.00" — quantity and per-unit rate, independent of the pack size the price was set for
// Events: "3 boxes of 2 L · ₹450.00 each"; Stalls: "4 scoops of 75 g · ₹40.00 each"
const lineText = (item) => {
  const each = (n) => money((Number(item.total) || 0) / n);
  if (item.boxes > 0) return `${fmtNum(item.boxes)} box${item.boxes === 1 ? "" : "es"} of ${fmtNum(item.boxSize)} L · ${each(item.boxes)} each`;
  if (item.scoops > 0) return `${fmtNum(item.scoops)} scoop${item.scoops === 1 ? "" : "s"} of ${fmtNum(item.scoopGrams)} g · ${each(item.scoops)} each`;
  let unit = item.unit || "pcs";
  let qty = Number(item.quantity) || 0;
  let rate = (Number(item.price) || 0) / (Number(item.priceQty) || 1);
  if (BIG_UNIT[unit]) { qty /= 1000; rate *= 1000; unit = BIG_UNIT[unit]; }
  return unit === "pcs" ? `${fmtNum(qty)} × ${money(rate)}` : `${fmtNum(qty)} ${unit} × ${money(rate)}/${unit}`;
};

const formatDate = (d) =>
  new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
const formatTime = (d) => new Date(d).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

// Discount line label: "Discount (10%)" or "Discount"; null when the bill has none
const discountLabel = (bill) =>
  Number(bill.discountAmount) > 0
    ? bill.couponCode ? `Coupon ${bill.couponCode}` : bill.discountType === "percent" ? `Discount (${fmtNum(Number(bill.discountValue))}%)` : "Discount"
    : null;
// "10% off" / "Discount" for a line discount; null when the line has none
const lineDiscLabel = (p) =>
  Number(p.discountAmount) > 0 ? (p.discountType === "percent" ? `${fmtNum(Number(p.discountValue))}% off` : "Discount") : null;
const lineDiscText = (p) => (lineDiscLabel(p) ? `${lineDiscLabel(p)} -${money(p.discountAmount)}` : "");
const itemDisc = (bill) => Number(bill.itemDiscountAmount) || 0;
// Total saved: line discounts + bill discount / coupon
const totalSaved = (bill) => Number((itemDisc(bill) + (Number(bill.discountAmount) || 0)).toFixed(2));
// Items' value as priced, before the discount (bills created before discounts have no discountAmount)
const itemsTotal = (bill) => (bill.products || []).reduce((s, p) => s + (Number(p.total) || 0), 0);

const payLabel = (m) => ({ upi: "UPI", card: "Card", cash: "Cash" }[String(m || "cash").toLowerCase()] || "Cash");

// Amount in words, Indian numbering (lakh / crore)
const ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const below100 = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? " " + ONES[n % 10] : ""}`);
const below1000 = (n) => (n >= 100 ? `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? " " + below100(n % 100) : ""}` : below100(n));
const wordsInt = (n) => {
  if (n === 0) return "zero";
  const parts = [];
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  if (crore) parts.push(`${below1000(crore)} crore`);
  if (lakh) parts.push(`${below100(lakh)} lakh`);
  if (thousand) parts.push(`${below100(thousand)} thousand`);
  if (n) parts.push(below1000(n));
  return parts.join(" ");
};
const amountInWords = (amount) => {
  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  return `${cap(wordsInt(rupees))} rupees${paise ? ` and ${wordsInt(paise)} paise` : ""} only`;
};

const brandOf = (settings) => ({
  name: settings?.shopName || "Ifrutico",
  address: settings?.address || "1/173 Vadugar Street, Karikali, Musiri, TN",
  phone: settings?.phoneNumber || "",
  gst: settings?.gstNumber || "",
  site: "ifrutico.com",
  tagline: "Pure fruit ice cream",
});

// Ifrutico palette (matches the dashboard design system)
// Brand palette from the Frutico logo (forest green + leaf lime), softened for print
const C = {
  forest: "#17704a", leaf: "#8db552", ink: "#2b3431", soft: "#6b7570", faint: "#9aa39f",
  line: "#e6e9e3", tint: "#f2f7f1", leafTint: "#f6f9ee", zebra: "#fafbf8", white: "#ffffff",
};
const LOGO_FILE = path.join(__dirname, "..", "assets", "logo.png");
const BILL_TYPE = { event: "Events & Functions", stall: "Stall" };

// Separate Qty / Rate / note for the item table: "0.75 kg" · "₹200.00 /kg", "3 × 1 L" · "₹320.00 /box", "4 scoops" · "₹40.00 /scoop"
const qtyRate = (item) => {
  const total = Number(item.total) || 0;
  if (item.boxes > 0) return { qty: `${fmtNum(item.boxes)} × ${fmtNum(item.boxSize)} L`, rate: `${money(total / item.boxes)} /box`, note: `${fmtNum(item.boxes)} box${item.boxes === 1 ? "" : "es"} of ${fmtNum(item.boxSize)} L` };
  if (item.scoops > 0) return { qty: `${fmtNum(item.scoops)} scoop${item.scoops === 1 ? "" : "s"}`, rate: `${money(total / item.scoops)} /scoop`, note: `${fmtNum(item.scoopGrams)} g per scoop` };
  let unit = item.unit || "pcs";
  let qty = Number(item.quantity) || 0;
  let rate = (Number(item.price) || 0) / (Number(item.priceQty) || 1);
  if (BIG_UNIT[unit]) { qty /= 1000; rate *= 1000; unit = BIG_UNIT[unit]; }
  return { qty: unit === "pcs" ? fmtNum(qty) : `${fmtNum(qty)} ${unit}`, rate: unit === "pcs" ? money(rate) : `${money(rate)} /${unit}`, note: "" };
};

// ---------- PDF ----------
const FONTS = path.join(__dirname, "..", "assets", "fonts");

/**
 * Builds the invoice PDF and resolves with its Buffer.
 * Single source of truth: used for the emailed attachment AND the "Download PDF" on the bills page.
 * Multi-page safe: long bills continue on further pages with a repeated table header and page numbers.
 */
const buildInvoicePdf = (billData, settings) =>
  new Promise((resolve, reject) => {
    try {
      const brand = brandOf(settings);
      const doc = new PDFDocument({ size: "A4", margins: { top: 0, left: 40, right: 40, bottom: 0 }, bufferPages: true,
        info: { Title: `Invoice ${billData.invoiceNumber}`, Author: brand.name } });
      doc.registerFont("Inter", path.join(FONTS, "Inter_400Regular.ttf"));
      doc.registerFont("Inter-SemiBold", path.join(FONTS, "Inter_600SemiBold.ttf"));
      doc.registerFont("Inter-Bold", path.join(FONTS, "Inter_700Bold.ttf"));

      const buffers = [];
      doc.on("data", (b) => buffers.push(b));
      doc.on("end", () => resolve(Buffer.concat(buffers)));
      doc.on("error", reject);

      const W = 595.28, H = 841.89, L = 40, R = W - 40, CW = R - L;
      const BOTTOM = H - 92; // keep clear of the footer
      const text = (str, x, y, o = {}) => doc.text(String(str ?? ""), x, y, { lineBreak: false, ...o });
      const font = (name, size, color) => doc.font(name).fontSize(size).fillColor(color);
      const label = (str, x, y, o = {}) => { font("Inter-SemiBold", 7.5, C.faint); text(String(str).toUpperCase(), x, y, { characterSpacing: 1.1, ...o }); };
      const hasLogo = fs.existsSync(LOGO_FILE);

      // Two-tone brand strip across the top of every page
      const strip = () => {
        doc.rect(0, 0, W * 0.72, 5).fill(C.forest);
        doc.rect(W * 0.72, 0, W * 0.28, 5).fill(C.leaf);
      };
      const drawLogo = (x, y, h) => {
        if (hasLogo) doc.image(LOGO_FILE, x, y, { height: h }); // 418×178 source, keeps its aspect ratio
        else { font("Inter-Bold", h * 0.5, C.forest); text(brand.name, x, y + h * 0.2); }
      };

      // ---- page 1 header ----
      const drawHeader = () => {
        strip();
        drawLogo(L - 6, 26, 58);
        font("Inter-Bold", 20, C.ink); text("Tax Invoice", 300, 32, { width: R - 300, align: "right" });
        font("Inter", 9.5, C.soft); text(billData.invoiceNumber, 300, 58, { width: R - 300, align: "right" });
        font("Inter", 9, C.faint); text(`${formatDate(billData.createdAt)}  ·  ${formatTime(billData.createdAt)}`, 300, 73, { width: R - 300, align: "right" });
        doc.moveTo(L, 104).lineTo(R, 104).lineWidth(0.6).strokeColor(C.line).stroke();
      };
      const drawContinuationHeader = () => {
        strip();
        drawLogo(L - 4, 18, 34);
        font("Inter", 9, C.soft); text(`Invoice ${billData.invoiceNumber}  ·  continued`, 300, 30, { width: R - 300, align: "right" });
        doc.moveTo(L, 62).lineTo(R, 62).lineWidth(0.6).strokeColor(C.line).stroke();
      };

      drawHeader();

      // ---- info cards: billed to / from / details ----
      let y = 122;
      const gap = 12;
      const cardW = (CW - 2 * gap) / 3;
      const card = (title, lines, x, h) => {
        doc.roundedRect(x, y, cardW, h, 8).fill(C.zebra);
        doc.roundedRect(x, y, cardW, h, 8).lineWidth(0.6).strokeColor(C.line).stroke();
        label(title, x + 14, y + 13);
        let yy = y + 29;
        lines.filter(Boolean).forEach(([v, strong], i) => {
          if (strong || i === 0) { font("Inter-Bold", 10.5, C.ink); text(v, x + 14, yy, { width: cardW - 28, ellipsis: true }); yy += 16; }
          else { font("Inter", 8.5, C.soft); const hh = doc.heightOfString(v, { width: cardW - 28 }); doc.text(v, x + 14, yy, { width: cardW - 28 }); yy += hh + 2.5; }
        });
        return yy;
      };
      const details = [
        ["Paid", true],
        [`Payment: ${payLabel(billData.paymentMethod)}`],
        BILL_TYPE[billData.billType] ? [`Bill type: ${BILL_TYPE[billData.billType]}`] : null,
        billData.couponCode ? [`Coupon: ${billData.couponCode}`] : null,
      ];
      const cardH = 96;
      card("Billed to", [
        [billData.customerName],
        billData.mobileNumber ? [`+91 ${billData.mobileNumber}`] : null,
        billData.customerEmail ? [billData.customerEmail] : null,
        billData.customerGstNumber ? [`GSTIN: ${billData.customerGstNumber}`] : null,
      ], L, cardH);
      card("From", [
        [brand.name],
        [brand.address],
        brand.phone ? [`+91 ${brand.phone}`] : null,
        brand.gst ? [`GSTIN: ${brand.gst}`] : null,
      ], L + cardW + gap, cardH);
      card("Payment", details, L + 2 * (cardW + gap), cardH);
      // "Paid" status dot inside the payment card
      doc.circle(L + 2 * (cardW + gap) + cardW - 20, y + 16, 3.5).fill(C.leaf);
      y += cardH + 24;

      // ---- items table ----
      const X = { idx: L + 12, item: L + 36, qty: L + 270, rate: L + 350, amt: R - 12 };
      const NAME_W = 222;
      const drawTableHead = () => {
        doc.roundedRect(L, y, CW, 26, 6).fill(C.tint);
        font("Inter-SemiBold", 7.5, C.forest);
        text("#", X.idx, y + 9.5, { characterSpacing: 1 });
        text("ITEM", X.item, y + 9.5, { characterSpacing: 1 });
        text("QTY", X.qty, y + 9.5, { width: 70, align: "center", characterSpacing: 1 });
        text("RATE", X.rate, y + 9.5, { width: 90, align: "right", characterSpacing: 1 });
        text("AMOUNT", X.amt - 80, y + 9.5, { width: 80, align: "right", characterSpacing: 1 });
        y += 30;
      };
      const newPage = () => { doc.addPage(); drawContinuationHeader(); y = 80; };
      drawTableHead();

      billData.products.forEach((item, i) => {
        const qr = qtyRate(item);
        const sub = [qr.note, item.gstIncluded ? "incl. GST" : "", lineDiscText(item)].filter(Boolean).join("  ·  ");
        font("Inter-SemiBold", 10, C.ink);
        const nameH = doc.heightOfString(item.itemName, { width: NAME_W });
        const rowH = Math.max(30, nameH + (sub ? 24 : 14));
        if (y + rowH > BOTTOM) { newPage(); drawTableHead(); }
        if (i % 2 === 1) doc.rect(L, y - 2, CW, rowH).fill(C.zebra);
        font("Inter", 8.5, C.faint); text(String(i + 1).padStart(2, "0"), X.idx, y + 6);
        font("Inter-SemiBold", 10, C.ink); doc.text(item.itemName, X.item, y + 5, { width: NAME_W, lineBreak: true });
        if (sub) { font("Inter", 8, C.faint); text(sub, X.item, y + 7 + nameH, { width: NAME_W }); }
        font("Inter", 9.5, C.ink); text(qr.qty, X.qty, y + 6, { width: 70, align: "center" });
        font("Inter", 9.5, C.soft); text(qr.rate, X.rate - 10, y + 6, { width: 100, align: "right" });
        font("Inter-Bold", 10, C.ink); text(money(item.total), X.amt - 80, y + 6, { width: 80, align: "right" });
        y += rowH;
        doc.moveTo(L, y - 2).lineTo(R, y - 2).lineWidth(0.4).strokeColor(C.line).stroke();
      });

      // ---- totals (right) + words / GST summary (left) ----
      const discLabel = discountLabel(billData);
      const anyDisc = totalSaved(billData) > 0;
      if (y + (anyDisc ? 270 : 220) > BOTTOM) newPage();
      y += 18;
      const top = y;
      const tx = R - 236;
      const row = (k, v, color = C.ink) => {
        font("Inter", 9.5, C.soft); text(k, tx, y);
        font("Inter-SemiBold", 9.5, color); text(v, tx + 100, y, { width: 136, align: "right" });
        y += 19;
      };
      const gst = Number(billData.gstAmount) || 0;
      const cgst = Number((gst / 2).toFixed(2));
      const sgst = Number((gst - cgst).toFixed(2));
      if (anyDisc) row("Items total", money(itemsTotal(billData)));
      if (itemDisc(billData) > 0) row("Item discounts", `- ${money(itemDisc(billData))}`, C.forest);
      if (discLabel) row(discLabel, `- ${money(billData.discountAmount)}`, C.forest);
      row(anyDisc ? "Taxable value" : "Subtotal", money(billData.subTotal));
      row("CGST @ 2.5%", money(cgst));
      row("SGST @ 2.5%", money(sgst));
      y += 4;
      doc.roundedRect(tx - 14, y, 250, 48, 8).fill(C.tint);
      doc.rect(tx - 14, y, 4, 48).fill(C.forest);
      font("Inter-SemiBold", 8.5, C.forest); text("GRAND TOTAL", tx + 2, y + 19, { characterSpacing: 1.2 });
      font("Inter-Bold", 18, C.ink); text(money(billData.totalAmount), tx + 70, y + 14, { width: 152, align: "right" });
      y += 48;
      const totalsBottom = y;

      // left column
      let ly = top;
      const LW = tx - L - 34;
      label("Amount in words", L, ly);
      font("Inter", 9.5, C.ink); doc.text(amountInWords(Number(billData.totalAmount) || 0), L, ly + 14, { width: LW });
      ly += 14 + doc.heightOfString(amountInWords(Number(billData.totalAmount) || 0), { width: LW }) + 16;

      label("GST summary", L, ly);
      ly += 14;
      const gx = [L, L + 70, L + 150, L + 210];
      font("Inter-SemiBold", 8, C.soft);
      ["Rate", "Taxable", "CGST", "SGST"].forEach((h, i) => text(h, gx[i], ly, i ? { width: 56, align: "right" } : {}));
      ly += 13;
      doc.moveTo(L, ly - 3).lineTo(L + 266, ly - 3).lineWidth(0.4).strokeColor(C.line).stroke();
      font("Inter", 8.5, C.ink);
      ["5%", money(billData.subTotal), money(cgst), money(sgst)].forEach((v, i) => text(v, gx[i], ly + 1, i ? { width: 56, align: "right" } : {}));
      ly += 20;

      if (anyDisc) {
        doc.roundedRect(L, ly, Math.min(LW, 266), 30, 6).fill(C.leafTint);
        doc.roundedRect(L, ly, Math.min(LW, 266), 30, 6).dash(2.5, { space: 2 }).lineWidth(0.7).strokeColor(C.leaf).stroke().undash();
        font("Inter-SemiBold", 9.5, C.forest); text(`You saved ${money(totalSaved(billData))} on this bill`, L, ly + 10, { width: Math.min(LW, 266), align: "center" });
        ly += 30;
      }

      // ---- thank-you note ----
      y = Math.max(totalsBottom, ly) + 30;
      if (y + 64 > BOTTOM) newPage();
      doc.roundedRect(L, y, CW, 60, 8).fill(C.leafTint);
      doc.rect(L, y, 4, 60).fill(C.leaf);
      font("Inter-Bold", 12, C.forest); text(`Thank you for choosing ${brand.name}!`, L + 20, y + 15);
      font("Inter", 9, C.soft); text("Made fresh with real fruit. We hope you loved every scoop. See you again soon.", L + 20, y + 34);
      font("Inter-SemiBold", 9, C.forest); text(brand.site, R - 120, y + 24, { width: 104, align: "right" });

      // ---- footer + page numbers on every page ----
      const range = doc.bufferedPageRange();
      for (let p = range.start; p < range.start + range.count; p++) {
        doc.switchToPage(p);
        doc.moveTo(L, H - 64).lineTo(R, H - 64).lineWidth(0.5).strokeColor(C.line).stroke();
        font("Inter", 8, C.soft);
        text([brand.address, brand.phone ? `+91 ${brand.phone}` : "", brand.gst ? `GSTIN ${brand.gst}` : ""].filter(Boolean).join("   ·   "), L, H - 53, { width: CW, align: "center" });
        font("Inter", 7.5, C.faint);
        text("This is a computer-generated invoice and needs no signature.", L, H - 39, { width: CW, align: "center" });
        if (range.count > 1) text(`Page ${p - range.start + 1} of ${range.count}`, L, H - 26, { width: CW, align: "center" });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });

// ---------- Email ----------
const buildInvoiceEmail = (bill, settings) => {
  const brand = brandOf(settings);
  const discLabel = discountLabel(bill);
  const anyDisc = totalSaved(bill) > 0;
  const gst = Number(bill.gstAmount) || 0;
  const cgst = Number((gst / 2).toFixed(2));
  const sgst = Number((gst - cgst).toFixed(2));
  const M = mail.P;

  const rows = bill.products.map((p) => `
    <tr>
      <td style="padding:14px 0;border-bottom:1px solid ${M.line};">
        <div style="font-size:14px;font-weight:600;color:${M.ink};line-height:1.4;">${escapeHtml(p.itemName)}</div>
        <div style="font-size:12px;color:${M.faint};margin-top:3px;">${escapeHtml(lineText(p))}${p.gstIncluded ? " &middot; incl. GST" : ""}</div>
        ${lineDiscLabel(p) ? `<div style="font-size:12px;color:${M.accent};margin-top:2px;">${escapeHtml(lineDiscLabel(p))} &minus; ${money(p.discountAmount)}</div>` : ""}
      </td>
      <td align="right" valign="top" style="padding:14px 0;border-bottom:1px solid ${M.line};font-size:14px;font-weight:600;color:${M.ink};white-space:nowrap;">${money(p.total)}</td>
    </tr>`).join("");

  const sum = (label, value, color = M.ink) => `<tr>
    <td style="padding:5px 0;font-size:13px;color:${M.soft};">${label}</td>
    <td align="right" style="padding:5px 0;font-size:13px;font-weight:600;color:${color};">${value}</td></tr>`;

  const fact = (label, value) => `
    <td class="stack" valign="top" style="padding:0 10px 0 0;">
      <div style="font-size:11px;color:${M.faint};">${label}</div>
      <div style="font-size:13px;font-weight:600;color:${M.ink};margin-top:3px;">${value}</div>
    </td>`;

  const body = `
    <tr><td class="px" style="padding:34px 40px 6px;">
      ${mail.eyebrow("Tax invoice")}
      ${mail.heading(`Thank you, ${bill.customerName}`, 24)}
      <p style="margin:10px 0 0;font-size:15px;line-height:1.7;color:${M.soft};">Here is the receipt for your visit. A PDF copy is attached for your records.</p>
    </td></tr>

    <tr><td class="px" style="padding:22px 40px 4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${M.warm};border:1px solid ${M.line};border-radius:14px;">
        <tr><td style="padding:20px 22px 6px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td valign="middle">
              <div style="font-size:12px;color:${M.faint};">Total paid</div>
              <div style="font-size:32px;font-weight:800;letter-spacing:-0.5px;color:${M.ink};line-height:1.2;margin-top:2px;">${money(bill.totalAmount)}</div>
            </td>
            <td valign="middle" align="right">
              <span style="display:inline-block;background:${M.tint};border:1px solid #d5e3da;color:${M.accent};font-size:11px;font-weight:700;letter-spacing:1.5px;padding:6px 12px;border-radius:999px;">PAID</span>
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:12px 22px 20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            ${fact("Invoice no.", escapeHtml(bill.invoiceNumber))}
            ${fact("Date", `${escapeHtml(formatDate(bill.createdAt))}, ${escapeHtml(formatTime(bill.createdAt))}`)}
            ${fact("Payment", escapeHtml(payLabel(bill.paymentMethod)))}
          </tr></table>
        </td></tr>
      </table>
    </td></tr>

    <tr><td class="px" style="padding:26px 40px 0;">
      <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${M.faint};font-weight:700;padding-bottom:6px;border-bottom:1px solid ${M.line};">Your order</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;">
        ${anyDisc ? sum("Items total", money(itemsTotal(bill))) : ""}
        ${itemDisc(bill) > 0 ? sum("Item discounts", `&minus; ${money(itemDisc(bill))}`, M.accent) : ""}
        ${discLabel ? sum(escapeHtml(discLabel), `&minus; ${money(bill.discountAmount)}`, M.accent) : ""}
        ${sum(anyDisc ? "Taxable value" : "Subtotal", money(bill.subTotal))}
        ${sum("CGST @ 2.5%", money(cgst))}
        ${sum("SGST @ 2.5%", money(sgst))}
        <tr>
          <td style="padding:12px 0 0;border-top:1px solid ${M.line};font-size:15px;font-weight:700;color:${M.ink};">Total</td>
          <td align="right" style="padding:12px 0 0;border-top:1px solid ${M.line};font-size:17px;font-weight:800;color:${M.ink};">${money(bill.totalAmount)}</td>
        </tr>
      </table>
      <p style="margin:8px 0 0;font-size:12px;font-style:italic;color:${M.faint};">${escapeHtml(amountInWords(Number(bill.totalAmount) || 0))}</p>
      ${anyDisc ? `<div style="margin-top:16px;padding:11px 14px;border:1px dashed #b9cfc2;border-radius:10px;background:${M.tint};text-align:center;font-size:13px;font-weight:600;color:${M.accent};">You saved ${money(totalSaved(bill))} on this bill</div>` : ""}
      ${bill.customerGstNumber ? `<p style="margin:16px 0 0;font-size:13px;color:${M.soft};">Billed to GSTIN: <strong style="color:${M.ink};">${escapeHtml(bill.customerGstNumber)}</strong></p>` : ""}
    </td></tr>

    <tr><td class="px" align="center" style="padding:14px 40px 34px;">
      ${mail.button("Explore our flavours", `https://${brand.site}`)}
    </td></tr>`;

  const html = mail.layout({
    title: `Invoice ${bill.invoiceNumber}`,
    preheader: `Your invoice ${bill.invoiceNumber} for ${money(bill.totalAmount)}. Thank you for choosing ${brand.name}.`,
    body,
    brand: { shopName: brand.name, address: brand.address, phoneNumber: brand.phone, gstNumber: brand.gst },
    logoSrc: mail.hasLogo() ? `cid:${mail.LOGO_CID}` : null,
    footerNote: "This is an automated receipt. Please do not reply to this email.",
  });

  // Plain-text alternative: better deliverability and readable in text-only clients
  const plain = [
    `${brand.name} - Invoice ${bill.invoiceNumber}`,
    `Thank you, ${bill.customerName}!`,
    `Date: ${formatDate(bill.createdAt)} ${formatTime(bill.createdAt)}   Payment: ${payLabel(bill.paymentMethod)}`,
    "",
    ...bill.products.map((p) => `- ${p.itemName}  ${lineText(p)}${p.gstIncluded ? " (incl. GST)" : ""} = ${money(p.total)}${lineDiscLabel(p) ? ` (${lineDiscText(p)})` : ""}`),
    "",
    ...(totalSaved(bill) > 0 ? [`Items total: ${money(itemsTotal(bill))}`] : []),
    ...(itemDisc(bill) > 0 ? [`Item discounts: -${money(itemDisc(bill))}`] : []),
    ...(discountLabel(bill) ? [`${discountLabel(bill)}: -${money(bill.discountAmount)}`] : []),
    `${totalSaved(bill) > 0 ? "Taxable value" : "Subtotal"}: ${money(bill.subTotal)}`,
    `GST (5%): ${money(bill.gstAmount)}`,
    `TOTAL PAID: ${money(bill.totalAmount)}`,
    "",
    "A PDF copy of this invoice is attached.",
    `${brand.name}, ${brand.address}${brand.gst ? `, GSTIN ${brand.gst}` : ""} - ${brand.site}`,
  ].join("\n");

  return { html, plain, brand };
};

/**
 * Generate the invoice PDF and send the responsive HTML email with it attached
 */
const sendInvoiceEmail = async (billData, customerEmail, settings) => {
  const pdfData = await buildInvoicePdf(billData, settings);
  const { html, plain, brand } = buildInvoiceEmail(billData, settings);

  try {
    await transporter.sendMail({
      from: `"${headerSafe(brand.name) || "Ifrutico"}" <${process.env.MAIL_USER}>`,
      to: customerEmail,
      subject: `Your ${headerSafe(brand.name) || "Ifrutico"} invoice ${billData.invoiceNumber}`,
      text: plain,
      html,
      attachments: [
        { filename: `Invoice_${billData.invoiceNumber}.pdf`, content: pdfData, contentType: "application/pdf" },
        ...mail.logoAttachment(),
      ],
    });
    return true;
  } catch (err) {
    console.error("Email send error:", err);
    throw err;
  }
};

module.exports = { sendInvoiceEmail, buildInvoicePdf, buildInvoiceEmail };
