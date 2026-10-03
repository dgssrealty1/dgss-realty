// Worker unit/integration tests — run with `npm test` (Node 20+).
// Supabase is mocked in-process; no network access is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import app, {
  seoTitle, seoDescription, sanitizeRichText, buildJsonLd, propertyFacts,
  normalizeSlug, areaMatches, AREAS, renderPropertyPage, priceText, cfg, toMediaUrl
} from "../src/app.js";

const c = cfg({});
const ORIGIN = "https://dgssrealty.com";

const nandanam = {
  id: "11111111-1111-1111-1111-111111111111", slug: "2bhk-flat-nandanam",
  title: "2 BHK Flat – Nandanam", category: "Flat", listing_type: "For Sale", status: "Available",
  location: "Nandanam", city: "Chennai", state: "Tamil Nadu", display_price: "₹1.90 Crore", price: 19000000,
  bedrooms: 2, builtup_area: "1,362 Sq.Ft.", short_description: "Total 11 apartments.",
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z", is_published: true, is_archived: false,
  property_images: [
    { id: "i2", public_url: "https://x.supabase.co/storage/v1/object/public/property-images/a/2.jpg", alt_text: "Kitchen", is_featured_image: false, sort_order: 1 },
    { id: "i1", public_url: `${ORIGIN}/images/properties/prop-3-nandanam.jpg`, alt_text: "Living room", is_featured_image: true, sort_order: 0 }
  ]
};
const land = {
  id: "22222222-2222-2222-2222-222222222222", slug: "premium-beach-side-land-uthandi",
  title: "Premium Beach-Side Land – Uthandi", category: "Land", listing_type: "For Sale", status: "Available",
  location: "Uthandi – Before Toll, Sea Side", city: "Chennai", display_price: "₹15 Crore (Negotiable)",
  bedrooms: 0, bathrooms: 2, land_area: "5.7 Grounds", is_price_on_request: false,
  created_at: "2026-01-02T00:00:00Z", property_images: []
};
const sold = { ...nandanam, id: "33333333-3333-3333-3333-333333333333", slug: "sold-one", title: "3 BHK – Velachery", location: "Velachery", status: "Sold", price: null, display_price: null, is_price_on_request: true, property_images: [] };

/* ---------------- pure helpers ---------------- */
test("SEO title is natural and location isn't repeated", () => {
  assert.equal(seoTitle(nandanam), "2 BHK Flat for Sale in Nandanam, Chennai | DGSS Realty");
  assert.equal(seoTitle({ ...nandanam, seo_title: "Custom" }), "Custom");
  assert.match(seoTitle(land), /^Premium Beach-Side Land for Sale in Uthandi, Chennai \| DGSS Realty$/);
});

test("meta description uses real facts only and stays under 160 chars", () => {
  const d = seoDescription(nandanam);
  assert.ok(d.length <= 160, d.length);
  assert.match(d, /2 BHK flat for sale in Nandanam/);
  assert.match(d, /₹1\.90 Crore/);
  assert.doesNotMatch(seoDescription({ ...nandanam, is_price_on_request: true }), /Price:/);
});

test("land never shows bedrooms/bathrooms; missing fields are omitted", () => {
  const facts = Object.fromEntries(propertyFacts(land));
  assert.equal(facts.Bedrooms, undefined);
  assert.equal(facts.Bathrooms, undefined);
  assert.equal(facts["Land Area"], "5.7 Grounds");
  assert.equal(facts.Furnishing, undefined);
});

test("price text", () => {
  assert.equal(priceText({ is_price_on_request: true, display_price: "x" }), "Price on Request");
  assert.equal(priceText({ price: 12500000 }), "₹1.25 Crore");
  assert.equal(priceText({}), "Price on Request");
});

test("rich text sanitizer never lets script through", () => {
  const vectors = [
    '<script>alert(1)</script>hi',
    '<img src=x onerror=alert(1)>',
    '<p onclick="x()">a</p><a href="javascript:alert(1)">b</a>',
    '<svg/onload=alert(1)>',
    '<p>ok</p><iframe src="//evil"></iframe>',
    '<b style="x" onmouseover=alert(1)>bold</b>',
    '"><script>alert(1)</script>',
    '<ScRiPt>alert(1)</sCrIpT>',
    '<p>x</p><style>*{}</style>'
  ];
  for (const v of vectors) {
    const out = sanitizeRichText(v);
    // no real (unescaped) dangerous tags, and no attributes at all on any real tag
    assert.doesNotMatch(out, /<(script|img|svg|iframe|a|style|object|embed)\b/i, `${v} -> ${out}`);
    assert.doesNotMatch(out, /<[a-z0-9]+\s[^>]*>/i, `attribute survived: ${v} -> ${out}`);
  }
  assert.equal(sanitizeRichText("## Title\nLine one\n\n- a\n- b"), "<h3>Title</h3><p>Line one</p><ul><li>a</li><li>b</li></ul>");
  assert.equal(sanitizeRichText("<p>Hello <strong>there</strong></p>"), "<p>Hello <strong>there</strong></p>");
});

