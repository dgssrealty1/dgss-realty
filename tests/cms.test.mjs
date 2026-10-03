// CMS → public site regression tests (homepage, contact settings, logo,
// social links, SEO hierarchy, structured data, listings fallback, cache
// versioning, media paths, staff invite). Supabase is mocked in-process;
// the homepage tests render the REAL index.html.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import app, {
  cfg, renderPropertyPage, renderAreaPage, renderNotFoundPage, AREAS, seoTitle, seoDescription,
  canonicalFor, priceText, toMediaUrl, parseMediaPath, postalAddress, _resetCacheVersionMemo,
  SITE_PAGES, extractChrome, chromeForPage
} from "../src/app.js";
import { normalizeSettings, applyCms, telHref, waDigits } from "../src/cms.js";
import { SITE_DEFAULTS } from "../src/site-defaults.js";

const ORIGIN = "https://dgssrealty.com";
const c = cfg({});
const INDEX = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

const SETTINGS = {
  company_name: "Test Realty Co",
  logo_url: "/media/site-media/branding/logo-new.png",
  phone: "+91 90000 11111",
  whatsapp: "+91 90000 22222",
  email: "hello@test-realty.example",
  office_address: "12 Test Street, Adyar, Chennai - 600020",
  google_maps_url: "https://maps.app.goo.gl/TESTMAP",
  instagram_url: "https://instagram.com/test-ig",
  facebook_url: "https://facebook.com/test-fb",
  youtube_url: "",
  default_seo_title: "Default Title From Admin",
  default_seo_description: "Default description from Admin SEO.",
  home_seo_title: "",
  home_seo_description: "",
  default_og_image_url: "/media/site-media/homepage/share.jpg",
  office_hours: "Mon–Sat 10–6",
  hero_heading: "Hero line one\nHero accent line",
  hero_subheading: "Subheading from Admin.",
  hero_cta_text: "See Listings",
  founder_name: "A. Founder",
  founder_designation: "Managing Director",
  founder_bio_top: "First para.\n\nSecond para.",
  founder_photo_url: "/media/site-media/founder/photo.jpg"
};

const PROP = {
  id: "11111111-1111-1111-1111-111111111111", slug: "2bhk-flat-nandanam", title: "2 BHK Flat – Nandanam",
  category: "Flat", listing_type: "For Sale", status: "Available", location: "Nandanam", city: "Chennai",
  display_price: "₹1.90 Crore", price: 19000000, bedrooms: 2, builtup_area: "1,362 Sq.Ft.", is_featured: false,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z",
  property_images: [{ public_url: "/media/property-images/11111111-1111-1111-1111-111111111111/a.jpg", alt_text: "Living", is_featured_image: true, sort_order: 0 }]
};
const PROP2 = { ...PROP, id: "22222222-2222-2222-2222-222222222222", slug: "villa-ecr", title: "Villa – ECR", is_featured: true, location: "ECR", property_images: [] };

function mock({ settings = SETTINGS, properties = [PROP, PROP2], testimonials = [], down = {}, version = 1, rpc = {} } = {}) {
  const calls = [];
  const state = { version };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    calls.push({ url: url.toString(), init });
    const j = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    const p = url.pathname;
    if (p === "/rest/v1/site_cache_state") return j([{ version: state.version }]);
    if (p === "/rest/v1/settings") return down.settings ? j({ message: "down" }, 503) : j(settings ? [settings] : []);
    if (p === "/rest/v1/properties") {
      if (down.properties) return j({ message: "down" }, 503);
      const slug = url.searchParams.get("slug");
      if (slug) return j(properties.filter(x => `eq.${x.slug}` === slug));
      return j(properties);
    }
    if (p === "/rest/v1/testimonials") return down.testimonials ? j({}, 503) : j(testimonials);
    if (p === "/rest/v1/property_slug_redirects") return j([]);
    if (p === "/rest/v1/rpc/current_admin_role") return j(rpc.role ? rpc.role(init.headers.Authorization) : null);
    if (p === "/rest/v1/rpc/add_staff_by_email") return j(rpc.addStaff ? rpc.addStaff(JSON.parse(init.body), init.headers) : { ok: true });
    if (p === "/auth/v1/invite") return rpc.invite ? rpc.invite(init) : j({ id: "u" });
    if (p.startsWith("/storage/v1/object/")) {
      const known = rpc.objects || [];
      return known.includes(p) ? new Response("IMG", { headers: { "Content-Type": "image/jpeg" } }) : j({ error: "not_found" }, 400);
    }
    return j({ error: "unmocked " + p }, 500);
  };
  return { calls, state };
}

