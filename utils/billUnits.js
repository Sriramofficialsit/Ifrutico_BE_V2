// One conversion engine for every bill type (Retail in any unit, Events in litres, Stalls in scoops/pieces).
// Everything converts through grams, using the product's box contents when given (see linksOf):
//   g / kg      — exact
//   ml / ltr    — box weight ÷ box volume, else the product's gramsPerLitre, else the global value
//   scoop       — box weight ÷ scoops per box, else the global BillingConfig.scoopGrams
//   pcs         — box weight ÷ pcs per box, else the product's pieceGrams; without either pcs only converts to pcs
// Quantities are kept to 6 decimals so repeated conversions (e.g. litres -> scoops) don't drift.
// KEEP IN SYNC with FE/src/utils/billModes.js.
const UNITS = ["pcs", "scoop", "g", "kg", "ml", "ltr"];

const r6 = (n) => Math.round(n * 1e6) / 1e6;

// One box / pack of a product can be described in all three measures: packWeight (g), packVolume (ml) and
// packCount (pcs or scoops, per packCountUnit). Those ratios are the most accurate links, so they win;
// missing ones fall back to the older per-product fields (pieceGrams, gramsPerLitre) and the global config.
// cfg: { gramsPerLitre, scoopGrams } (global)
const linksOf = (product, cfg) => {
  const W = Number(product?.packWeight) || 0;
  const V = Number(product?.packVolume) || 0;
  const N = Number(product?.packCount) || 0;
  const gpl = W > 0 && V > 0 ? W / (V / 1000)
    : Number(product?.gramsPerLitre) > 0 ? Number(product.gramsPerLitre) : Number(cfg.gramsPerLitre) || 1000;
  const boxGrams = W > 0 ? W : V > 0 ? (V / 1000) * gpl : 0;
  const each = N > 0 && boxGrams > 0 ? boxGrams / N : null; // grams in one pc / scoop of this box
  const countUnit = product?.packCountUnit === "scoop" ? "scoop" : "pcs";
  return {
    gpl,
    pieceGrams: countUnit === "pcs" && each ? each : Number(product?.pieceGrams) > 0 ? Number(product.pieceGrams) : null,
    scoopGrams: countUnit === "scoop" && each ? each : Number(cfg.scoopGrams) > 0 ? Number(cfg.scoopGrams) : null,
    ownScoop: countUnit === "scoop" && !!each, // the box says how many scoops it gives
  };
};
// true when Stall scoops should be counted against this product's own box (not the bill's gram size)
const hasOwnScoop = (product, cfg) => linksOf(product, cfg).ownScoop || (product?.unit === "scoop" && product?.packCountUnit === "scoop" && Number(product?.packCount) > 0);
const ownScoopGrams = (product, cfg) => linksOf(product, cfg).scoopGrams;

// Grams in one of `unit`, or null if this product can't express that unit
const gramsPer = (unit, product, cfg) => {
  const l = linksOf(product, cfg);
  switch (unit) {
    case "g": return 1;
    case "kg": return 1000;
    case "ml": return l.gpl / 1000;
    case "ltr": return l.gpl;
    case "scoop": return l.scoopGrams;
    case "pcs": return l.pieceGrams;
    default: return null;
  }
};

const SAME_FAMILY = { "g>kg": 1 / 1000, "kg>g": 1000, "ml>ltr": 1 / 1000, "ltr>ml": 1000 };

// qty of `from` -> quantity in `to` (null when not convertible for this product)
const convert = (qty, from, to, product, cfg) => {
  if (from === to) return r6(qty);
  const exact = SAME_FAMILY[`${from}>${to}`];
  if (exact) return r6(qty * exact);
  const a = gramsPer(from, product, cfg);
  const b = gramsPer(to, product, cfg);
  return a && b ? r6((qty * a) / b) : null;
};
const canConvert = (from, to, product, cfg) => convert(1, from, to, product, cfg) !== null;

// Stock taken for selling `qty` of `sellUnit`. Products counted in pcs only lose whole pieces (rounded up).
const toStock = (qty, sellUnit, product, cfg) => {
  const unit = product.unit || "pcs";
  const q = convert(qty, sellUnit, unit, product, cfg);
  if (q === null) return null;
  return unit === "pcs" ? Math.ceil(q - 1e-6) : q;
};

module.exports = { UNITS, r6, linksOf, hasOwnScoop, ownScoopGrams, gramsPer, convert, canConvert, toStock };
