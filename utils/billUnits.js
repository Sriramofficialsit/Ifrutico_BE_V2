// Converts Events (litre boxes) and Stalls (scoops in grams) into the product's own stock unit,
// so every bill type draws from the same central/branch inventory.
// KEEP IN SYNC with FE/src/utils/billModes.js.
const r3 = (n) => Math.round(n * 1000) / 1000;

const MEASURABLE = ["g", "kg", "ml", "ltr"];

const litresToUnits = (litres, unit, gramsPerLitre) => {
  switch (unit) {
    case "ltr": return r3(litres);
    case "ml": return r3(litres * 1000);
    case "kg": return r3((litres * gramsPerLitre) / 1000);
    case "g": return r3(litres * gramsPerLitre);
    default: return null;
  }
};

const gramsToUnits = (grams, unit, gramsPerLitre) => {
  switch (unit) {
    case "g": return r3(grams);
    case "kg": return r3(grams / 1000);
    case "ml": return r3((grams / gramsPerLitre) * 1000);
    case "ltr": return r3(grams / gramsPerLitre);
    default: return null;
  }
};

module.exports = { MEASURABLE, litresToUnits, gramsToUnits };