test("slugs normalize to safe URL characters", () => {
  assert.equal(normalizeSlug("  2BHK Flat — Nandanam!! "), "2bhk-flat-nandanam");
  assert.equal(normalizeSlug("../../etc/passwd"), "etc-passwd");
  assert.equal(normalizeSlug("<script>"), "script");
});

test("area matching", () => {
  const find = s => AREAS.find(a => a.slug === s);
  assert.ok(areaMatches(find("uthandi"), land));
  assert.ok(!areaMatches(find("uthandi"), nandanam));
  assert.ok(areaMatches(find("kk-nagar"), { location: "KK Nagar West" }));
  assert.ok(areaMatches(find("kk-nagar"), { location: "K.K. Nagar" }));
  assert.ok(!areaMatches(find("ecr"), { location: "Decree Road" }));
});

test("JSON-LD contains only real data", () => {
  const { listing, breadcrumb } = buildJsonLd(c, nandanam, [nandanam.property_images[1]]);
  assert.equal(listing["@type"], "RealEstateListing");
  assert.equal(listing.url, `${ORIGIN}/properties/2bhk-flat-nandanam/`);
  assert.equal(listing.about["@type"], "Apartment");
  assert.equal(listing.about.numberOfBedrooms, 2);
  assert.equal(listing.about.floorSize.value, 1362);
  assert.equal(listing.about.geo, undefined, "no invented coordinates");
  assert.equal(listing.about.address.streetAddress, undefined, "no invented street address");
  assert.equal(listing.offers.price, 19000000);
  assert.equal(listing.offers.priceCurrency, "INR");
  assert.equal(breadcrumb["@type"], "BreadcrumbList");

  const landLd = buildJsonLd(c, land, []).listing;
  assert.equal(landLd.about["@type"], "Place");
  assert.equal(landLd.about.numberOfBedrooms, undefined);
  assert.equal(landLd.offers.price, undefined, "display-only price is not invented as a number");

  const soldLd = buildJsonLd(c, sold, []).listing;
  assert.equal(soldLd.offers.availability, "https://schema.org/SoldOut");
});

test("rendered page: one H1, canonical, OG absolute image, JSON-LD parses", () => {
  const html = renderPropertyPage({ c, property: nandanam, contact: { phone: "+91", phoneDisplay: "x", whatsapp: "91", email: "e", address: "a" }, related: [] });
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
  assert.match(html, /<link rel="canonical" href="https:\/\/dgssrealty\.com\/properties\/2bhk-flat-nandanam\/">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/dgssrealty\.com\/images\/properties\/prop-3-nandanam\.jpg">/);
  assert.match(html, /twitter:card/);
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));
  assert.equal(blocks.length, 2);
  // featured image is shown first and gets high priority
  const firstImg = html.indexOf("prop-3-nandanam");
  const secondImg = html.indexOf("a/2.jpg");
  assert.ok(firstImg > -1 && firstImg < secondImg);
  assert.match(html, /fetchpriority="high"/);
  assert.match(html, /1 \/ 2|<span data-current>1<\/span> \/ 2/);
  // WhatsApp message carries the real title + canonical URL
  assert.match(html, /wa\.me\/91\?text=Hi%20DGSS%20Realty%2C%20I%20am%20interested%20in%20this%20property%3A%202%20BHK%20Flat/);
});

test("sold property is clearly not presented as available", () => {
  const html = renderPropertyPage({ c, property: sold, contact: { phone: "1", phoneDisplay: "1", whatsapp: "1", email: "e", address: "a" }, related: [] });
  assert.match(html, /has been <strong>sold<\/strong>/);
  assert.match(html, /Looking for something similar\?/);
});

