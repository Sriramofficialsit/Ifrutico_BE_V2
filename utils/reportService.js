// Branded downloadable reports (bill list, customer list): a landscape A4 PDF and an Excel-ready CSV.
// Same look as the invoice PDF (logo, forest/leaf brand strip, Inter fonts).
const PDFDocument = require("pdfkit");
const path = require("path");
const fs = require("fs");

const FONTS = path.join(__dirname, "..", "assets", "fonts");
const LOGO_FILE = path.join(__dirname, "..", "assets", "logo.png");
const C = {
  forest: "#17704a", deep: "#0f3d2b", leaf: "#8db552", ink: "#2b3431", soft: "#6b7570", faint: "#9aa39f",
  line: "#e6e9e3", tint: "#f2f7f1", leafTint: "#f6f9ee", zebra: "#fafbf8", white: "#ffffff",
};

const IST = "Asia/Kolkata";
const fmtDateTime = (d) =>
  new Date(d).toLocaleString("en-IN", { timeZone: IST, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * report: {
 *   title, subtitle, brand: { name, address, phone, gst },
 *   summary: [{ label, value, note? }]          — KPI cards (up to 6)
 *   breakdown?: [{ label, value, pct }]         — small bar list under the cards (e.g. payment split)
 *   breakdownTitle?: string
 *   columns: [{ key, label, width (relative), align?: 'left'|'right'|'center' }]
 *   rows: [{ [key]: string }]                   — already formatted strings
 *   totals?: { [key]: string }                  — bold last row
 *   emptyText?: string
 * }
 * Resolves with a PDF Buffer.
 */
const buildReportPdf = (report) =>
  new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4", layout: "landscape", margins: { top: 0, left: 36, right: 36, bottom: 0 }, bufferPages: true,
        info: { Title: report.title, Author: report.brand?.name || "Ifrutico" },
      });
      doc.registerFont("Inter", path.join(FONTS, "Inter_400Regular.ttf"));
      doc.registerFont("Inter-SemiBold", path.join(FONTS, "Inter_600SemiBold.ttf"));
      doc.registerFont("Inter-Bold", path.join(FONTS, "Inter_700Bold.ttf"));
      const buffers = [];
      doc.on("data", (b) => buffers.push(b));
      doc.on("end", () => resolve(Buffer.concat(buffers)));
      doc.on("error", reject);

      const W = 841.89, H = 595.28, L = 36, R = W - 36, CW = R - L;
      const BOTTOM = H - 44;
      const font = (name, size, color) => doc.font(name).fontSize(size).fillColor(color);
      const text = (s, x, y, o = {}) => doc.text(String(s ?? ""), x, y, { lineBreak: false, ...o });
      const hasLogo = fs.existsSync(LOGO_FILE);
      const generated = fmtDateTime(new Date());

      const strip = () => {
        doc.rect(0, 0, W * 0.72, 5).fill(C.forest);
        doc.rect(W * 0.72, 0, W * 0.28, 5).fill(C.leaf);
      };

      // ---- Page 1 header: logo + title band ----
      strip();
      if (hasLogo) doc.image(LOGO_FILE, L - 4, 20, { height: 50 });
      else { font("Inter-Bold", 22, C.forest); text(report.brand?.name || "Ifrutico", L, 32); }
      font("Inter-Bold", 20, C.ink); text(report.title, 300, 24, { width: R - 300, align: "right" });
      font("Inter", 10, C.soft); text(report.subtitle || "", 300, 50, { width: R - 300, align: "right" });
      font("Inter", 8.5, C.faint); text(`Generated ${generated}`, 300, 65, { width: R - 300, align: "right" });
      const brandLine = [report.brand?.address, report.brand?.phone, report.brand?.gst ? `GSTIN ${report.brand.gst}` : ""].filter(Boolean).join("   ·   ");
      if (brandLine) { font("Inter", 8, C.faint); text(brandLine, L, 76, { width: CW / 2 }); }
      let y = 94;
      doc.moveTo(L, y).lineTo(R, y).lineWidth(0.6).strokeColor(C.line).stroke();
      y += 14;

      // ---- KPI cards ----
      const cards = (report.summary || []).slice(0, 6);
      if (cards.length) {
        const gap = 10;
        const cw = (CW - gap * (cards.length - 1)) / cards.length;
        cards.forEach((c, i) => {
          const x = L + i * (cw + gap);
          const first = i === 0;
          doc.roundedRect(x, y, cw, 58, 8).fill(first ? C.deep : C.tint);
          if (!first) doc.roundedRect(x, y, cw, 58, 8).lineWidth(0.6).strokeColor(C.line).stroke();
          doc.rect(x, y + 12, 3, 34).fill(first ? C.leaf : C.forest);
          font("Inter-SemiBold", 7, first ? "#b9d9c8" : C.faint); text(String(c.label).toUpperCase(), x + 12, y + 11, { width: cw - 20, height: 9, ellipsis: true, characterSpacing: 0.8 });
          font("Inter-Bold", 15, first ? C.white : C.ink); text(c.value, x + 12, y + 24, { width: cw - 20 });
          if (c.note) { font("Inter", 7.5, first ? "#cfe5d8" : C.soft); text(c.note, x + 12, y + 43, { width: cw - 20 }); }
        });
        y += 58 + 14;
      }

      // ---- Breakdown bars (e.g. payment methods) ----
      const bd = report.breakdown || [];
      if (bd.length) {
        font("Inter-SemiBold", 7.5, C.faint); text(String(report.breakdownTitle || "Breakdown").toUpperCase(), L, y, { characterSpacing: 1 });
        y += 13;
        const colW = (CW - 20 * (bd.length - 1)) / bd.length;
        bd.forEach((b, i) => {
          const x = L + i * (colW + 20);
          font("Inter-SemiBold", 8.5, C.ink); text(b.label, x, y, { width: colW * 0.5 });
          font("Inter", 8.5, C.soft); text(`${b.value}  ·  ${Math.round(b.pct)}%`, x + colW * 0.4, y, { width: colW * 0.6, align: "right" });
          doc.roundedRect(x, y + 13, colW, 5, 2.5).fill(C.line);
          if (b.pct > 0) doc.roundedRect(x, y + 13, Math.max(5, (colW * Math.min(b.pct, 100)) / 100), 5, 2.5).fill(i % 2 ? C.leaf : C.forest);
        });
        y += 32;
      }

      // ---- Table ----
      const cols = report.columns;
      const totalW = cols.reduce((s, c) => s + c.width, 0);
      const xs = [];
      let acc = L;
      cols.forEach((c) => { xs.push(acc); acc += (c.width / totalW) * CW; });
      const colWidth = (i) => (cols[i].width / totalW) * CW;
      const PAD = 6;

      const head = () => {
        doc.roundedRect(L, y, CW, 22, 5).fill(C.forest);
        font("Inter-SemiBold", 7.5, C.white);
        cols.forEach((c, i) => text(c.label.toUpperCase(), xs[i] + PAD, y + 7.5, { width: colWidth(i) - PAD * 2, height: 10, align: c.align || "left", characterSpacing: 0.4, ellipsis: true }));
        y += 24;
      };
      const newPage = () => {
        doc.addPage();
        strip();
        if (hasLogo) doc.image(LOGO_FILE, L - 3, 14, { height: 28 });
        font("Inter", 8.5, C.soft); text(`${report.title}  ·  ${report.subtitle || ""}  ·  continued`, 300, 24, { width: R - 300, align: "right" });
        y = 54;
        head();
      };

      const rows = report.rows || [];
      if (!rows.length) {
        doc.roundedRect(L, y, CW, 70, 8).dash(3, { space: 3 }).lineWidth(0.7).strokeColor(C.line).stroke().undash();
        font("Inter", 10, C.faint); text(report.emptyText || "No records for this period.", L, y + 30, { width: CW, align: "center" });
      } else {
        head();
        const ROW = 20;
        rows.forEach((r, ri) => {
          if (y + ROW > BOTTOM) newPage();
          if (ri % 2 === 1) doc.rect(L, y - 1, CW, ROW).fill(C.zebra);
          cols.forEach((c, i) => {
            font(c.bold ? "Inter-SemiBold" : "Inter", 8, c.muted ? C.soft : C.ink);
            text(r[c.key], xs[i] + PAD, y + 5, { width: colWidth(i) - PAD * 2, height: 11, align: c.align || "left", ellipsis: true });
          });
          y += ROW;
          doc.moveTo(L, y - 1).lineTo(R, y - 1).lineWidth(0.3).strokeColor(C.line).stroke();
        });
        if (report.totals) {
          if (y + 26 > BOTTOM) newPage();
          y += 3;
          doc.roundedRect(L, y, CW, 22, 5).fill(C.leafTint);
          doc.rect(L, y, 3, 22).fill(C.leaf);
          cols.forEach((c, i) => {
            if (report.totals[c.key] == null) return;
            font("Inter-Bold", 8.5, C.deep);
            text(report.totals[c.key], xs[i] + PAD, y + 7, { width: colWidth(i) - PAD * 2, height: 11, align: c.align || "left", ellipsis: true });
          });
          y += 22;
        }
      }

      // ---- Footer on every page ----
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.moveTo(L, H - 30).lineTo(R, H - 30).lineWidth(0.5).strokeColor(C.line).stroke();
        font("Inter", 7.5, C.faint);
        text(`${report.brand?.name || "Ifrutico"}  ·  ${report.title}  ·  Confidential — for internal use`, L, H - 22, { width: CW / 2 });
        text(`Page ${i - range.start + 1} of ${range.count}`, L + CW / 2, H - 22, { width: CW / 2, align: "right" });
      }
      doc.end();
    } catch (e) {
      reject(e);
    }
  });

// CSV with a UTF-8 BOM (so Excel shows ₹ and names correctly). Cells starting with = + - @ are prefixed with '
// so a customer name can never run as a spreadsheet formula.
const csvCell = (v) => {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const buildCsv = (headers, rows, preamble = []) =>
  "﻿" + [...preamble.map((l) => csvCell(l)), ...(preamble.length ? [""] : []), headers.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\r\n");

// Parses YYYY-MM-DD as a whole day in India time. Returns null when invalid.
const istDayStart = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || "") && !isNaN(new Date(`${s}T00:00:00+05:30`)) ? new Date(`${s}T00:00:00+05:30`) : null);
const istDayEnd = (s) => (istDayStart(s) ? new Date(`${s}T23:59:59.999+05:30`) : null);
const fmtDay = (d) => new Date(d).toLocaleDateString("en-IN", { timeZone: IST, day: "2-digit", month: "short", year: "numeric" });

const sendFile = (res, buffer, filename, type) => {
  res.setHeader("Content-Type", type);
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  res.setHeader("Cache-Control", "no-store");
  return res.send(buffer);
};

module.exports = { buildReportPdf, buildCsv, istDayStart, istDayEnd, fmtDay, fmtDateTime, sendFile, IST };
