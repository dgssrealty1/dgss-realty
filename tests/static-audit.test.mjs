// Repository-wide audits that keep the guarantees from regressing:
// one source of truth for contact details, no dead admin fields, no
// secrets in frontend code, admin never indexed, CSP-safe markup.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SETTINGS_COLUMNS } from "../src/cms.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = rel => fs.readFileSync(path.join(ROOT, rel), "utf8");
const list = (dir, ext) => fs.readdirSync(path.join(ROOT, dir)).filter(f => f.endsWith(ext)).map(f => path.join(dir, f));

const PUBLIC_FILES = ["index.html", "404.html", ...list("js", ".js"), ...list("admin", ".html"), ...list("admin/js", ".js"), "src/app.js", "src/cms.js"];
const FRONTEND_FILES = ["index.html", "404.html", ...list("js", ".js"), ...list("admin", ".html"), ...list("admin/js", ".js"), "admin/css/admin.css", "css/style.css"];
const ADMIN_PAGES = list("admin", ".html");

test("No hardcoded business contact details outside the single emergency fallback", () => {
  const banned = [
    [/98410[\s-]?09059|9841009059/, "office phone"],
    [/info@dgssrealty\.com/i, "office email"],
    [/gopivarshini7351/i, "Instagram handle"],
    [/1FGMuq63RG/, "Facebook share link"],
    [/CrMbvZicknnpp8g58/, "Google Maps short link"],
    [/Vidhya Apartments/i, "office address"]
  ];
  for (const f of PUBLIC_FILES) {
    const src = read(f);
    for (const [re, what] of banned) assert.doesNotMatch(src, re, `${what} hardcoded in ${f}`);
  }
  const defaults = read("src/site-defaults.js");
  assert.match(defaults, /EMERGENCY FALLBACK ONLY/);
});