const assetsEnv = (extra = {}, html = INDEX) => {
  const seen = [];
  return {
    seen,
    ASSETS: {
      fetch: async req => {
        seen.push(req);
        const u = new URL(req.url);
        if (u.pathname === "/index.html" || u.pathname === "/") {
          return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", ETag: '"static-etag"' } });
        }
        const pageFile = u.pathname.match(/^\/([a-z-]+)\.html$/);
        if (pageFile && fs.existsSync(new URL(`../${pageFile[1]}.html`, import.meta.url))) {
          return new Response(fs.readFileSync(new URL(`../${pageFile[1]}.html`, import.meta.url), "utf8"),
            { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        return new Response("asset", { headers: { "Content-Type": "text/plain" } });
      }
    },
    ...extra
  };
};
const req = (path, init) => new Request(`${ORIGIN}${path}`, init);
const home = async (opts = {}, env = assetsEnv()) => {
  const m = mock(opts);
  const r = await app.fetch(req("/"), env);
  return { r, html: await r.text(), ...m, env };
};
const homeData = html => JSON.parse(html.match(/<script type="application\/json" id="homeData">([\s\S]*?)<\/script>/)[1]);
const jsonLd = html => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));

beforeEach(() => { _resetCacheVersionMemo(); delete globalThis.caches; });

/* ---------------- homepage hero ---------------- */
test("CMS hero: Admin heading / subheading / CTA appear on the real homepage", async () => {
  const { r, html } = await home();
  assert.equal(r.status, 200);
  assert.match(html, /<h1 id="hero-heading" data-cms-html="hero_heading">Hero line one<br><span class="accent">Hero accent line<\/span><\/h1>/);
  assert.match(html, /data-cms-text="hero_subheading">Subheading from Admin\.<\/p>/);
  assert.match(html, /data-cms-text="hero_cta">See Listings<\/a>/);
  assert.doesNotMatch(html, /Discover the Right Property/, "built-in hero text replaced");
});

test("CMS hero: change → save → revert is reflected (blank keeps built-in text)", async () => {
  let { html } = await home({ settings: { ...SETTINGS, hero_heading: "Changed heading" } });
  assert.match(html, /data-cms-html="hero_heading">Changed heading<\/h1>/);
  _resetCacheVersionMemo();
  ({ html } = await home({ settings: { ...SETTINGS, hero_heading: "", hero_subheading: null, hero_cta_text: "" } }));
  assert.match(html, /data-cms-html="hero_heading"><span class="hero-h1-part">Discover the Right Property.<\/span> <span class="hero-h1-part">Make the Right Deal.<\/span><\/h1>/);
  assert.match(html, /data-cms-text="hero_cta">Explore Properties<\/a>/);
});

test("CMS hero: heading text is escaped (no HTML injection from Admin)", async () => {
  const { html } = await home({ settings: { ...SETTINGS, hero_heading: '<img src=x onerror=alert(1)>' } });
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

/* ---------------- contact settings: single source ---------------- */
test("CMS contact: phone appears in header, mobile nav, contact, footer — no old number anywhere", async () => {
  const { html } = await home();
  const tel = (html.match(/href="tel:\+919000011111"/g) || []).length;
  assert.ok(tel >= 4, `tel links: ${tel}`);
  assert.match(html, /data-cms-text="phone"[^>]*>\+91 90000 11111</);
  assert.doesNotMatch(html, /98410|9841009059/, "no hardcoded office number left on the homepage");
});

test("CMS contact: WhatsApp drives header, hero CTA, floating button, social row", async () => {
  const { html } = await home();
  const wa = (html.match(/href="https:\/\/wa\.me\/919000022222"/g) || []).length;
  assert.ok(wa >= 6, `wa links: ${wa}`);
  assert.match(html, /class="wa-float" href="https:\/\/wa\.me\/919000022222"/);
  assert.match(html, /Chat on WhatsApp/);
});

test("CMS contact: email, address (maps link), hours, map embed", async () => {
  const { html } = await home();
  assert.match(html, /href="mailto:hello@test-realty\.example"[^>]*>hello@test-realty\.example</);
  assert.match(html, /href="https:\/\/maps\.app\.goo\.gl\/TESTMAP"[^>]*>12 Test Street, Adyar, Chennai - 600020</);
  assert.match(html, /data-cms-text="hours"[^>]*>Mon–Sat 10–6</);
  assert.match(html, /<iframe data-cms-src="map_embed"[^>]*src="https:\/\/maps\.google\.com\/maps\?q=12%20Test%20Street/);
  assert.doesNotMatch(html, /info@dgssrealty\.com|Vidhya Apartments|CrMbvZicknnpp8g58/);
});

test("CMS contact: blank optional fields are hidden, not left with stale values", async () => {
  const { html } = await home({ settings: { ...SETTINGS, office_address: "", office_hours: "", google_maps_url: "" } });
  assert.match(html, /<div class="info-row" data-cms-hide-unless="address" hidden>/);
  assert.match(html, /<div class="info-row" data-cms-hide-unless="hours" hidden>/);
  assert.match(html, /<div class="map-embed" data-cms-hide-unless="map_embed" hidden>/);
});

test("CMS social: Instagram/Facebook from settings; blank YouTube hidden everywhere", async () => {
  const { html } = await home();
  assert.ok((html.match(/href="https:\/\/instagram\.com\/test-ig"/g) || []).length >= 4);
  assert.ok((html.match(/href="https:\/\/facebook\.com\/test-fb"/g) || []).length >= 4);
  const yt = [...html.matchAll(/<a [^>]*data-cms-href="youtube"[^>]*>/g)].map(m => m[0]);
  assert.ok(yt.length >= 4);
  yt.forEach(tag => assert.match(tag, /\shidden(\s|>|$)/, tag));
  assert.doesNotMatch(html, /gopivarshini7351|1FGMuq63RG/, "old hardcoded social URLs gone");
});

test("CMS social: unsafe URLs from the database are never rendered", async () => {
  const { html } = await home({ settings: { ...SETTINGS, instagram_url: "javascript:alert(1)", facebook_url: "http://insecure.example" } });
  assert.doesNotMatch(html, /javascript:alert/);
  assert.doesNotMatch(html, /insecure\.example/);
});

test("CMS logo: header + footer + JSON-LD use logo_url; blank falls back safely", async () => {
  let { html } = await home();
  assert.ok((html.match(/src="\/media\/site-media\/branding\/logo-new\.png"/g) || []).length >= 2);
  assert.equal(jsonLd(html)[0].logo, `${ORIGIN}/media/site-media/branding/logo-new.png`);
  _resetCacheVersionMemo();
  ({ html } = await home({ settings: { ...SETTINGS, logo_url: "" } }));
  assert.ok((html.match(/src="\/icons\/dgss-realty-logo-262\.png"/g) || []).length >= 2);
  assert.equal(jsonLd(html)[0].logo, `${ORIGIN}${SITE_DEFAULTS.logo}`);
  _resetCacheVersionMemo();
  ({ html } = await home({ settings: { ...SETTINGS, logo_url: "javascript:alert(1)" } }));
  assert.doesNotMatch(html, /javascript:alert/);
});

test("CMS company name: JSON-LD, og:site_name, alt text, contact heading", async () => {
  const { html } = await home();
  assert.equal(jsonLd(html)[0].name, "Test Realty Co");
  assert.match(html, /<meta property="og:site_name" content="Test Realty Co">/);
  assert.match(html, /class="brand-logo-img" alt="Test Realty Co"/);
  assert.match(html, /<h3 data-cms-text="company">Test Realty Co<\/h3>/);
});

test("CMS founder: name, designation with company, bio paragraphs and photo", async () => {
  const { html } = await home();
  assert.match(html, /data-cms-text="founder_name">A\. Founder</);
  assert.match(html, /data-cms-text="founder_designation_dash">Managing Director – Test Realty Co</);
  assert.match(html, /data-cms-paras="founder_bio_top"><p>First para\.<\/p><p>Second para\.<\/p><\/div>/);
  assert.match(html, /<img src="\/media\/site-media\/founder\/photo\.jpg" alt="A\. Founder, Managing Director of Test Realty Co"/);
  assert.match(html, /data-cms-text="founder_initials">AF</);
});

/* ---------------- homepage SEO ---------------- */
test("SEO homepage: homepage-specific SEO → global default → built-in", async () => {
  let { html } = await home({ settings: { ...SETTINGS, home_seo_title: "Home Title", home_seo_description: "Home desc." } });
  assert.match(html, /<title>Home Title<\/title>/);
  assert.match(html, /<meta name="description" content="Home desc\.">/);
  assert.match(html, /<meta property="og:title" content="Home Title">/);
  assert.match(html, /<meta name="twitter:title" content="Home Title">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/dgssrealty\.com\/">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/dgssrealty\.com\/media\/site-media\/homepage\/share\.jpg">/);
  _resetCacheVersionMemo();
  ({ html } = await home());
  assert.match(html, /<title>Default Title From Admin<\/title>/);
  assert.match(html, /<meta name="description" content="Default description from Admin SEO\.">/);
  _resetCacheVersionMemo();
  ({ html } = await home({ settings: { ...SETTINGS, default_seo_title: "", default_seo_description: "" } }));
  assert.match(html, /<title>Test Realty Co \| Real Estate Services in Chennai<\/title>/);
  assert.equal((html.match(/<title>/g) || []).length, 1, "exactly one <title>");
  assert.doesNotMatch(html, /<meta name="keywords"/i, "no fake meta-keywords SEO");
});

test("SEO homepage: JSON-LD is valid and uses only real settings", async () => {
  const { html } = await home();
  const blocks = jsonLd(html);
  assert.equal(blocks.length, 1);
  const ld = blocks[0];
  assert.equal(ld["@type"], "RealEstateAgent");
  assert.equal(ld.telephone, "+919000011111");
  assert.equal(ld.email, "hello@test-realty.example");
  assert.deepEqual(ld.sameAs, ["https://instagram.com/test-ig", "https://facebook.com/test-fb"]);
  assert.equal(ld.address.postalCode, "600020");
  assert.equal(ld.address.addressLocality, "Chennai");
  assert.equal(ld.founder.name, "A. Founder");
});

/* ---------------- listings: live data, never stale fallback ---------------- */
test("Listings: server-rendered from the database, featured first, data for filters embedded", async () => {
  const { html, calls } = await home();
  assert.match(html, /<div class="prop-grid" id="propertyGrid" aria-live="polite"><!--cms:property-grid-->\s*<article class="prop-card/);
  assert.ok(html.indexOf("Villa – ECR") < html.indexOf("2 BHK Flat – Nandanam"), "featured listing first");
  const data = homeData(html);
  assert.equal(data.properties.length, 2);
  assert.equal(data.propertiesUnavailable, false);
  const q = calls.find(x => x.url.includes("/rest/v1/properties?"));
  assert.ok(!decodeURIComponent(q.url).includes("select=*"), "explicit public column list only");
  assert.match(decodeURIComponent(q.url), /is_published=eq\.true&is_archived=eq\.false/);
});

test("Listings: database down → clean 'temporarily unavailable' notice with Call/WhatsApp, no stale inventory", async () => {
  const { r, html } = await home({ down: { properties: true } });
  assert.equal(r.status, 200);
  assert.match(html, /Property listings are temporarily unavailable\./);
  assert.match(html, /class="prop-unavailable"[\s\S]*href="tel:\+919000011111"[\s\S]*href="https:\/\/wa\.me\/919000022222"/);
  assert.doesNotMatch(html, /Prime Residential Property|Beach-Side Land|₹15 Crore|prop-1-perambur|<article class="prop-card/, "no hardcoded sample listings");
  const data = homeData(html);
  assert.equal(data.properties, null);
  assert.equal(data.propertiesUnavailable, true);
});

test("Listings: the public script has no built-in property list", () => {
  const js = fs.readFileSync(new URL("../js/script.js", import.meta.url), "utf8");
  assert.doesNotMatch(js, /Perambur|Uthandi|Ashok Nagar|prop-1-perambur/);
  assert.match(js, /temporarily unavailable/);
});

test("Settings unreachable: page still renders with the emergency defaults", async () => {
  const { r, html } = await home({ down: { settings: true } });
  assert.equal(r.status, 200);
  assert.match(html, new RegExp(`href="tel:${telHref(SITE_DEFAULTS.phone).replace("+", "\\+")}"`));
});

test("Testimonials: published ones rendered with rating and photo; none → section stays hidden", async () => {
  let { html } = await home({ testimonials: [
    { id: "t1", client_name: "Priya Raman", client_role: "Buyer", location: "Adyar", review: "Great <b>help</b>", rating: 4, photo_url: "/media/site-media/general/p.jpg" },
    { id: "t2", client_name: "Kumar", review: "Smooth", rating: null, photo_url: "javascript:alert(1)" }
  ] });
  assert.match(html, /<section class="testimonials" id="testimonials" aria-labelledby="testimonials-heading">/);
  assert.match(html, /aria-label="Rated 4 out of 5"/);
  assert.match(html, /src="\/media\/site-media\/general\/p\.jpg"/);
  assert.match(html, /Great &lt;b&gt;help&lt;\/b&gt;/);
  assert.doesNotMatch(html, /javascript:alert/);
  _resetCacheVersionMemo();
  ({ html } = await home({ testimonials: [] }));
  assert.match(html, /id="testimonials"[^>]*hidden/);
});

test("Homepage: conditional requests can't serve a stale page (no ETag/304 passthrough)", async () => {
  const env = assetsEnv();
  mock();
  const r = await app.fetch(req("/", { headers: { "If-None-Match": '"static-etag"' } }), env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("ETag"), null);
  assert.equal(env.seen[0].headers.get("If-None-Match"), null);
  assert.match(r.headers.get("Cache-Control"), /max-age=0/);
  assert.ok(r.headers.get("Content-Security-Policy").includes("frame-ancestors 'self'"));
});

/* ---------------- property / area / 404 pages ---------------- */
const S = normalizeSettings(SETTINGS);

test("Property page: contact, company, logo and socials from settings", () => {
  const html = renderPropertyPage({ c, property: PROP, contact: S, related: [] });
  assert.match(html, /href="tel:\+919000011111"/);
  assert.match(html, /wa\.me\/919000022222\?text=Hi%20Test%20Realty%20Co/);
  assert.match(html, /mailto:hello@test-realty\.example/);
  assert.match(html, /src="\/media\/site-media\/branding\/logo-new\.png" class="brand-logo-img" alt="Test Realty Co"/);
  assert.match(html, /href="https:\/\/instagram\.com\/test-ig"/);
  assert.match(html, /Mon–Sat 10–6/);
  assert.doesNotMatch(html, /98410|info@dgssrealty/);
  const ld = jsonLd(html).find(b => b["@type"] === "RealEstateListing");
  assert.equal(ld.provider.name, "Test Realty Co");
  assert.equal(ld.provider.telephone, "+919000011111");
  assert.equal(ld.provider.logo, `${ORIGIN}/media/site-media/branding/logo-new.png`);
});

test("Property SEO hierarchy: property SEO → automatic → global default", () => {
  assert.equal(seoTitle({ ...PROP, seo_title: "Own Title" }, S), "Own Title");
  assert.equal(seoTitle(PROP, S), "2 BHK Flat for Sale in Nandanam, Chennai | Test Realty Co");
  assert.equal(seoTitle({ slug: "x" }, S), "Default Title From Admin");
  assert.equal(seoDescription({ ...PROP, seo_description: "Own desc" }, S), "Own desc");
  assert.match(seoDescription(PROP, S), /Contact Test Realty Co/);
  assert.equal(seoDescription({ slug: "x" }, S), "Default description from Admin SEO.");
});

test("Property canonical: blank → own URL; same-site variants normalized; external ignored", () => {
  assert.equal(canonicalFor(c, PROP), `${ORIGIN}/properties/2bhk-flat-nandanam/`);
  assert.equal(canonicalFor(c, { ...PROP, canonical_url: "http://www.dgssrealty.com/properties/other-one" }), `${ORIGIN}/properties/other-one/`);
  assert.equal(canonicalFor(c, { ...PROP, canonical_url: "https://evil.example/properties/x/" }), `${ORIGIN}/properties/2bhk-flat-nandanam/`);
  assert.equal(canonicalFor(c, { ...PROP, canonical_url: "javascript:alert(1)" }), `${ORIGIN}/properties/2bhk-flat-nandanam/`);
  const html = renderPropertyPage({ c, property: { ...PROP, canonical_url: "http://dgssrealty.com/properties/other-one" }, contact: S, related: [] });
  assert.match(html, /<link rel="canonical" href="https:\/\/dgssrealty\.com\/properties\/other-one\/">/);
});

test("Property OG image: property → featured photo → global default", () => {
  let html = renderPropertyPage({ c, property: { ...PROP, og_image_url: "https://cdn.example/og.jpg" }, contact: S, related: [] });
  assert.match(html, /og:image" content="https:\/\/cdn\.example\/og\.jpg"/);
  html = renderPropertyPage({ c, property: PROP, contact: S, related: [] });
  assert.match(html, /og:image" content="https:\/\/dgssrealty\.com\/media\/property-images\/11111111-1111-1111-1111-111111111111\/a\.jpg"/);
  html = renderPropertyPage({ c, property: { ...PROP, property_images: [] }, contact: S, related: [] });
  assert.match(html, /og:image" content="https:\/\/dgssrealty\.com\/media\/site-media\/homepage\/share\.jpg"/);
  assert.match(html, /twitter:image/);
});

test("Area page + 404 page use settings", () => {
  const area = renderAreaPage({ c, area: AREAS[0], list: [PROP], contact: S, allCount: 1 });
  assert.match(area, /<title>Properties for Sale &amp; Rent in Chennai \| Test Realty Co<\/title>/);
  assert.match(area, /wa\.me\/919000022222/);
  const nf = renderNotFoundPage({ c, kind: "property", contact: S });
  assert.match(nf, /href="tel:\+919000011111"/);
  assert.match(nf, /Contact Test Realty Co/);
  assert.match(nf, /noindex, follow/);
});

test("Static 404.html has no hardcoded contact details and loads them from /api/site-settings", () => {
  const nf = fs.readFileSync(new URL("../404.html", import.meta.url), "utf8");
  assert.doesNotMatch(nf, /98410|tel:\+|info@/);
  assert.match(nf, /data-cms-href="tel"/);
  assert.match(nf, /<script src="\/js\/common\.js" defer><\/script>/);
});

test("/api/site-settings exposes only public contact fields", async () => {
  mock();
  const r = await app.fetch(req("/api/site-settings"), assetsEnv());
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.phone, "+919000011111");
  assert.equal(body.whatsapp, "919000022222");
  assert.equal(body.socials.youtube, "");
  for (const k of Object.keys(body)) {
    assert.ok(["company", "phone", "phoneDisplay", "whatsapp", "whatsappDisplay", "email", "address", "hours", "mapsUrl", "mapEmbed", "logo", "socials"].includes(k), k);
  }
  assert.equal((await app.fetch(req("/api/site-settings", { method: "POST" }), assetsEnv())).status, 405);
});

test("Phone / WhatsApp normalization for links", () => {
  assert.equal(telHref("98400 12345"), "+919840012345");
  assert.equal(telHref("+1 (555) 010-9999"), "+15550109999");
  assert.equal(waDigits("98400 12345"), "919840012345");
  assert.equal(waDigits("+91 98400 12345"), "919840012345");
});

test("Price text: rent/lease numeric prices are monthly; manual display price wins", () => {
  assert.equal(priceText({ price: 45000, listing_type: "For Rent" }), "₹45,000 / Month");
  assert.equal(priceText({ price: 12500000, listing_type: "For Sale" }), "₹1.25 Crore");
  assert.equal(priceText({ price: 12500000, display_price: "₹1.3 Cr (Negotiable)" }), "₹1.3 Cr (Negotiable)");
  assert.equal(priceText({ price: 12500000, is_price_on_request: true }), "Price on Request");
});

test("postalAddress only states facts present in the text", () => {
  assert.deepEqual(postalAddress("Plot 4, Madurai 625001"), { "@type": "PostalAddress", streetAddress: "Plot 4, Madurai 625001", addressCountry: "IN", postalCode: "625001" });
  assert.equal(postalAddress(""), null);
});

test("applyCms leaves unmarked markup untouched and tolerates nested tags", () => {
  const s = normalizeSettings({ company_name: "X Co", phone: "9840012345" });
  const out = applyCms('<div><p data-cms-text="company">Old <b>bold</b> text</p><span>keep</span><a data-cms-href="tel" href="#">c</a></div>', s);
  assert.equal(out, '<div><p data-cms-text="company">X Co</p><span>keep</span><a data-cms-href="tel" href="tel:+919840012345">c</a></div>');
});

/* ---------------- media paths ---------------- */
const PID = "44444444-4444-4444-4444-444444444444";
test("Legacy image paths (spaces, special chars, nested) map to safe /media URLs", () => {
  assert.equal(toMediaUrl(`https://x.supabase.co/storage/v1/object/public/property-images/${PID}/My Photo (1).jpg`),
    `/media/property-images/${PID}/My%20Photo%20(1).jpg`);
  assert.equal(toMediaUrl(`https://x.supabase.co/storage/v1/object/public/property-images/${PID}/gallery/a%2Bb.jpg`),
    `/media/property-images/${PID}/gallery/a%2Bb.jpg`);
  assert.equal(toMediaUrl(`https://x.supabase.co/storage/v1/object/public/property-images/${PID}/../../x.jpg`),
    `https://x.supabase.co/storage/v1/object/public/property-images/${PID}/../../x.jpg`, "unsafe paths are not rewritten");
  assert.deepEqual(parseMediaPath(`/media/property-images/${PID}/My%20Photo%20(1).jpg`), { bucket: "property-images", objectPath: `${PID}/My%20Photo%20(1).jpg` });
  assert.equal(parseMediaPath(`/media/property-images/${PID}/a%2F..%2Fb.jpg`), null, "encoded slash/dot-dot rejected");
  assert.equal(parseMediaPath(`/media/property-images/not-a-uuid/a.jpg`), null);
  assert.deepEqual(parseMediaPath("/media/site-media/branding/logo.png"), { bucket: "site-media", objectPath: "branding/logo.png" });
  assert.equal(parseMediaPath("/media/site-media/secret/logo.png"), null);
});

test("/media serves legacy-named photos and site media; rejects bad paths before Storage", async () => {
  const { calls } = mock({ rpc: { objects: [
    `/storage/v1/object/authenticated/property-images/${PID}/My%20Photo%20(1).jpg`,
    "/storage/v1/object/public/site-media/branding/logo.png"
  ] } });
  let r = await app.fetch(req(`/media/property-images/${PID}/My%20Photo%20(1).jpg`), assetsEnv());
  assert.equal(r.status, 200);
  r = await app.fetch(req("/media/site-media/branding/logo.png"), assetsEnv());
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Content-Type"), "image/jpeg");
  const before = calls.length;
  r = await app.fetch(req(`/media/property-images/${PID}/a%2F..%2F..%2Fx.jpg`), assetsEnv());
  assert.equal(r.status, 404);
  assert.ok(!calls.slice(before).some(x => x.url.includes("/storage/")));
});

/* ---------------- cache versioning ---------------- */
function fakeCaches() {
  const store = new Map();
  globalThis.caches = { default: {
    match: async r => { const v = store.get(r.url); return v ? v.clone() : undefined; },
    put: async (r, res) => { store.set(r.url, res.clone()); }
  } };
  return store;
}

test("Cache: public reads are cached under the content version; an Admin change refreshes immediately", async () => {
  const store = fakeCaches();
  const { calls, state } = mock();
  const env = assetsEnv();
  await app.fetch(req("/properties/2bhk-flat-nandanam/"), env);
  const dataCalls = () => calls.filter(x => x.url.includes("/rest/v1/") && !x.url.includes("site_cache_state")).length;
  const first = dataCalls();
  assert.ok(first >= 2);
  assert.ok([...store.keys()].every(k => k.includes("/__cache/v1/")));

  await app.fetch(req("/properties/2bhk-flat-nandanam/"), env);
  assert.equal(dataCalls(), first, "second view served from the edge cache");

  state.version = 2;                 // e.g. admin changed the price
  _resetCacheVersionMemo();          // (the Worker re-reads the version every 5 s)
  await app.fetch(req("/properties/2bhk-flat-nandanam/"), env);
  assert.ok(dataCalls() > first, "new version → fresh data");
  assert.ok([...store.keys()].some(k => k.includes("/__cache/v2/")));
});

test("Cache: Supabase reads no longer use un-versioned cf edge caching", async () => {
  const { calls } = mock();
  await app.fetch(req("/properties/2bhk-flat-nandanam/"), assetsEnv());
  calls.filter(x => x.url.includes("/rest/v1/")).forEach(x => assert.equal(x.init.cf, undefined, x.url));
});

/* ---------------- staff invite (server-side, super_admin only) ---------------- */
test("Staff invite: requires a super_admin session verified by the database", async () => {
  const post = (body, headers = {}, env = {}) => app.fetch(req("/api/admin/invite-staff", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers }, body: JSON.stringify(body)
  }), assetsEnv(env));
  mock({ rpc: { role: auth => (auth === "Bearer super" ? "super_admin" : auth === "Bearer admin" ? "admin" : null) } });
  assert.equal((await post({ email: "a@b.co", role: "editor" })).status, 401);
  assert.equal((await post({ email: "a@b.co", role: "editor" }, { Authorization: "Bearer admin" })).status, 403);
  assert.equal((await post({ email: "a@b.co", role: "owner" }, { Authorization: "Bearer super" })).status, 400);
  assert.equal((await post({ email: "nope", role: "editor" }, { Authorization: "Bearer super" })).status, 400);
  const r = await post({ email: "a@b.co", role: "editor" }, { Authorization: "Bearer super" });
  assert.equal(r.status, 501, "without the secret, invites are switched off (no fallback to anything unsafe)");
  assert.equal((await post({ email: "a@b.co", role: "editor" }, { Authorization: "Bearer super", Origin: "https://evil.example" })).status, 403);
});

test("Staff invite: service key only used server-side for the invite; role granted with the caller's session", async () => {
  const { calls } = mock({ rpc: {
    role: auth => (auth === "Bearer super" ? "super_admin" : null),
    addStaff: (body, headers) => (headers.Authorization === "Bearer super" && body.p_role === "sales" ? { ok: true } : { ok: false, error: "forbidden" })
  } });
  const r = await app.fetch(req("/api/admin/invite-staff", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, Authorization: "Bearer super" },
    body: JSON.stringify({ email: "New@Staff.example", role: "sales", displayName: "New Person" })
  }), assetsEnv({ SUPABASE_SERVICE_ROLE_KEY: "sb_secret_TESTKEY" }));
  const text = await r.text();
  assert.equal(r.status, 200, text);
  assert.deepEqual(JSON.parse(text), { ok: true, invited: true });
  assert.doesNotMatch(text, /sb_secret/);
  const invite = calls.find(x => x.url.includes("/auth/v1/invite"));
  assert.equal(invite.init.headers.apikey, "sb_secret_TESTKEY");
  assert.equal(JSON.parse(invite.init.body).email, "new@staff.example");
  const grant = calls.find(x => x.url.includes("add_staff_by_email"));
  assert.equal(grant.init.headers.Authorization, "Bearer super");
  assert.equal(grant.init.headers.apikey, c.anonKey, "role grant uses the public key + caller session, not the service key");
});


/* ---------------- internal pages ---------------- */
const page = async (path, opts = {}) => {
  const m = mock(opts);
  const r = await app.fetch(req(path), assetsEnv());
  return { r, html: r.status === 200 ? await r.text() : "", ...m };
};
const SLUGS = ["about", "properties", "list-with-us", "free-valuation", "joint-venture", "nri-services"];

test("internal pages: 200, own SEO tags, one H1, shared header + footer, active nav", async () => {
  const titles = new Set();
  for (const slug of SLUGS) {
    const { r, html } = await page(`/${slug}.html`);
    assert.equal(r.status, 200, slug);
    assert.equal((html.match(/<h1\b/g) || []).length, 1, `${slug}: exactly one H1`);
    assert.ok(html.includes(`<link rel="canonical" href="${ORIGIN}/${slug}.html">`), `${slug}: canonical`);
    assert.ok(html.includes(`<meta property="og:image" content="${ORIGIN}${SITE_PAGES[slug].image}">`), `${slug}: og:image`);
    assert.ok(fs.existsSync(new URL(`..${SITE_PAGES[slug].image}`, import.meta.url)), `${slug}: og image exists`);
    const title = html.match(/<title>([^<]*)<\/title>/)[1];
    assert.ok(!titles.has(title), `${slug}: unique title`); titles.add(title);
    assert.ok(html.includes('<header id="siteHeader">') && html.includes('id="mobileNav"'), `${slug}: header`);
    assert.ok(html.includes("<footer>") && html.includes('class="wa-float"') && html.includes('id="toTop"'), `${slug}: footer`);
    assert.equal((html.match(/aria-current="page"/g) || []).length, 3, `${slug}: desktop + mobile nav + breadcrumb`);
    assert.ok(html.includes(`data-nav="${SITE_PAGES[slug].nav}" aria-current="page"`));
    assert.ok(html.includes('href="tel:+919000011111"'), `${slug}: Admin phone in header`);
    assert.ok(!/href="#(?!enquiry|properties|page-content)/.test(html), `${slug}: no homepage-only #links`);
    assert.ok(!html.includes("data-intent-link") && !html.includes("data-section="), `${slug}: no homepage-only behaviour`);
    assert.ok(html.includes('class="page-hero"') && html.includes(`/images/pages/${slug}-hero-1600.jpg`), `${slug}: hero image`);
    assert.ok(!html.includes("Join Venture"));
  }
});

test("internal pages: header and footer are byte-for-byte the homepage's (apart from links)", async () => {
  const chrome = extractChrome(INDEX);
  assert.ok(chrome.header.includes("primary-nav") && chrome.footer.includes("<footer>") && chrome.totop.includes("toTop"));
  const { html } = await page("/joint-venture.html");
  const strip = h => applyCms(chromeForPage(h, ""), normalizeSettings(SETTINGS)).replace(/\s+aria-current="page"/g, "");
  assert.ok(html.replace(/\s+aria-current="page"/g, "").includes(strip(chrome.footer)));
});

test("internal pages: forms are the homepage forms (same ids, required fields, honeypot)", async () => {
  const forms = { "list-with-us": ["listWithUsForm", "listWithUsSuccess", ["lw-name", "lw-mobile", "lw-type", "lw-location"]],
    "free-valuation": ["valuationForm", "valuationSuccess", ["fv-name", "fv-mobile", "fv-location"]],
    "joint-venture": ["jointVentureForm", "jointVentureSuccess", ["jv-name", "jv-phone", "jv-location"]],
    "nri-services": ["nriForm", "nriSuccess", ["nri-name", "nri-mobile", "nri-email", "nri-country", "nri-requirement"]] };
  for (const [slug, [form, success, ids]] of Object.entries(forms)) {
    const { html } = await page(`/${slug}.html`);
    const start = INDEX.indexOf(`<form id="${form}"`);
    const original = applyCms(INDEX.slice(start, INDEX.indexOf("</form>", start)), normalizeSettings(SETTINGS)).replace(/\s+/g, " ");
    assert.ok(html.replace(/\s+/g, " ").includes(original), `${slug}: form copied verbatim`);
    assert.ok(html.includes(`id="${success}"`) && html.includes('name="website"'));
    ids.forEach(id => assert.ok(html.includes(`id="${id}"`), `${slug}: ${id}`));
  }
  const fv = (await page("/free-valuation.html")).html;
  assert.ok(/not a certified, government-approved or legally binding valuation/.test(fv));
});

test("properties page: live listings, homepage filters, no drafts; About keeps the founder section", async () => {
  const { html } = await page("/properties.html");
  assert.equal((html.match(/class="prop-card/g) || []).length, 2);
  assert.ok(html.includes('id="propFilters"') && html.includes('data-listing="rent"'));
  const data = homeData(html);
  assert.equal(data.properties.length, 2);
  const about = (await page("/about.html")).html;
  assert.ok(about.includes('<section class="founder" id="founder"'));
  assert.ok(about.includes("/media/site-media/founder/photo.jpg"), "founder photo from Admin");
  const down = await page("/properties.html", { down: { properties: true } });
  assert.equal(down.r.status, 200);
});

test("internal pages: short URLs redirect; sitemap lists every page", async () => {
  for (const [from, to] of [["/about", "/about.html"], ["/about/", "/about.html"], ["/properties", "/properties.html"],
    ["/properties/", "/properties.html"], ["/NRI-Services.html", "/nri-services.html"]]) {
    mock();
    const r = await app.fetch(req(from), assetsEnv());
    assert.equal(r.status, 301, from);
    assert.equal(r.headers.get("Location"), `${ORIGIN}${to}`, from);
  }
  mock();
  const xml = await (await app.fetch(req("/sitemap.xml"), assetsEnv())).text();
  SLUGS.forEach(slug => assert.ok(xml.includes(`<loc>${ORIGIN}/${slug}.html</loc>`), slug));
});

test("homepage: unchanged sections, nav now opens the dedicated pages", async () => {
  const { html } = await home();
  for (const id of ["about", "properties", "why", "founder", "contact", "listWithUsModal", "valuationModal", "jointVentureModal", "nriModal", "sectionDots", "heroSearchForm"]) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  ["about", "properties", "list-with-us", "free-valuation", "joint-venture", "nri-services"].forEach(slug =>
    assert.equal((html.match(new RegExp(`href="/${slug}\\.html" (?:class="[^"]*" )?data-nav="${slug}"`, "g")) || []).length, 2, slug));
  assert.ok(!html.includes('aria-current="page"'));
});

test("property and area pages use the shared homepage header and footer", async () => {
  mock();
  const r = await app.fetch(req("/properties/2bhk-flat-nandanam/"), assetsEnv());
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.ok(html.includes('data-nav="properties" aria-current="page"'));
  assert.ok(html.includes('href="/free-valuation.html"') && html.includes('class="wa-float"'));
  assert.ok(html.includes('src="/media/site-media/branding/logo-new.png"'), "Admin logo");
  mock({ properties: [PROP, { ...PROP2, location: "Nandanam" }] });
  const a = await app.fetch(req("/areas/nandanam/"), assetsEnv());
  if (a.status === 200) assert.ok((await a.text()).includes('data-nav="properties" aria-current="page"'));
});

/* ---------------- 404 + hero copy ---------------- */
test("404.html carries the homepage header/footer (in sync with index.html)", async () => {
  const { syncedHtml } = await import("../scripts/sync-chrome.mjs");
  const nf = fs.readFileSync(new URL("../404.html", import.meta.url), "utf8");
  assert.equal(nf, syncedHtml(nf, INDEX, ""), "run: npm run sync:chrome");
  assert.ok(nf.includes('<header id="siteHeader">') && nf.includes('id="mobileNav"') && nf.includes("<footer>") && nf.includes('class="wa-float"'));
  assert.equal((nf.match(/<header\b/g) || []).length, 1);
  assert.equal((nf.match(/<footer\b/g) || []).length, 1);
  assert.ok(!/href="#(?!main")/.test(nf) && !nf.includes("data-intent-link") && !nf.includes('src="icons/'));
  assert.ok(nf.includes('src="/js/property.js"'), "mobile menu script");
});

test("Worker-rendered 404 uses the shared header/footer", async () => {
  mock();
  const r = await app.fetch(req("/properties/does-not-exist/"), assetsEnv());
  const html = await r.text();
  assert.equal(r.status, 404);
  assert.equal((html.match(/<header\b/g) || []).length, 1);
  assert.ok(html.includes('data-nav="nri-services"') && html.includes('class="wa-float"'));
});

test("hero: two-sentence headline renders one span per sentence; single sentence unchanged", async () => {
  const { heroHeadingHtml } = await import("../src/cms.js");
  assert.equal(heroHeadingHtml("Discover the Right Property. Make the Right Deal."),
    '<span class="hero-h1-part">Discover the Right Property.</span> <span class="hero-h1-part">Make the Right Deal.</span>');
  assert.equal(heroHeadingHtml("Find your next property."), "Find your next property.");
  assert.equal(heroHeadingHtml("Line one\nAccent"), 'Line one<br><span class="accent">Accent</span>');
  assert.ok(INDEX.includes("Discover the Right Property.") && INDEX.includes("Verified properties. Trusted guidance. Better real estate decisions across Chennai."));
  assert.ok(INDEX.includes("Chennai&rsquo;s Trusted Real Estate Consultants"));
});

test("every public page file contains the global header and footer (synced from index.html)", async () => {
  const { syncedHtml, CHROME_PAGES } = await import("../scripts/sync-chrome.mjs");
  assert.deepEqual(Object.keys(CHROME_PAGES).sort(),
    ["404.html", "about.html", "free-valuation.html", "joint-venture.html", "list-with-us.html", "nri-services.html", "properties.html"]);
  const { header, footer } = extractChrome(INDEX);
  for (const [file, key] of Object.entries(CHROME_PAGES)) {
    const html = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.equal(html, syncedHtml(html, INDEX, key), `${file} is out of date — run: npm run sync:chrome`);
    assert.equal((html.match(/<header id="siteHeader">/g) || []).length, 1, `${file}: one header`);
    assert.equal((html.match(/<footer>/g) || []).length, 1, `${file}: one footer`);
    // Order: header → page content → footer
    const h = html.indexOf('<header id="siteHeader">'), m = html.indexOf("<main"), f = html.indexOf("<footer>");
    assert.ok(h > 0 && h < m && m < f, `${file}: header, main, footer order`);
    assert.equal(html.slice(html.indexOf("<!--chrome:footer-->")).includes(chromeForPage(footer, key)), true, `${file}: footer matches index.html`);
    assert.ok(html.includes(chromeForPage(header, key)), `${file}: header matches index.html`);
  }
});

test("Worker serves every internal page with exactly one header and footer, even from a synced template", async () => {
  for (const slug of SLUGS) {
    const { html } = await page(`/${slug}.html`);
    assert.equal((html.match(/<header id="siteHeader">/g) || []).length, 1, slug);
    assert.equal((html.match(/<footer>/g) || []).length, 1, slug);
    assert.ok(html.includes('href="tel:+919000011111"'), `${slug}: live Admin settings applied`);
  }
});
