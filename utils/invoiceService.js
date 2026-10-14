const path = require("path");
const PDFDocument = require("pdfkit");
const transporter = require("./mailer");

// ---------- shared helpers ----------
const escapeHtml = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Names go into the From header: strip anything that could break out of it
const headerSafe = (v) => String(v ?? "").replace(/[\r\n"<>]/g, "").trim().slice(0, 60);

const money = (n) =>
  `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const qtyText = (item) => {
  const q = Number(item.quantity);
  const num = Number.isInteger(q) ? String(q) : String(Number(q.toFixed(3)));
  return item.unit && item.unit !== "pcs" ? `${num} ${item.unit}` : num;
};

// Rate column: "₹120.00" or, when priced per several units, "₹120.00 / 500 g"
const rateText = (item) => {
  const per = Number(item.priceQty) || 1;
  if (per === 1) return money(item.price);
  return `${money(item.price)} / ${qtyText({ quantity: per, unit: item.unit })}`;
};

const formatDate = (d) =>
  new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
const formatTime = (d) => new Date(d).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

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
const C = {
  house: "#1E3932", accent: "#00754A", green: "#006241", light: "#d4e9e2", mint: "#b3d7ca",
  canvas: "#f2f0eb", ink: "#1f2a26", soft: "#6b7671", line: "#e6e2da", white: "#ffffff",
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
      const text = (str, x, y, o = {}) => doc.text(String(str ?? ""), x, y, { lineBreak: false, ...o });
      const font = (name, size, color) => doc.font(name).fontSize(size).fillColor(color);

      // Ice-cream mark: scoop on a cone, on a white disc
      const logo = (cx, cy, r) => {
        doc.circle(cx, cy, r).fill(C.white);
        const s = r / 17;
        doc.save();
        // waffle cone (wide triangle, lighter green) ...
        doc.polygon([cx - 6.5 * s, cy - 0.5 * s], [cx + 6.5 * s, cy - 0.5 * s], [cx, cy + 12.5 * s]).fill(C.accent);
        // ... with a scoop resting on it, white-outlined so the two shapes read separately
        doc.circle(cx, cy - 4.5 * s, 7.4 * s).lineWidth(1.6 * s).fillAndStroke(C.house, C.white);
        doc.circle(cx - 2.4 * s, cy - 6.8 * s, 1.6 * s).fill(C.mint); // highlight
        doc.restore();
      };

      // ---- header band ----
      const drawHeader = () => {
        doc.rect(0, 0, W, 138).fill(C.house);
        logo(L + 20, 48, 20);
        font("Inter-Bold", 22, C.white); text(brand.name, L + 52, 34, { width: 300 });
        font("Inter", 9, C.mint); text(brand.tagline, L + 52, 62, { characterSpacing: 0.4 });

        font("Inter-SemiBold", 9, C.mint); text("INVOICE", 330, 34, { width: R - 330, align: "right", characterSpacing: 2 });
        font("Inter-Bold", 14, C.white); text(billData.invoiceNumber, 300, 50, { width: R - 300, align: "right" });
        font("Inter", 9, C.mint); text(`${formatDate(billData.createdAt)}  ·  ${formatTime(billData.createdAt)}`, 300, 72, { width: R - 300, align: "right" });

        // floating summary card overlapping the band
        const cy = 104;
        doc.roundedRect(L, cy, CW, 58, 10).fill(C.white);
        doc.roundedRect(L, cy, CW, 58, 10).lineWidth(0.6).strokeColor(C.line).stroke();
        const cell = (label, value, x) => {
          font("Inter-SemiBold", 7.5, C.soft); text(label.toUpperCase(), x, cy + 13, { characterSpacing: 1 });
          font("Inter-Bold", 12, C.ink); text(value, x, cy + 28, { width: 150 });
        };
        cell("Total amount", money(billData.totalAmount), L + 20);
        cell("Payment", payLabel(billData.paymentMethod), L + 190);
        // PAID pill
        const px = R - 96;
        doc.roundedRect(px, cy + 15, 76, 28, 14).fill(C.light);
        doc.circle(px + 16, cy + 29, 3.2).fill(C.accent);
        font("Inter-Bold", 9.5, C.green); text("PAID", px + 26, cy + 24.5, { characterSpacing: 1.2 });
      };

      const drawContinuationHeader = () => {
        doc.rect(0, 0, W, 54).fill(C.house);
        logo(L + 14, 27, 14);
        font("Inter-Bold", 13, C.white); text(brand.name, L + 38, 20);
        font("Inter", 9, C.mint); text(`Invoice ${billData.invoiceNumber} (continued)`, 300, 23, { width: R - 300, align: "right" });
      };

      drawHeader();

      // ---- parties ----
      let y = 190;
      const colW = (CW - 24) / 2;
      const party = (title, lines, x) => {
        font("Inter-SemiBold", 7.5, C.soft); text(title, x, y, { characterSpacing: 1.2 });
        let yy = y + 16;
        lines.forEach((ln, i) => {
          if (!ln) return;
          if (i === 0) { font("Inter-Bold", 12, C.ink); text(ln, x, yy, { width: colW, ellipsis: true }); yy += 19; }
          else { font("Inter", 9.5, C.soft); const h = doc.heightOfString(ln, { width: colW }); doc.text(ln, x, yy, { width: colW }); yy += h + 3; }
        });
        return yy;
      };
      const y1 = party("BILLED TO", [
        billData.customerName,
        billData.mobileNumber ? `+91 ${billData.mobileNumber}` : "",
        billData.customerEmail || "",
        billData.customerGstNumber ? `GSTIN: ${billData.customerGstNumber}` : "",
      ], L);
      const y2 = party("FROM", [
        brand.name,
        brand.address,
        brand.phone ? `+91 ${brand.phone}` : "",
        brand.gst ? `GSTIN: ${brand.gst}` : "",
      ], L + colW + 24);
      y = Math.max(y1, y2) + 16;

      // ---- items table ----
      const X = { idx: L + 12, item: L + 40, qty: 318, rate: 388, amt: R - 12 };
      const drawTableHead = () => {
        doc.roundedRect(L, y, CW, 28, 8).fill(C.canvas);
        font("Inter-SemiBold", 7.5, C.soft);
        text("#", X.idx, y + 10, { characterSpacing: 1 });
        text("ITEM", X.item, y + 10, { characterSpacing: 1 });
        text("QTY", X.qty, y + 10, { width: 60, align: "center", characterSpacing: 1 });
        text("RATE", X.rate, y + 10, { width: 70, align: "right", characterSpacing: 1 });
        text("AMOUNT", X.amt - 80, y + 10, { width: 80, align: "right", characterSpacing: 1 });
        y += 36;
      };
      const newPage = () => { doc.addPage(); drawContinuationHeader(); y = 78; };

      drawTableHead();
      const BOTTOM = H - 110; // keep clear of the footer
      billData.products.forEach((item, i) => {
        font("Inter-SemiBold", 10.5, C.ink);
        const nameH = doc.heightOfString(item.itemName, { width: 255 });
        const tagH = item.gstIncluded ? 12 : 0;
        const rowH = Math.max(34, nameH + 18 + tagH);
        if (y + rowH > BOTTOM) { newPage(); drawTableHead(); }
        font("Inter", 9, C.soft); text(String(i + 1).padStart(2, "0"), X.idx, y + 4);
        font("Inter-SemiBold", 10.5, C.ink); doc.text(item.itemName, X.item, y + 3, { width: 255, lineBreak: true });
        if (item.gstIncluded) { font("Inter", 8, C.accent); text("Price includes GST", X.item, y + 5 + nameH, { characterSpacing: 0.2 }); }
        font("Inter", 10, C.ink); text(qtyText(item), X.qty, y + 4, { width: 60, align: "center" });
        font("Inter", 10, C.soft); text(money(item.price), X.rate, y + 4, { width: 70, align: "right" });
        if ((Number(item.priceQty) || 1) !== 1) { font("Inter", 8, C.soft); text(`per ${qtyText({ quantity: item.priceQty, unit: item.unit })}`, X.rate, y + 17, { width: 70, align: "right" }); }
        font("Inter-Bold", 10.5, C.ink); text(money(item.total), X.amt - 80, y + 4, { width: 80, align: "right" });
        y += rowH - 6;
        doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor(C.line).stroke();
        y += 8;
      });

      // ---- totals ----
      if (y + 190 > BOTTOM) newPage();
      y += 10;
      const tx = R - 230;
      const row = (label, value, bold) => {
        font(bold ? "Inter-SemiBold" : "Inter", 10, bold ? C.ink : C.soft); text(label, tx, y);
        font(bold ? "Inter-Bold" : "Inter-SemiBold", 10, C.ink); text(value, tx + 100, y, { width: 130, align: "right" });
        y += 20;
      };
      // amount in words (left)
      const wordsTop = y;
      font("Inter-SemiBold", 7.5, C.soft); text("AMOUNT IN WORDS", L, wordsTop, { characterSpacing: 1.2 });
      font("Inter", 10, C.ink); doc.text(amountInWords(billData.totalAmount), L, wordsTop + 15, { width: tx - L - 24, lineBreak: true });

      row("Subtotal", money(billData.subTotal));
      row("GST (5%)", money(billData.gstAmount));
      y += 4;
      doc.roundedRect(tx - 14, y, 244, 46, 10).fill(C.house);
      font("Inter-SemiBold", 9, C.mint); text("TOTAL PAID", tx, y + 17, { characterSpacing: 1.2 });
      font("Inter-Bold", 17, C.white); text(money(billData.totalAmount), tx + 60, y + 14, { width: 156, align: "right" });
      y += 46;

      // ---- thank-you note ----
      y = Math.max(y + 34, wordsTop + 70);
      if (y + 70 > H - 70) newPage();
      doc.roundedRect(L, y, CW, 58, 10).fill(C.canvas);
      font("Inter-Bold", 12, C.green); text(`Thank you for choosing ${brand.name}!`, L + 20, y + 14);
      font("Inter", 9.5, C.soft); text("We hope you loved every scoop. See you again soon.", L + 20, y + 33);

      // ---- footer + page numbers on every page ----
      const range = doc.bufferedPageRange();
      for (let p = range.start; p < range.start + range.count; p++) {
        doc.switchToPage(p);
        doc.moveTo(L, H - 62).lineTo(R, H - 62).lineWidth(0.5).strokeColor(C.line).stroke();
        font("Inter", 8, C.soft);
        text([brand.address, brand.gst ? `GSTIN ${brand.gst}` : "", brand.site].filter(Boolean).join("   ·   "), L, H - 52, { width: CW, align: "center" });
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
  const name = escapeHtml(brand.name);
  const rows = bill.products.map((p) => `
    <tr>
      <td class="pad-x" style="padding:14px 0;border-bottom:1px solid #e6e2da;">
        <div class="ink" style="font-size:15px;font-weight:600;color:#1f2a26;line-height:1.35;">${escapeHtml(p.itemName)}</div>
        <div class="soft" style="font-size:13px;color:#6b7671;margin-top:3px;">${escapeHtml(qtyText(p))} &times; ${escapeHtml(rateText(p))}${p.gstIncluded ? " &middot; incl. GST" : ""}</div>
      </td>
      <td align="right" valign="top" class="ink" style="padding:14px 0;border-bottom:1px solid #e6e2da;font-size:15px;font-weight:700;color:#1f2a26;white-space:nowrap;">${money(p.total)}</td>
    </tr>`).join("");

  const fact = (label, value) => `
    <td class="stack" valign="top" style="padding:0 8px 0 0;">
      <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6b7671;font-weight:600;">${label}</div>
      <div class="ink" style="font-size:14px;font-weight:700;color:#1f2a26;margin-top:3px;">${value}</div>
    </td>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>Invoice ${escapeHtml(bill.invoiceNumber)}</title>
<style>
  body,table,td,a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table,td { mso-table-lspace:0; mso-table-rspace:0; }
  img { border:0; outline:none; text-decoration:none; }
  body { margin:0 !important; padding:0 !important; width:100% !important; }
  @media only screen and (max-width:620px) {
    .container { width:100% !important; border-radius:0 !important; }
    .outer { padding:0 !important; }
    .pad { padding-left:20px !important; padding-right:20px !important; }
    .h1 { font-size:22px !important; }
    .amount { font-size:32px !important; }
    .stack { display:block !important; width:100% !important; padding:0 0 12px 0 !important; }
    .btn a { display:block !important; }
  }
  @media (prefers-color-scheme: dark) {
    .bg { background-color:#0f1613 !important; }
    .card { background-color:#17211d !important; }
    .cream { background-color:#1f2b26 !important; }
    .ink { color:#f2f0eb !important; }
    .soft { color:#a9b5af !important; }
    .rule { border-color:#2b3a34 !important; }
    .accent { color:#6fd1a4 !important; }
  }
</style>
</head>
<body class="bg" style="margin:0;padding:0;background-color:#f2f0eb;font-family:Inter,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">Your invoice ${escapeHtml(bill.invoiceNumber)} for ${money(bill.totalAmount)}. Thank you for choosing ${name}.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bg" bgcolor="#f2f0eb" style="background-color:#f2f0eb;">
    <tr><td align="center" class="outer" style="padding:32px 12px;">
      <table role="presentation" class="container card" width="600" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="width:600px;max-width:600px;background-color:#ffffff;border-radius:12px;overflow:hidden;">

        <!-- header -->
        <tr><td class="pad" bgcolor="#1E3932" style="background-color:#1E3932;padding:30px 36px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td valign="middle">
              <div style="font-size:26px;font-weight:800;letter-spacing:-0.5px;color:#ffffff;line-height:1.1;">${name}</div>
              <div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#b3d7ca;margin-top:6px;">${escapeHtml(brand.tagline)}</div>
            </td>
            <td valign="middle" align="right" style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#b3d7ca;font-weight:600;">Invoice</td>
          </tr></table>
        </td></tr>

        <!-- greeting -->
        <tr><td class="pad" style="padding:32px 36px 8px;">
          <h1 class="h1 ink" style="margin:0;font-size:26px;line-height:1.25;color:#006241;font-weight:700;">Thank you, ${escapeHtml(bill.customerName)}</h1>
          <p class="soft" style="margin:10px 0 0;font-size:15px;line-height:1.6;color:#6b7671;">Here is the receipt for your visit. A PDF copy is attached to this email for your records.</p>
        </td></tr>

        <!-- amount card -->
        <tr><td class="pad" style="padding:20px 36px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="cream" bgcolor="#f2f0eb" style="background-color:#f2f0eb;border-radius:12px;">
            <tr><td style="padding:22px 24px 8px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
                <td valign="middle">
                  <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6b7671;font-weight:600;">Total paid</div>
                  <div class="amount ink" style="font-size:36px;font-weight:800;letter-spacing:-1px;color:#1E3932;line-height:1.15;margin-top:2px;">${money(bill.totalAmount)}</div>
                </td>
                <td valign="middle" align="right"><span style="display:inline-block;background-color:#d4e9e2;color:#006241;font-size:12px;font-weight:700;letter-spacing:1px;padding:7px 14px;border-radius:999px;">PAID</span></td>
              </tr></table>
            </td></tr>
            <tr><td style="padding:12px 24px 22px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
                ${fact("Invoice no.", escapeHtml(bill.invoiceNumber))}
                ${fact("Date", `${escapeHtml(formatDate(bill.createdAt))}, ${escapeHtml(formatTime(bill.createdAt))}`)}
                ${fact("Payment", escapeHtml(payLabel(bill.paymentMethod)))}
              </tr></table>
            </td></tr>
          </table>
        </td></tr>

        <!-- items -->
        <tr><td class="pad" style="padding:22px 36px 0;">
          <div style="font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:#6b7671;font-weight:700;padding-bottom:4px;border-bottom:2px solid #1E3932;">Your order</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;">
            <tr><td class="soft" style="padding:5px 0;font-size:14px;color:#6b7671;">Subtotal</td><td align="right" class="ink" style="padding:5px 0;font-size:14px;color:#1f2a26;font-weight:600;">${money(bill.subTotal)}</td></tr>
            <tr><td class="soft" style="padding:5px 0;font-size:14px;color:#6b7671;">GST (5%)</td><td align="right" class="ink" style="padding:5px 0;font-size:14px;color:#1f2a26;font-weight:600;">${money(bill.gstAmount)}</td></tr>
            <tr><td class="rule" style="padding:12px 0 0;border-top:1px solid #e6e2da;font-size:16px;font-weight:800;color:#1E3932;"><span class="ink">Total</span></td><td align="right" class="rule accent" style="padding:12px 0 0;border-top:1px solid #e6e2da;font-size:18px;font-weight:800;color:#00754A;">${money(bill.totalAmount)}</td></tr>
          </table>
          ${bill.customerGstNumber ? `<p class="soft" style="margin:16px 0 0;font-size:13px;color:#6b7671;">Billed to GSTIN: <strong class="ink" style="color:#1f2a26;">${escapeHtml(bill.customerGstNumber)}</strong></p>` : ""}
        </td></tr>

        <!-- button -->
        <tr><td class="pad" align="center" style="padding:30px 36px 34px;">
          <table role="presentation" cellpadding="0" cellspacing="0" class="btn"><tr>
            <td align="center" bgcolor="#00754A" style="background-color:#00754A;border-radius:999px;">
              <a href="https://${brand.site}" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px;">Explore our flavours</a>
            </td>
          </tr></table>
        </td></tr>

        <!-- footer -->
        <tr><td class="pad" bgcolor="#1E3932" align="center" style="background-color:#1E3932;padding:26px 36px;">
          <div style="font-size:14px;font-weight:700;color:#ffffff;">${name}</div>
          <div style="font-size:12px;line-height:1.6;color:#b3d7ca;margin-top:6px;">${escapeHtml(brand.address)}${brand.phone ? `<br>+91 ${escapeHtml(brand.phone)}` : ""}${brand.gst ? `<br>GSTIN: ${escapeHtml(brand.gst)}` : ""}</div>
          <div style="font-size:12px;margin-top:8px;"><a href="https://${brand.site}" style="color:#ffffff;text-decoration:underline;">${brand.site}</a></div>
          <div style="font-size:11px;color:#7fa596;margin-top:14px;">This is an automated receipt. Please do not reply to this email.</div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  // Plain-text alternative: better deliverability and readable in text-only clients
  const plain = [
    `${brand.name} - Invoice ${bill.invoiceNumber}`,
    `Thank you, ${bill.customerName}!`,
    `Date: ${formatDate(bill.createdAt)} ${formatTime(bill.createdAt)}   Payment: ${payLabel(bill.paymentMethod)}`,
    "",
    ...bill.products.map((p) => `- ${p.itemName}  ${qtyText(p)} x ${rateText(p)}${p.gstIncluded ? " (incl. GST)" : ""} = ${money(p.total)}`),
    "",
    `Subtotal: ${money(bill.subTotal)}`,
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
      attachments: [{ filename: `Invoice_${billData.invoiceNumber}.pdf`, content: pdfData, contentType: "application/pdf" }],
    });
    return true;
  } catch (err) {
    console.error("Email send error:", err);
    throw err;
  }
};

module.exports = { sendInvoiceEmail, buildInvoicePdf, buildInvoiceEmail };