test("draft preview is noindex, has no canonical and no JSON-LD", () => {
  const html = renderPropertyPage({ c, property: nandanam, contact: { phone: "1", phoneDisplay: "1", whatsapp: "1", email: "e", address: "a" }, related: [], preview: true });
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.doesNotMatch(html, /rel="canonical"/);
  assert.doesNotMatch(html, /application\/ld\+json/);
});

/* ---------------- request handling (mocked Supabase) ---------------- */
function mockSupabase({ properties = [nandanam, land], redirects = {}, rpc } = {}) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    calls.push({ url: url.toString(), init });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/rest/v1/settings") return json([{ phone: "+91 98410 09059", whatsapp: "+91 98410 09059", company_name: "DGSS Realty" }]);
    if (url.pathname === "/rest/v1/properties") {
      const slug = url.searchParams.get("slug");
      const id = url.searchParams.get("id");
      if (slug) return json(properties.filter(p => `eq.${p.slug}` === slug));
      if (id) {
        const auth = init.headers && init.headers.Authorization;
        return auth === "Bearer staff-token" ? json(properties.filter(p => `eq.${p.id}` === id)) : json([]);
      }
      return json(properties);
    }
    if (url.pathname === "/rest/v1/property_slug_redirects") {
      const old = (url.searchParams.get("old_slug") || "").replace(/^eq\./, "");
      return json(redirects[old] ? [{ properties: redirects[old] }] : []);
    }
    if (url.pathname === "/rest/v1/rpc/submit_lead") return json(rpc ? rpc(JSON.parse(init.body)) : { ok: true });
    if (url.pathname.startsWith("/storage/v1/object/authenticated/property-images/")) {
      return url.pathname.endsWith("/live.jpg")
        ? new Response("IMG", { headers: { "Content-Type": "image/jpeg" } })
        : new Response(JSON.stringify({ error: "not_found" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname.startsWith("/storage/v1/object/public/property-images/")) {
      // simulates a still-public bucket for "pre-04.jpg" only
      return url.pathname.endsWith("/pre-04.jpg")
        ? new Response("IMG", { headers: { "Content-Type": "image/jpeg" } })
        : new Response(JSON.stringify({ error: "not_found" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/storage/v1/object/sign/property-images") {
      const { paths } = JSON.parse(init.body);
      return json(paths.map(p => ({ path: p, signedURL: `/object/sign/property-images/${p}?token=t` })));
    }
    if (url.hostname === "challenges.cloudflare.com") return json({ success: false });
    return json({ error: "unmocked " + url.pathname }, 500);
  };
  return calls;
}
const env = (extra = {}) => ({ ASSETS: { fetch: async () => new Response("asset", { headers: { "Content-Type": "text/plain" } }) }, ...extra });
const req = (path, init) => new Request(`${ORIGIN}${path}`, init);

test("property page 200 / unknown 404 / trailing-slash + case 301 / old slug 301", async () => {
  mockSupabase({ redirects: { "old-nandanam": { slug: "2bhk-flat-nandanam", is_published: true, is_archived: false } } });
  let r = await app.fetch(req("/properties/2bhk-flat-nandanam/"), env());
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("X-Content-Type-Options"), "nosniff");
  assert.ok(r.headers.get("Content-Security-Policy").includes("object-src 'none'"));
  assert.equal(r.headers.get("X-Robots-Tag"), null, "canonical host is indexable");

  r = await app.fetch(req("/properties/nope/"), env());
  assert.equal(r.status, 404);
  const body = await r.text();
  assert.match(body, /Property not found/);
  assert.match(body, /Browse Properties/);
  assert.match(body, /Contact DGSS Realty/);

  r = await app.fetch(req("/properties/2BHK-Flat-Nandanam"), env());
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("Location"), `${ORIGIN}/properties/2bhk-flat-nandanam/`);

  r = await app.fetch(req("/properties/old-nandanam/"), env());
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("Location"), `${ORIGIN}/properties/2bhk-flat-nandanam/`);
});

test("www and legacy ?property= links redirect to the canonical URL", async () => {
  mockSupabase();
  let r = await app.fetch(new Request("http://www.dgssrealty.com/properties/x/?a=1"), env());
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("Location"), `${ORIGIN}/properties/x/?a=1`);
  r = await app.fetch(req("/?property=2bhk-flat-nandanam"), env());
  assert.equal(r.headers.get("Location"), `${ORIGIN}/properties/2bhk-flat-nandanam/`);
});

