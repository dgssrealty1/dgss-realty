/* ==========================================================================
   PROPERTY BUSINESS RULES (admin UI)
   Mirrors the database trigger validate_property_business_rules()
   (migration 05) so problems show up while typing. The database is the
   real guard; this file only gives faster, clearer feedback.
   Also used by tests/admin-rules.test.mjs (Node).
   ========================================================================== */
(function (root) {
  "use strict";

  const LISTING_STATUS_RULES = {
    "For Sale": ["Rented", "Leased"],
    "For Rent": ["Sold"],
    "For Lease": ["Sold"]
  };

  /* null when fine, otherwise a sentence for the admin. */
  function listingStatusProblem(listingType, status) {
    const bad = LISTING_STATUS_RULES[listingType] || [];
    if (!bad.includes(status)) return null;
    return listingType === "For Sale"
      ? `A property listed For Sale can't be marked “${status}”. Use Sold, or change the listing type.`
      : `A property listed ${listingType} can't be marked “Sold”. Use ${listingType === "For Rent" ? "Rented" : "Leased"}, or change the listing type.`;
  }
  function allowedStatuses(listingType, all) {
    const bad = LISTING_STATUS_RULES[listingType] || [];
    return all.filter(s => !bad.includes(s));
  }

  function trimZeros(x) { return x.toFixed(2).replace(/\.?0+$/, ""); }
  /* Same wording as the public site (src/app.js priceText). */
  function formatInr(n, listingType) {
    if (!(typeof n === "number" && n > 0)) return "";
    let s;
    if (n >= 1e7) s = `₹${trimZeros(n / 1e7)} Crore`;
    else if (n >= 1e5) s = `₹${trimZeros(n / 1e5)} Lakh`;
    else s = `₹${n.toLocaleString("en-IN")}`;
    return listingType === "For Rent" || listingType === "For Lease" ? `${s} / Month` : s;
  }

  /* Best-effort reading of a typed display price. Returns rupees, or null
     when the text isn't a single total price (per ground, ranges, …). */
  function parseDisplayPrice(text) {
    const t = String(text || "").toLowerCase().replace(/,/g, "").trim();
    if (!t) return null;
    if (/\bper\b|\/\s*(sq|ground|cent|acre)|sq\.?\s*ft|sqft|\bground|\bcent|\bacre|\bto\b|–|—/.test(t)) return null;
    if ((t.match(/\d+(?:\.\d+)?/g) || []).length !== 1) return null;   // ranges, "2 BHK …", etc.
    const m = t.match(/(\d+(?:\.\d+)?)\s*(crores?|cr|lakhs?|lacs?|l\b|k\b|thousand)?/);
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    const unit = m[2] || "";
    if (/^cr/.test(unit)) return Math.round(n * 1e7);
    if (/^(lakh|lac|l$)/.test(unit)) return Math.round(n * 1e5);
    if (/^(k$|thousand)/.test(unit)) return Math.round(n * 1e3);
    return n;
  }

  /* Warns when both prices are set and clearly disagree (>10 %). */
  function priceMismatch(price, displayPrice) {
    const p = typeof price === "number" ? price : Number(price);
    if (!(p > 0) || !String(displayPrice || "").trim()) return null;
    const parsed = parseDisplayPrice(displayPrice);
    if (!parsed) return null;
    const diff = Math.abs(parsed - p) / p;
    return diff > 0.1 ? { parsed, diff } : null;
  }

  const api = { listingStatusProblem, allowedStatuses, formatInr, parseDisplayPrice, priceMismatch, LISTING_STATUS_RULES };
  root.DGSSRules = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
