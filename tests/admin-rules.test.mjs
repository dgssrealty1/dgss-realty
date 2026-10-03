// Admin business rules (admin/js/admin-rules.js) — the browser-side mirror
// of the database trigger. The database itself is tested in
// supabase/tests/rls_test.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { priceText } from "../src/app.js";

const require = createRequire(import.meta.url);
const R = require("../admin/js/admin-rules.js");

test("listing type / market status combinations match the database rules", () => {
  assert.match(R.listingStatusProblem("For Sale", "Rented"), /can't be marked “Rented”/);
  assert.match(R.listingStatusProblem("For Sale", "Leased"), /Leased/);
  assert.match(R.listingStatusProblem("For Rent", "Sold"), /Rented/);
  assert.match(R.listingStatusProblem("For Lease", "Sold"), /Leased/);
  for (const [lt, st] of [["For Sale", "Sold"], ["For Rent", "Rented"], ["For Rent", "Leased"], ["For Lease", "Rented"], ["For Sale", "Under Offer"], ["", "Sold"]]) {
    assert.equal(R.listingStatusProblem(lt, st), null, `${lt} + ${st}`);
  }
  assert.deepEqual(R.allowedStatuses("For Sale", ["Available", "Sold", "Rented", "Leased"]), ["Available", "Sold"]);
});

test("generated display price uses the same wording as the public site", () => {
  for (const [n, lt] of [[8500000, "For Sale"], [19000000, "For Sale"], [45000, "For Rent"], [150000, "For Lease"], [99999, "For Sale"]]) {
    assert.equal(R.formatInr(n, lt), priceText({ price: n, listing_type: lt }), `${n} ${lt}`);
  }
  assert.equal(R.formatInr(0, "For Sale"), "");
});

test("display price parsing: totals understood, ambiguous wording left alone", () => {
  assert.equal(R.parseDisplayPrice("₹1.90 Crore"), 19000000);
  assert.equal(R.parseDisplayPrice("85 Lakhs"), 8500000);
  assert.equal(R.parseDisplayPrice("₹85L (Negotiable)"), 8500000);
  assert.equal(R.parseDisplayPrice("₹45,000 / Month"), 45000);
  assert.equal(R.parseDisplayPrice("₹3 Crore per Ground"), null);
  assert.equal(R.parseDisplayPrice("1.5 Cr - 2 Cr"), null);
  assert.equal(R.parseDisplayPrice("₹4,500 per sq.ft"), null);
  assert.equal(R.parseDisplayPrice(""), null);
});

test("price mismatch warning only for clear disagreements (>10%)", () => {
  assert.equal(R.priceMismatch(19000000, "₹1.90 Crore"), null);
  assert.equal(R.priceMismatch(19000000, "₹1.95 Crore"), null, "small rounding is fine");
  assert.ok(R.priceMismatch(8500000, "₹1.2 Cr"));
  assert.equal(R.priceMismatch(null, "₹1.2 Cr"), null, "Price on Request / no numeric price is legitimate");
  assert.equal(R.priceMismatch(30000000, "₹3 Crore per Ground"), null, "per-unit prices are not compared");
});