test("non-canonical hosts (workers.dev) are noindex", async () => {
  mockSupabase();
  const r = await app.fetch(new Request("https://ealty-website.example.workers.dev/properties/2bhk-flat-nandanam/"), env());
  assert.equal(r.headers.get("X-Robots-Tag"), "noindex, nofollow");
});

test("sitemap lists homepage + published properties, no admin", async () => {
  mockSupabase({ properties: [nandanam, land, { ...land, id: "x", slug: "second-uthandi" }] });
  const r = await app.fetch(req("/sitemap.xml"), env());
  const xml = await r.text();
  assert.equal(r.headers.get("Content-Type"), "application/xml; charset=utf-8");
  assert.match(xml, /<loc>https:\/\/dgssrealty\.com\/<\/loc>/);
  assert.match(xml, /properties\/2bhk-flat-nandanam\//);
  assert.match(xml, /<lastmod>2026-02-01<\/lastmod>/);
  assert.match(xml, /areas\/uthandi\//, "area with 2+ listings included");
  assert.doesNotMatch(xml, /areas\/nandanam\//, "area with 1 listing excluded");
  assert.doesNotMatch(xml, /admin/);
});

test("area page exists only with inventory", async () => {
  mockSupabase();
  assert.equal((await app.fetch(req("/areas/uthandi/"), env())).status, 200);
  assert.equal((await app.fetch(req("/areas/tambaram/"), env())).status, 404);
  assert.equal((await app.fetch(req("/areas/not-a-place/"), env())).status, 404);
  const r = await app.fetch(req("/areas/nandanam/"), env());
  assert.match(await r.text(), /noindex, follow/, "single-listing area is noindex");
});

test("lead API: validation, honeypot, origin check, forwarding", async () => {
  const calls = mockSupabase({ rpc: args => (args.p_phone === "bad" ? { ok: false, error: "invalid_phone" } : { ok: true }) });
  const post = (body, headers = {}) => app.fetch(req("/api/lead", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body)
  }), env());

  let r = await post({ source: "contact_form", name: "Ravi", phone: "9841000001", message: "hi" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  const sent = JSON.parse(calls.find(c => c.url.includes("submit_lead")).init.body);
  assert.equal(sent.p_source, "contact_form");
  assert.equal(sent.p_gate, null);

  r = await post({ source: "contact_form", name: "Ravi", phone: "bad" });
  assert.equal(r.status, 400);
  assert.match((await r.json()).message, /valid phone/);

  const before = calls.length;
  r = await post({ source: "contact_form", name: "Bot", phone: "9841000001", website: "http://spam" });
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(calls.length, before, "honeypot never reaches the database");

  r = await post({ source: "contact_form", name: "x", phone: "1" }, { Origin: "https://evil.example" });
  assert.equal(r.status, 403);

  r = await post({ source: "hacker", name: "x", phone: "1" });
  assert.equal(r.status, 400);

  r = await post("not json");
  assert.equal(r.status, 400);

  r = await post("x".repeat(25000));
  assert.equal(r.status, 400);

  r = await app.fetch(req("/api/lead"), env());
  assert.equal(r.status, 405);
});

test("lead API: Turnstile required when configured; gate secret forwarded", async () => {
  const calls = mockSupabase();
  const e = env({ TURNSTILE_SECRET_KEY: "s", LEAD_GATE_SECRET: "g" });
  const post = body => app.fetch(req("/api/lead", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.5" }, body: JSON.stringify(body) }), e);
  let r = await post({ source: "contact_form", name: "Ravi", phone: "9841000001" });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "captcha_failed");
  // Turnstile says yes -> forwarded with gate + client IP
  globalThis.fetch = (orig => async (input, init) => {
    const u = typeof input === "string" ? input : input.url;
    if (u.includes("challenges.cloudflare.com")) return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
    return orig(input, init);
  })(globalThis.fetch);
  r = await post({ source: "contact_form", name: "Ravi", phone: "9841000001", turnstileToken: "t" });
  assert.equal(r.status, 200);
  const sent = JSON.parse(calls.find(c => c.url.includes("submit_lead")).init.body);
  assert.equal(sent.p_gate, "g");
  assert.equal(sent.p_client_ip, "203.0.113.5");
});

test("draft preview requires a staff session", async () => {
  mockSupabase({ properties: [{ ...nandanam, is_published: false }] });
  const post = auth => app.fetch(req("/api/preview", {
    method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify({ id: nandanam.id })
  }), env());
  assert.equal((await post(null)).status, 401);
  assert.equal((await post("Bearer random-user")).status, 404);
  const r = await post("Bearer staff-token");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.match(await r.text(), /PREVIEW/);
});

test("everything else is served as a static asset", async () => {
  mockSupabase();
  const r = await app.fetch(req("/"), env());
  assert.equal(await r.text(), "asset");
  assert.equal(r.headers.get("X-Frame-Options"), "SAMEORIGIN");
});

const PID = "44444444-4444-4444-4444-444444444444";

test("stored public Storage URLs are rewritten to /media (bucket can be private)", () => {
  assert.equal(toMediaUrl(`https://x.supabase.co/storage/v1/object/public/property-images/${PID}/a.jpg`), `/media/property-images/${PID}/a.jpg`);
  assert.equal(toMediaUrl(`${ORIGIN}/images/properties/prop-1-perambur.jpg`), `${ORIGIN}/images/properties/prop-1-perambur.jpg`);
  const html = renderPropertyPage({ c, property: { ...nandanam, property_images: [
    { id: "a", public_url: `https://x.supabase.co/storage/v1/object/public/property-images/${PID}/a.jpg`, is_featured_image: true, sort_order: 0 }] },
    contact: { phone: "1", phoneDisplay: "1", whatsapp: "1", email: "e", address: "a" }, related: [] });
  assert.doesNotMatch(html, /object\/public\/property-images/);
  assert.match(html, new RegExp(`src="/media/property-images/${PID}/a.jpg"`));
  assert.match(html, new RegExp(`og:image" content="https://dgssrealty.com/media/property-images/${PID}/a.jpg"`));
});

test("/media serves published images, 404s drafts and bad paths, sends apikey only", async () => {
  const calls = mockSupabase();
  let r = await app.fetch(req(`/media/property-images/${PID}/live.jpg`), env());
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Content-Type"), "image/jpeg");
  const call = calls.find(c => c.url.includes("/object/authenticated/"));
  assert.equal(call.init.headers.apikey, c.anonKey);
  assert.equal(call.init.headers.Authorization, undefined, "publishable key never sent as Bearer");
  r = await app.fetch(req(`/media/property-images/${PID}/draft.jpg`), env());
  assert.equal(r.status, 404);
  // before migration 04 the public endpoint still serves -> no broken photos after deploying code first
  r = await app.fetch(req(`/media/property-images/${PID}/pre-04.jpg`), env());
  assert.equal(r.status, 200);
  // "../" is resolved by the URL parser before routing, so it never reaches /media or Storage
  const before = calls.length;
  await app.fetch(req("/media/property-images/../../etc/passwd"), env());
  assert.ok(!calls.slice(before).some(c => c.url.includes("/storage/")), "traversal never reaches Storage");
  for (const bad of [`/media/property-images/${PID}/a b.jpg`, "/media/other-bucket/x.jpg", `/media/property-images/${PID}/..jpg`]) {
    assert.equal((await app.fetch(req(bad), env())).status, 404, bad);
  }
});

test("public REST reads and the lead RPC send the publishable key only in apikey", async () => {
  const calls = mockSupabase();
  await app.fetch(req("/properties/2bhk-flat-nandanam/"), env());
  await app.fetch(req("/api/lead", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ source: "contact_form", name: "Ravi", phone: "9841000001" }) }), env());
  const supa = calls.filter(c => c.url.includes("/rest/v1/"));
  assert.ok(supa.length > 2);
  for (const call of supa) {
    assert.equal(call.init.headers.apikey, c.anonKey);
    assert.equal(call.init.headers.Authorization, undefined, call.url);
  }
});

test("draft preview signs uploaded images with the staff session", async () => {
  const calls = mockSupabase({ properties: [{ ...nandanam, is_published: false, property_images: [
    { id: "d", public_url: `/media/property-images/${PID}/d.jpg`, storage_path: `${PID}/d.jpg`, is_featured_image: true, sort_order: 0 }] }] });
  const r = await app.fetch(req("/api/preview", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer staff-token" }, body: JSON.stringify({ id: nandanam.id }) }), env());
  const html = await r.text();
  assert.match(html, new RegExp(`storage/v1/object/sign/property-images/${PID}/d.jpg\\?token=t`));
  const sign = calls.find(c => c.url.includes("/object/sign/"));
  assert.equal(sign.init.headers.Authorization, "Bearer staff-token");
});
