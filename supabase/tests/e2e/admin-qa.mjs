// TEST-ONLY end-to-end QA (headless Chromium via playwright-core).
// Real Worker (wrangler dev / workerd) at :8787 + mock Supabase at :54321
// (PostgREST + the real schema, migrations and RLS on local Postgres).
// Supabase + CDN requests are routed locally (no internet in the sandbox).
//
//   node supabase/tests/e2e/admin-qa.mjs   (needs NODE_PATH with playwright-core
//                                            and @supabase/supabase-js installed)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(path.join(process.env.E2E_MODULES || "/tmp/claude-0/e2e", "x.js"));
const { chromium } = require("playwright-core");
const SUPA_JS = fs.readFileSync(require.resolve("@supabase/supabase-js/dist/umd/supabase.js"));
const BASE = "http://127.0.0.1:8787";
const MOCK = "http://127.0.0.1:54321";
const SUPA = "https://uiirwgzyuhxyerakvzzf.supabase.co";
const SHOTS = process.env.SHOTS || "/tmp/claude-0/shots";
const PASSWORD = "test-password-123";
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (ok, label, detail = "") => {
  results.push({ ok: !!ok, label });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : "  -> " + String(detail).slice(0, 300)}`);
};
const sql = q => execFileSync("psql", ["-h", "/var/tmp/pgtest", "-p", "5433", "-U", "postgres", "-d", "e2e", "-Atq", "-c", q], { encoding: "utf8" }).trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });

async function newPage({ width = 1280, height = 900, mobile = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, acceptDownloads: true });
  const page = await context.newPage();
  const log = { errors: [], dialogs: [] };
  // Network failures for seed photos hosted on the live domain are expected
  // in the sandbox (no internet); only real script errors are counted.
  page.on("console", m => { if (m.type() === "error" && !/favicon|fonts\.g|Failed to load resource/.test(m.text())) log.errors.push(m.text()); });
  page.on("pageerror", e => log.errors.push("pageerror: " + e.message));
  page.on("dialog", async d => { log.dialogs.push(d.message()); if (d.type() === "prompt") await d.accept(""); else await d.accept(); });
  await context.route("**/*", async route => {
    const url = route.request().url();
    if (url.startsWith("https://cdn.jsdelivr.net/npm/@supabase/supabase-js")) return route.fulfill({ status: 200, contentType: "application/javascript", body: SUPA_JS });
    if (url.startsWith(SUPA)) {
      const req = route.request();
      const headers = { ...req.headers() };
      delete headers.host;
      const r = await fetch(MOCK + url.slice(SUPA.length), { method: req.method(), headers, body: ["GET", "HEAD"].includes(req.method()) ? undefined : req.postDataBuffer() });
      const body = Buffer.from(await r.arrayBuffer());
      const h = {};
      r.headers.forEach((v, k) => { if (!["content-encoding", "transfer-encoding", "content-length"].includes(k)) h[k] = v; });
      return route.fulfill({ status: r.status, headers: h, body });
    }
    if (/fonts\.(googleapis|gstatic)\.com|google\.com\/maps|maps\.google\.com|challenges\.cloudflare/.test(url)) return route.fulfill({ status: 204, body: "" });
    return route.continue();
  });
  return { page, log, context };
}

async function login(page, email) {
  await page.goto(`${BASE}/admin/login.html`);
  await page.fill("#adminEmail", email);
  await page.fill("#adminPassword", PASSWORD);
  await page.click('#adminLoginForm button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });
  await page.waitForSelector(".admin-stat-card", { timeout: 15000 });
}
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
// Waits for a NEW toast (any earlier one is removed first).
const clearToasts = page => page.evaluate(() => document.querySelectorAll(".admin-toast").forEach(t => t.remove()));
const toast = page => page.waitForSelector(".admin-toast.show", { timeout: 10000 }).then(el => el.textContent());
const act = async (page, fn) => { await clearToasts(page); await fn(); return toast(page); };

/* ===================== PUBLIC SITE ===================== */
{
  const { page, log } = await newPage();
  await page.goto(BASE + "/");
  await page.waitForSelector("#propertyGrid .prop-card");
  check(await page.textContent("#hero-heading") === "E2E hero headingAccent line", "homepage hero comes from Admin settings");
  check((await page.getAttribute(".wa-float", "href")) === "https://wa.me/919000022222", "floating WhatsApp uses Admin number");
  check(await page.$$eval("#propertyGrid .prop-card", els => els.length) === 7, "homepage shows the 7 published listings (no draft)");
  check(!(await page.content()).includes("Secret Draft"), "draft never on homepage");
  await page.click('.prop-chip[data-listing="rent"]');
  await sleep(200);
  const rentTitles = await page.$$eval("#propertyGrid .prop-title", els => els.map(e => e.textContent.trim()));
  check(rentTitles.length === 1 && /Ashok Nagar/.test(rentTitles[0]), "Rent filter uses live data", rentTitles);
  check(await page.$eval('.prop-card .btn-icon[aria-label^="Call"]', a => a.getAttribute("href")) === "tel:+919000011111", "card call button uses Admin phone");
  check(log.errors.length === 0, "homepage: no JS errors", log.errors);
  await page.screenshot({ path: `${SHOTS}/home-desktop.png` });
}
{
  const { page, log } = await newPage({ width: 375, height: 800, mobile: true });
  await page.goto(BASE + "/");
  await page.waitForSelector("#propertyGrid .prop-card");
  check(await noOverflow(page), "homepage mobile: no horizontal scroll");
  check(log.errors.length === 0, "homepage mobile: no JS errors", log.errors);
  await page.screenshot({ path: `${SHOTS}/home-mobile.png`, fullPage: false });
}
{
  const { page, log } = await newPage();
  await page.goto(BASE + "/nope-page");
  await page.waitForFunction(() => document.querySelector('[data-cms-href="tel"]').getAttribute("href").startsWith("tel:"), null, { timeout: 8000 }).catch(() => {});
  check((await page.getAttribute('[data-cms-href="tel"]', "href")) === "tel:+919000011111", "static 404 page gets contact links from /api/site-settings");
  check(log.errors.length === 0, "404 page: no JS/CSP errors", log.errors);
}
{
  const { page, log } = await newPage();
  await page.goto(BASE + "/properties/2bhk-flat-nandanam/");
  await page.fill("#enq-name", "E2E Buyer");
  await page.fill("#enq-phone", "+91 98765 11111");
  await page.click('#enquiryForm button[type="submit"]');
  await page.waitForSelector(".form-status.is-success", { timeout: 10000 }).catch(() => {});
  check(sql("select count(*) from leads where name='E2E Buyer' and property_title_snapshot='2 BHK Flat – Nandanam'") === "1", "property enquiry saved with property link");
  check(log.errors.length === 0, "property page: no JS errors", log.errors);
}

/* ===================== AUTH ===================== */
{
  const { page, log } = await newPage();
  await page.goto(`${BASE}/admin/login.html`);
  await page.click("#forgotPasswordLink");
  await page.fill("#resetEmail", "admin@test.local");
  await page.click('#forgotPasswordForm button[type="submit"]');
  await page.waitForSelector("#adminLoginNotice.show", { timeout: 8000 });
  check(/If that email belongs to a staff account/.test(await page.textContent("#adminLoginNotice")), "forgot password: generic confirmation (no account enumeration)");
  const rec = fs.existsSync("/var/tmp/pgtest/recover.log") ? fs.readFileSync("/var/tmp/pgtest/recover.log", "utf8") : "";
  check(rec.includes("admin@test.local"), "forgot password: Supabase Auth reset requested");
  check(log.errors.length === 0, "login page: no JS errors", log.errors);
  await page.click("#backToLoginLink");
  await page.fill("#adminEmail", "stranger@test.local");
  await page.fill("#adminPassword", PASSWORD);
  await page.click('#adminLoginForm button[type="submit"]');
  await page.waitForSelector("#adminLoginError.show");
  check(/staff list/.test(await page.textContent("#adminLoginError")), "non-staff account is refused at login");
}

/* ===================== ADMIN (admin role) ===================== */
const admin = await newPage();
{
  const { page, log } = admin;
  await login(page, "admin@test.local");
  const tiles = await page.$$eval(".admin-stat-card", els => els.map(e => e.textContent.replace(/\s+/g, " ").trim()));
  check(tiles.some(t => /Published 7/.test(t)), "dashboard: published count from database", tiles.join(" | "));
  check(tiles.some(t => /Open enquiries \d+/.test(t)), "dashboard: lead KPIs for admin");
  check(await page.waitForSelector("#recentActivityCard:not([hidden]) .admin-timeline-item", { timeout: 10000 }).then(() => true, () => false), "dashboard: recent activity (audit) for admin");
  check(log.errors.length === 0, "dashboard: no JS errors", log.errors);

  // --- contact settings: change → live → revert
  await page.goto(`${BASE}/admin/contact-settings.html`);
  await page.waitForFunction(() => document.getElementById("s-phone") && document.getElementById("s-phone").value);
  await page.fill("#s-instagram_url", "javascript:alert(1)");
  await page.click('#settingsForm button[type="submit"]');
  await sleep(300);
  check(await page.$eval("#s-instagram_url", el => el.closest(".admin-field").classList.contains("invalid")), "settings: unsafe URL rejected in the form");
  check(sql("select instagram_url from settings") === "https://instagram.com/e2e", "settings: nothing saved when invalid");
  await page.fill("#s-instagram_url", "https://instagram.com/e2e");
  await page.fill("#s-phone", "+91 90000 33333");
  check(/Saved/.test(await act(page, () => page.click('#settingsForm button[type="submit"]'))), "settings: phone saved");
  await sleep(5500);
  let home = await (await fetch(BASE + "/")).text();
  check(home.includes('href="tel:+919000033333"') && !home.includes("tel:+919000011111"), "contact change is live on the homepage within seconds");
  const prop = await (await fetch(BASE + "/properties/2bhk-flat-nandanam/")).text();
  check(prop.includes('href="tel:+919000033333"'), "contact change is live on property pages too");
  await page.fill("#s-phone", "+91 90000 11111");
  await act(page, () => page.click('#settingsForm button[type="submit"]'));

  // --- homepage hero
  await page.goto(`${BASE}/admin/homepage.html`);
  await page.waitForFunction(() => document.getElementById("s-hero_heading") && document.getElementById("s-hero_heading").value);
  await page.fill("#s-hero_heading", "Changed by QA");
  await act(page, () => page.click('#settingsForm button[type="submit"]'));
  await sleep(5500);
  home = await (await fetch(BASE + "/")).text();
  check(home.includes('data-cms-html="hero_heading">Changed by QA</h1>'), "hero change is live on the homepage");
  await page.fill("#s-hero_heading", "E2E hero heading\nAccent line");
  await act(page, () => page.click('#settingsForm button[type="submit"]'));
  check(log.errors.length === 0, "settings pages: no JS errors", log.errors);

  // --- leads: pagination, CRM, timeline, CSV
  await page.goto(`${BASE}/admin/leads.html`);
  await page.waitForSelector("#leadsTableBody [data-view-lead]");
  const total = Number(sql("select count(*) from leads where not is_archived"));
  check((await page.textContent("#leadResultCount")) === `Showing 1–20 of ${total} enquiries`, "leads: server-side page 1 of N", await page.textContent("#leadResultCount"));
  check(await page.$$eval("#leadsTableBody tr", r => r.length) === 20, "leads: 20 rows on the page");
  await page.click('#leadPagination [aria-label="Next page"]');
  await page.waitForFunction(() => /Showing 21–40/.test((document.getElementById("leadResultCount")?.textContent || "")));
  check(true, "leads: next page");
  await page.selectOption("#leadPageSize", "50");
  await page.waitForFunction(t => (document.getElementById("leadResultCount")?.textContent || "") === `Showing 1–${Math.min(50, t)} of ${t} enquiries`, total);
  check(true, "leads: 50 per page");
  const contacted = Number(sql("select count(*) from leads where not is_archived and status='Contacted'"));
  await page.selectOption("#leadFilterStatus", "Contacted");
  const filtered = await page.waitForFunction(n => new RegExp(`of ${n} enquir`).test((document.getElementById("leadResultCount")?.textContent || "")), contacted, { timeout: 8000 }).then(() => true, () => false);
  check(filtered && contacted < total, "leads: filter applied on the server", `${contacted} of ${total}`);
  await page.selectOption("#leadFilterStatus", "");
  await page.fill("#leadSearch", "Lead 7");
  await page.waitForFunction(() => /of \d+ enquir/.test((document.getElementById("leadResultCount")?.textContent || "")) && document.querySelectorAll("#leadsTableBody tr").length < 10);
  await page.click("#leadsTableBody [data-view-lead]");
  await page.waitForSelector("#leadCrmForm");
  await page.selectOption("#leadPrioritySelect", "high");
  await page.selectOption("#leadStatusSelect", "Qualified");
  const myLabel = await page.$eval("#leadAssignSelect", s => [...s.options].find(o => o.text.startsWith("Me")).value);
  await page.selectOption("#leadAssignSelect", myLabel);
  await page.fill("#leadFollowUpInput", new Date(Date.now() + 864e5).toISOString().slice(0, 10));
  await page.fill("#leadBudgetInput", "₹80 L");
  await page.click("#leadSaveBtn");
  await page.waitForSelector(".admin-timeline-item:has-text('Status: ')", { timeout: 10000 });
  const timeline = await page.$$eval(".admin-timeline-item", els => els.map(e => e.textContent.replace(/\s+/g, " ")));
  check(timeline.some(t => /Assigned to Me/.test(t)) && timeline.some(t => /Priority: Normal → High/.test(t)) && timeline.some(t => /Follow-up scheduled/.test(t)), "lead timeline records assignment / priority / follow-up", timeline.slice(0, 5));
  await page.fill("#leadNoteInput", "QA note =cmd");
  await page.click("#leadNoteForm button[type='submit']");
  await page.waitForSelector(".admin-timeline-note:has-text('QA note')", { timeout: 10000 });
  check(true, "lead note added to the timeline");
  await page.click("#leadDetailCloseBtn");
  await page.fill("#leadSearch", "");
  await page.waitForTimeout(600);
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#exportCsvBtn")]);
  const csv = fs.readFileSync(await download.path(), "utf8");
  const csvLines = csv.trim().split(/\r\n/);
  check(csvLines.length === total + 1 && csvLines[0].includes('"Received","Name","Phone"'), "CSV export: all filtered rows (not just the page)", csvLines.length);
  let exported = "0";
  for (let i = 0; i < 20 && exported === "0"; i++) { await sleep(250); exported = sql("select count(*) from audit_log where action='leads_exported'"); }
  check(exported !== "0", "CSV export recorded in the audit log");
  check(log.errors.length === 0, "leads page: no JS errors", log.errors);

  // --- property editor: rules, price check, workflow
  const draftId = sql("select id from properties where slug='secret-draft-kk-nagar'");
  await page.goto(`${BASE}/admin/property-edit.html?id=${draftId}`);
  await page.waitForFunction(() => (document.getElementById("propertyStateBadge")?.textContent || "New") !== "New" && document.getElementById("f-title")?.value);
  await page.waitForTimeout(50);
  check(await page.$$eval("#f-status option", os => os.find(o => o.textContent === "Rented").disabled && !os.find(o => o.textContent === "Sold").disabled), "editor: For Sale can't be set to Rented (option disabled)");
  await page.click('.pe-tab[data-tab="price"]');
  await page.fill("#f-price", "8500000");
  await page.fill("#f-display_price", "₹1.2 Cr");
  await page.waitForTimeout(100);
  check(await page.$eval("#priceCheck", el => el.classList.contains("is-warning")), "editor: price mismatch warning");
  await page.click("#suggestDisplayPrice");
  check((await page.inputValue("#f-display_price")) === "₹85 Lakh", "editor: display price generated from the number");
  check(await page.isVisible("#internalTab"), "editor: Internal tab visible to admin");
  await page.click("#internalTab");
  await page.fill("#i-owner_name", "Owner QA");
  await page.fill("#i-owner_phone", "9000012345");
  check(/saved/i.test(await act(page, () => page.click("#saveBtn"))), "editor: property + internal details saved");
  check(sql(`select owner_name from property_internal where property_id='${draftId}'`) === "Owner QA", "internal details stored in property_internal");
  const pub = await (await fetch(`${BASE}/api/site-settings`)).text() + await (await fetch(BASE + "/")).text();
  check(!pub.includes("Owner QA") && !pub.includes("9000012345"), "internal details never appear publicly");
  check(log.errors.length === 0, "property editor: no JS errors", log.errors);

  // --- featured image switch + delete with file clean-up
  const ashokId = sql("select id from properties where slug='5bhk-independent-house-ashok-nagar'");
  await page.goto(`${BASE}/admin/property-edit.html?id=${ashokId}`);
  await page.click('.pe-tab[data-tab="images"]');
  await page.waitForSelector("[data-set-featured]");
  const notFeatured = await page.$eval(".admin-image-item:not(.featured)", el => el.dataset.imageId);
  await act(page, () => page.$eval(`[data-set-featured="${notFeatured}"]`, b => b.click()));
  check(sql(`select string_agg(id::text, ',') from property_images where property_id='${ashokId}' and is_featured_image`) === notFeatured, "featured image switched atomically (exactly one)");
  const uploaded = sql(`select id from property_images where property_id='${ashokId}' and storage_path <> ''`);
  const upPath = sql(`select storage_path from property_images where id='${uploaded}'`);
  await act(page, () => page.$eval(`[data-delete-image="${uploaded}"]`, b => b.click()));
  await sleep(500);
  check(sql(`select count(*) from storage.objects where name='${upPath}'`) === "0" && sql("select count(*) from storage_cleanup_queue") === "0", "image delete removed the record AND the file (queue resolved)");
  check(sql(`select count(*) from property_images where property_id='${ashokId}' and is_featured_image`) === "1", "a featured image remains after deletion");

  // --- media library: upload a logo, use it
  await page.goto(`${BASE}/admin/media.html?tab=branding`);
  await page.waitForSelector("#assetDropzone:not([hidden])");
  await page.setInputFiles("#assetFileInput", path.resolve("icons/dgss-realty-logo-262.png"));
  await page.waitForSelector("#assetGrid .admin-media-card", { timeout: 10000 });
  const logoUrl = sql("select public_url from media_assets where category='branding' order by created_at desc limit 1");
  check(/^\/media\/site-media\/branding\/\d+-[a-z0-9]+\.png$/.test(logoUrl), "media library: logo uploaded with a safe name", logoUrl);
  await page.goto(`${BASE}/admin/settings.html`);
  await page.waitForSelector("#s-logo_url");
  await page.click(".admin-media-field button");
  await page.waitForSelector("#mediaPickerGrid [data-url]");
  await page.click("#mediaPickerGrid [data-url]");
  await act(page, () => page.click('#settingsForm button[type="submit"]'));
  await sleep(5500);
  home = await (await fetch(BASE + "/")).text();
  check(home.includes(`src="${logoUrl}" data-cms-src="logo"`) || home.includes(`src="${logoUrl}"`), "logo chosen in Admin appears in the header");
  const logoRes = await fetch(BASE + logoUrl);
  check(logoRes.status === 200 && /image\/png/.test(logoRes.headers.get("content-type")), "uploaded logo is served by the Worker");

  await page.goto(`${BASE}/admin/audit.html`);
  await page.waitForSelector("#auditBody td[data-label='What']");
  const actions = await page.$$eval("#auditBody td[data-label='What']", els => els.map(e => e.textContent));
  check(["settings changed", "featured image changed", "image deleted", "leads exported"].every(a => actions.includes(a)), "audit log lists the admin actions", actions.slice(0, 12));
  check(log.errors.length === 0, "media / audit pages: no JS errors", log.errors);
}

/* ===================== EDITOR → ADMIN workflow ===================== */
{
  const { page, log } = await newPage();
  await login(page, "editor@test.local");
  const draftId = sql("select id from properties where slug='secret-draft-kk-nagar'");
  await page.goto(`${BASE}/admin/property-edit.html?id=${draftId}`);
  await page.waitForFunction(() => (document.getElementById("propertyStateBadge")?.textContent || "New") !== "New");
  check(!(await page.isVisible("#publishBtn")) && await page.isVisible("#submitReviewBtn"), "editor: can submit for review, cannot publish");
  await act(page, () => page.click("#submitReviewBtn"));
  check(sql(`select review_status from properties where id='${draftId}'`) === "under_review", "editor: submitted for review");
  // Bypass the UI: the database must still refuse publishing.
  const r = await page.evaluate(async id => (await window.supabaseClient.from("properties").update({ is_published: true }).eq("id", id)).error?.message || "allowed", draftId);
  check(/Only an admin/.test(r), "editor: publishing via the API is refused by the database", r);
  const s = await page.evaluate(async () => (await window.supabaseClient.rpc("list_staff")).error?.message || "allowed");
  check(/super admin/i.test(s), "editor: staff list refused by the database");
  await page.goto(`${BASE}/admin/staff.html`);
  await page.waitForSelector(".admin-empty");
  check(/doesn't have access/.test(await page.textContent(".admin-empty")), "editor: staff page shows no-access");
  check(log.errors.length === 0, "editor session: no JS errors", log.errors);
}
{
  const { page } = admin;
  const draftId = sql("select id from properties where slug='secret-draft-kk-nagar'");
  await page.goto(`${BASE}/admin/properties.html?filter=review`);
  await page.waitForSelector("#propertiesTableBody tr[data-row-id], #propertiesTableBody .admin-empty");
  check((await page.textContent("#propertiesTableBody")).includes("Secret Draft"), "admin: review queue lists the submitted property");
  await page.goto(`${BASE}/admin/property-edit.html?id=${draftId}`);
  await page.waitForSelector("#approveBtn:visible");
  await act(page, () => page.click("#approveBtn"));
  check(sql(`select review_status from properties where id='${draftId}'`) === "approved", "admin: approved");
}

/* ===================== SALES ===================== */
{
  const { page, log } = await newPage();
  await login(page, "sales@test.local");
  const propId = sql("select id from properties where slug='2bhk-flat-nandanam'");
  await page.goto(`${BASE}/admin/property-edit.html?id=${propId}`);
  await page.waitForSelector("#propertyFormStatus");
  check(await page.$eval("#f-title", el => el.disabled) && !(await page.isVisible("#saveBtn")), "sales: property editor is read-only");
  const upd = await page.evaluate(async id => { const r = await window.supabaseClient.from("properties").update({ title: "hack" }).eq("id", id).select(); return r.error ? "error" : r.data.length; }, propId);
  check(upd === 0, "sales: property update blocked by RLS", upd);
  await page.goto(`${BASE}/admin/leads.html`);
  await page.waitForSelector("#leadsTableBody [data-view-lead]");
  check(await page.isVisible("#exportCsvBtn"), "sales: can work leads");
  await page.goto(`${BASE}/admin/audit.html`);
  await page.waitForSelector(".admin-empty");
  check(/doesn't have access/.test(await page.textContent(".admin-empty")), "sales: audit log not accessible");
  check(log.errors.length === 0, "sales session: no JS errors", log.errors);
}

/* ===================== SUPER ADMIN: staff ===================== */
{
  const { page, log } = await newPage();
  await login(page, "gopi@dgssrealty.com");
  await page.goto(`${BASE}/admin/staff.html`);
  await page.waitForSelector("#staffTableBody select");
  const rows = await page.$$eval("#staffTableBody tr", r => r.length);
  check(rows === 4, "staff: lists all staff with emails", rows);
  check(await page.$eval('#staffTableBody tr:has-text("gopi@") select', s => s.disabled), "staff: last super admin can't be demoted (UI)");
  await page.fill("#staffEmail", "stranger@test.local");
  await page.selectOption("#staffRole", "viewer");
  check(/Viewer access/.test(await act(page, () => page.click("#addExistingBtn"))), "staff: existing account added as viewer");
  await page.waitForSelector('#staffTableBody tr:has-text("stranger@")');
  await page.fill("#staffEmail", "newperson@test.local");
  const inviteMsg = await act(page, () => page.click('#addStaffForm button[type="submit"]'));
  check(/aren't switched on/.test(inviteMsg), "staff: invite reports missing server secret clearly (no unsafe fallback)", inviteMsg);
  const editorUid = sql("select id from auth.users where email='editor@test.local'");
  await act(page, () => page.selectOption(`[data-role-for="${editorUid}"]`, "viewer"));
  check(sql(`select role from admin_users where user_id='${editorUid}'`) === "viewer", "staff: role changed");
  await act(page, () => page.selectOption(`[data-role-for="${editorUid}"]`, "editor"));
  const strangerUid = sql("select id from auth.users where email='stranger@test.local'");
  await act(page, () => page.click(`[data-toggle-active="${strangerUid}"]`));
  check(sql(`select is_active from admin_users where user_id='${strangerUid}'`) === "f", "staff: access switched off");
  await act(page, () => page.click(`[data-revoke="${strangerUid}"]`));
  check(sql(`select count(*) from admin_users where user_id='${strangerUid}'`) === "0", "staff: removed from staff");
  check(sql("select count(*) from audit_log where actor is not null and action in ('staff_added','staff_role_changed','staff_deactivated','staff_removed')") === "5", "staff changes audited (with who did it)");
  const selfDemote = await page.evaluate(async () => {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    return (await window.supabaseClient.from("admin_users").update({ role: "admin" }).eq("user_id", session.user.id)).error?.message || "allowed";
  });
  check(/last active super_admin/.test(selfDemote), "database refuses demoting the last super admin", selfDemote);
  check(log.errors.length === 0, "staff page: no JS errors", log.errors);
}

/* ===================== MOBILE ADMIN ===================== */
{
  const { page, log } = await newPage({ width: 375, height: 812, mobile: true });
  await login(page, "admin@test.local");
  for (const [name, url, sel] of [
    ["dashboard", "/admin/dashboard.html", ".admin-stat-card"],
    ["leads", "/admin/leads.html", "#leadsTableBody [data-view-lead]"],
    ["properties", "/admin/properties.html", "#propertiesTableBody tr"],
    ["property-edit", `/admin/property-edit.html?id=${sql("select id from properties where slug='2bhk-flat-nandanam'")}`, "#f-title"],
    ["contact-settings", "/admin/contact-settings.html", "#s-phone"],
    ["media", "/admin/media.html", "#mediaGrid .admin-media-card"],
    ["audit", "/admin/audit.html", "#auditBody tr"]
  ]) {
    await page.goto(BASE + url);
    await page.waitForSelector(sel, { timeout: 15000 });
    await sleep(300);
    check(await noOverflow(page), `mobile admin (${name}): no horizontal page scroll`);
    await page.screenshot({ path: `${SHOTS}/admin-mobile-${name}.png` });
  }
  await page.goto(BASE + "/admin/leads.html");
  await page.waitForSelector("#leadsTableBody [data-view-lead]");
  await page.click("#adminMobileToggle");
  check(await page.$eval("#adminSidebar", el => el.classList.contains("open")) && (await page.getAttribute("#adminMobileToggle", "aria-expanded")) === "true", "mobile admin: menu opens (aria-expanded)");
  await page.keyboard.press("Escape");
  check(!(await page.$eval("#adminSidebar", el => el.classList.contains("open"))), "mobile admin: Esc closes the menu");
  await page.click("#leadsTableBody [data-view-lead]");
  await page.waitForSelector("#leadCrmForm");
  await page.screenshot({ path: `${SHOTS}/admin-mobile-lead-detail.png` });
  await page.keyboard.press("Escape");
  await sleep(200);
  check(!(await page.$eval("#leadDetailOverlay", el => el.classList.contains("open"))), "lead dialog: Esc closes it");
  check(log.errors.length === 0, "mobile admin: no JS errors", log.errors);
}

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