test("No secrets or service-role keys in frontend code or config", () => {
  for (const f of FRONTEND_FILES.concat(["wrangler.jsonc"])) {
    const src = read(f);
    assert.doesNotMatch(src, /sb_secret_[A-Za-z0-9]/, `secret key in ${f}`);
    assert.doesNotMatch(src, /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/, `JWT in ${f}`);
    assert.doesNotMatch(src, /"role"\s*:\s*"service_role"/, `service_role JWT payload in ${f}`);
  }
  const wrangler = read("wrangler.jsonc");
  assert.doesNotMatch(wrangler, /SUPABASE_SERVICE_ROLE_KEY"\s*:/, "service key must be a secret, never a var");
  assert.match(read(".gitignore"), /\.dev\.vars/);
  assert.match(read(".assetsignore"), /^src$/m, "Worker source is not published as a static asset");
  assert.match(read(".assetsignore"), /^supabase$/m);
});

test("No dead settings fields: every Admin settings field is read by the public site", () => {
  const cms = read("src/cms.js");
  const seen = new Set();
  for (const page of ADMIN_PAGES) {
    const html = read(page);
    const declared = (html.match(/data-settings-fields="([^"]*)"/) || [])[1];
    if (!declared) continue;
    const fields = declared.split(",").filter(Boolean);
    const inputs = [...html.matchAll(/id="s-([a-z_]+)"/g)].map(m => m[1]);
    assert.deepEqual([...inputs].sort(), [...fields].sort(), `${page}: inputs and data-settings-fields differ`);
    for (const f of fields) {
      seen.add(f);
      assert.ok(SETTINGS_COLUMNS.includes(f), `${page}: ${f} is not fetched by the Worker (SETTINGS_COLUMNS)`);
      assert.match(cms, new RegExp(`r\\.${f}\\b`), `${page}: ${f} is fetched but never used (normalizeSettings)`);
    }
  }
  assert.ok(seen.size >= 25, `expected the settings pages to cover the settings row (${seen.size})`);
  // Each settings field is edited on exactly one page (no conflicting duplicates).
  const owners = {};
  for (const page of ADMIN_PAGES) {
    const declared = (read(page).match(/data-settings-fields="([^"]*)"/) || [])[1];
    (declared || "").split(",").filter(Boolean).forEach(f => { owners[f] = (owners[f] || []).concat(page); });
  }
  for (const [f, pages] of Object.entries(owners)) assert.equal(pages.length, 1, `${f} editable on ${pages.join(", ")}`);
});

test("No dead property fields: every editor field reaches the public page (or is staff-only by design)", () => {
  const html = read("admin/property-edit.html");
  const app = read("src/app.js");
  const editorJs = read("admin/js/admin-property-edit.js");
  const fields = [...new Set([...html.matchAll(/id="f-([a-z_]+)"/g)].map(m => m[1]))];
  assert.ok(fields.length > 40);
  for (const f of fields) {
    assert.ok(new RegExp(`\\b(p|property|r)\\.${f}\\b|"${f}"`).test(app), `f-${f} is never used by the public renderer`);
    assert.ok(editorJs.includes(`"${f}"`) || editorJs.includes(`"f-${f}"`), `f-${f} is never saved by the editor`);
  }
  // Internal (staff-only) fields must never be read by any public code.
  const internal = [...html.matchAll(/id="i-([a-z_]+)"/g)].map(m => m[1]);
  assert.ok(internal.includes("owner_phone"));
  for (const f of internal) {
    for (const pub of ["src/app.js", "src/cms.js", "js/script.js", "js/property.js", "js/common.js"]) {
      assert.doesNotMatch(read(pub), new RegExp(`\\b${f}\\b`), `internal field ${f} referenced in ${pub}`);
    }
    assert.ok(editorJs.includes(`"${f}"`) || editorJs.includes("INTERNAL_FIELDS"), `i-${f} not saved`);
  }
  const code = read("src/app.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /property_internal/, "the public Worker never queries internal data");
});

test("No dead testimonial fields: rating and photo are shown publicly", () => {
  const html = read("admin/testimonials.html");
  const app = read("src/app.js");
  for (const f of [...html.matchAll(/id="t-([a-z_]+)"/g)].map(m => m[1]).filter(f => f !== "id")) {
    assert.match(app, new RegExp(`\\b(t\\.${f}|${f})\\b`), `testimonial field ${f} never rendered`);
  }
});

test("SEO keywords are not presented as an SEO feature", () => {
  for (const f of ADMIN_PAGES.concat(["index.html"])) assert.doesNotMatch(read(f), /seo_keywords|meta name="keywords"/i, f);
  assert.doesNotMatch(read("src/app.js"), /name="keywords"/);
});

test("Admin pages are never indexed and contain no inline script", () => {
  for (const page of ADMIN_PAGES) {
    const html = read(page);
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/, page);
    for (const m of html.matchAll(/<script\b([^>]*)>/g)) assert.match(m[1], /\ssrc="/, `inline <script> in ${page}`);
    for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
      if (m[1].startsWith("http")) continue;
      assert.ok(fs.existsSync(path.join(ROOT, "admin", m[1])), `${page} loads missing ${m[1]}`);
    }
    assert.doesNotMatch(html, /\son[a-z]+="/i, `inline event handler in ${page}`);
  }
  const headers = read("_headers");
  assert.match(headers, /\/admin\/\*[\s\S]*X-Robots-Tag: noindex, nofollow/);
  assert.match(headers, /\/admin\/\*[\s\S]*frame-ancestors 'none'/);
  const robots = read("robots.txt");
  assert.match(robots, /Disallow: \/admin\//);
  assert.match(robots, /Disallow: \/api\//);
  assert.match(robots, /Sitemap: https:\/\/dgssrealty\.com\/sitemap\.xml/);
});

test("Public pages: no inline executable script (CSP has no unsafe-inline)", async () => {
  for (const f of ["index.html", "404.html"]) {
    for (const m of read(f).matchAll(/<script\b([^>]*)>/g)) {
      assert.ok(/\ssrc="/.test(m[1]) || /type="application\/(ld\+)?json"/.test(m[1]), `inline script in ${f}: ${m[0]}`);
    }
  }
  const { CSP } = await import("../src/app.js");
  assert.doesNotMatch(CSP.match(/script-src[^;]*/)[0], /unsafe-inline|unsafe-eval/);
  assert.match(CSP, /object-src 'none'/);
});

test("Homepage HTML has no stale inventory and no fallback quick-view modal", () => {
  const html = read("index.html");
  assert.doesNotMatch(html, /id="propertyModal"|id="enquiryModal"/);
  assert.match(html, /<!--cms:property-grid--><!--\/cms:property-grid-->/);
  assert.doesNotMatch(html, /supabase-js@2\/dist\/umd\/supabase\.min\.js/, "homepage no longer downloads supabase-js up front");
});

test("Every data-cms key used in markup is understood by the renderer", async () => {
  const { cmsValue, normalizeSettings } = await import("../src/cms.js");
  const s = normalizeSettings({ company_name: "X", phone: "9840012345", founder_name: "A B", founder_designation: "D", founder_photo_url: "/a.jpg",
    founder_location: "l", founder_experience: "e", founder_credential_line: "c", founder_bio_intro: "i", founder_quote: "q",
    hero_subheading: "s", hero_cta_text: "c", office_hours: "h", office_address: "addr" });
  for (const f of ["index.html", "404.html"]) {
    const html = read(f);
    for (const [, kind, key] of html.matchAll(/data-cms-(text|href|src|alt)="([a-z_]+)"/g)) {
      assert.notEqual(cmsValue(kind, key, s), null, `${f}: unknown data-cms-${kind}="${key}"`);
    }
  }
});
