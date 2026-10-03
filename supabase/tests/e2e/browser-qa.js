// Browser QA for DGSS Realty (TEST-ONLY).
// Real headless Chromium against the local Worker (wrangler dev) + mock
// Supabase (PostgREST + real RLS). Supabase + CDN requests are routed to
// local copies because this sandbox has no general internet access.
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const BASE = "http://127.0.0.1:8787";
const MOCK = "http://127.0.0.1:54321";
const SUPA = "https://uiirwgzyuhxyerakvzzf.supabase.co";
const SUPA_JS = fs.readFileSync(path.join(__dirname, "node_modules/@supabase/supabase-js/dist/umd/supabase.js"));
const SHOTS = "/var/tmp/browser/shots";
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (ok, label, detail = "") => { results.push({ ok: !!ok, label, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !detail ? "" : "  -> " + detail}`); };
const sql = q => execFileSync("psql", ["-h", "/var/tmp/pgtest", "-p", "5433", "-U", "postgres", "-d", "e2e", "-Atq", "-c", q], { encoding: "utf8" }).trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function newPage(browser, { width = 1280, height = 900, mobile = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  const log = { errors: [], csp: [], dialogs: [], requests: [], failed: [] };
  page.on("console", m => {
    const t = m.text();
    if (m.type() === "error") log.errors.push(t);
    if (/Content Security Policy|Refused to/i.test(t)) log.csp.push(t);
  });
  page.on("pageerror", e => log.errors.push("pageerror: " + e.message));
  page.on("dialog", async d => { log.dialogs.push(d.type() + ":" + d.message()); await d.accept(); });
  await page.setRequestInterception(true);
  page.on("request", async req => {
    const url = req.url();
    log.requests.push(url);
    try {
      if (url.startsWith("https://cdn.jsdelivr.net/npm/@supabase/supabase-js")) {
        return req.respond({ status: 200, contentType: "application/javascript", body: SUPA_JS });
      }
      if (url.startsWith(SUPA)) return req.continue(); // reaches the local HTTPS mock via host-resolver-rules
      if (false) {
        const target = MOCK + url.slice(SUPA.length);
        const headers = { ...req.headers() };
        delete headers.host;
        const r = await fetch(target, { method: req.method(), headers, body: ["GET", "HEAD", "OPTIONS"].includes(req.method()) ? undefined : req.postData() });
        const body = Buffer.from(await r.arrayBuffer());
        const h = {}; r.headers.forEach((v, k) => { if (!["content-encoding", "transfer-encoding"].includes(k)) h[k] = v; });
        h["access-control-allow-origin"] = "*";
        return req.respond({ status: r.status, headers: h, body });
      }
      if (/fonts\.(googleapis|gstatic)\.com|google\.com\/maps|maps\.google\.com|wa\.me/.test(url)) {
        return req.respond({ status: 204, body: "" });
      }
      return req.continue();
    } catch (e) {
      log.failed.push(url + " " + e.message);
      return req.abort();
    }
  });
  page.on("requestfailed", r => log.failed.push(r.url() + " " + (r.failure() && r.failure().errorText)));
  page.on("response", r => { if (r.status() >= 400) log.errors.push(`HTTP ${r.status()} ${r.url()}`); });
  return { page, log };
}

const overflow = page => page.evaluate(() => {
  const w = document.documentElement.clientWidth;
  const offenders = [...document.querySelectorAll("body *")].filter(el => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.right > w + 1 && r.width > 0 && st.position !== "fixed" && !el.closest(".mobile-nav,.property-modal,.pg-thumbs,.section-dots,dialog");
  }).slice(0, 5).map(el => el.tagName + "." + (el.className && el.className.baseVal === undefined ? el.className : "") + " right=" + Math.round(el.getBoundingClientRect().right));
  return { scroll: document.documentElement.scrollWidth, width: w, offenders };
});

(async () => {
  const browser = await puppeteer.launch({env:{...process.env,HTTPS_PROXY:"",HTTP_PROXY:"",https_proxy:"",http_proxy:"",ALL_PROXY:"",all_proxy:""}, executablePath: await chromium.executablePath(), headless: true,
    args: chromium.args.concat(["--host-resolver-rules=MAP uiirwgzyuhxyerakvzzf.supabase.co:443 127.0.0.1:54322", "--ignore-certificate-errors", "--no-proxy-server"]) });

  /* ---------------- HOMEPAGE ---------------- */
  {
    const { page, log } = await newPage(browser);
    await page.goto(BASE + "/", { waitUntil: "load" });
    const heroAtLoad = log.requests.filter(u => /hero-(house|villa)/.test(u));
    check(heroAtLoad.length === 0, "homepage: slides 2 & 3 not downloaded before page load", heroAtLoad.join(", "));
    check(log.requests.some(u => /hero-apartment/.test(u)), "homepage: first hero slide loads");
    await sleep(4500);
    check(log.requests.some(u => /hero-house/.test(u)), "homepage: slide 2 is fetched shortly before it's shown");
    check(!log.requests.some(u => /hero-house\.jpg$/.test(u)), "homepage: slide 2 uses AVIF/WebP, not the JPG fallback");
    const founderReq = log.requests.filter(u => /founder-photo/.test(u));
    check(!founderReq.some(u => u.endsWith("founder-photo.jpg")), "homepage: founder photo served as AVIF/WebP (not the old 1.8MB JPG)", founderReq.join(","));
    await page.waitForFunction(() => document.querySelectorAll("#propertyGrid .prop-card").length >= 7, { timeout: 8000 }).catch(() => {});
    const cards = await page.$$eval("#propertyGrid .prop-card", els => els.map(e => ({
      title: e.querySelector(".prop-title").textContent.trim(),
      href: (e.querySelector("a.prop-details-btn") || {}).getAttribute ? e.querySelector("a.prop-details-btn").getAttribute("href") : null,
      tag: e.querySelector(".prop-tag").textContent.trim(),
      chips: [...e.querySelectorAll(".prop-specs span")].map(s => s.textContent.trim())
    })));
    check(cards.length === 7, "homepage: 7 published listings from the database (draft hidden)", String(cards.length));
    check(!cards.some(c => /Secret Draft/.test(c.title)), "homepage: draft never shown");
    check(cards.every(c => c.href && c.href.startsWith("/properties/")), "homepage: every card links to its /properties/<slug>/ page");
    const land = cards.find(c => /Land/.test(c.title));
    check(land && !land.chips.some(ch => /BHK/.test(ch)), "homepage: land card shows no BHK", JSON.stringify(land));
    const soldIdx = cards.findIndex(c => c.tag === "Sold");
    check(soldIdx === cards.length - 1, "homepage: sold listing labelled Sold and listed last", JSON.stringify(cards.map(c => c.tag)));
    check(log.dialogs.length === 0, "homepage: stored XSS payloads did not execute", log.dialogs.join(";"));
    const xssText = cards.find(c => /Villa/.test(c.title));
    check(xssText && xssText.title.includes("<script>"), "homepage: injected title rendered as plain text");
    check(await page.$eval("#testimonials", el => el.hidden), "homepage: sample testimonials removed (section hidden until real ones exist)");
    await page.evaluate(() => document.getElementById("properties").scrollIntoView());
    await sleep(1200);
    const ashok = await page.$$eval("#propertyGrid .prop-card", els => {
      const card = els.find(e => /Ashok Nagar/.test(e.textContent));
      const img = card && card.querySelector(".prop-media img");
      return img ? { src: img.getAttribute("src"), w: img.naturalWidth } : null;
    });
    check(ashok && /^\/media\/property-images\/[0-9a-f-]{36}\/pub-photo\.jpg$/.test(ashok.src) && ashok.w > 0,
      "homepage: uploaded photo stored as an old public Storage URL is served via /media and loads", JSON.stringify(ashok));

    // Filters
    const count = () => page.$$eval("#propertyGrid .prop-card", els => els.length);
    await page.click('.prop-chip[data-listing="sale"]'); await sleep(150);
    const sale = await page.$$eval("#propertyGrid .prop-card .prop-tag", els => els.map(e => e.textContent.trim()));
    check(sale.length === 5 && sale.every(t => t === "For Sale"), "filter Buy: only available For Sale listings (sold excluded)", sale.join(","));
    await page.click('.prop-chip[data-listing="rent"]'); await sleep(150);
    check(await count() === 1, "filter Rent: only the rental", String(await count()));
    await page.click('.prop-chip[data-listing="land"]'); await sleep(150);
    const landTitles = await page.$$eval("#propertyGrid .prop-title", els => els.map(e => e.textContent));
    check(landTitles.length === 1 && /Land/.test(landTitles[0]), "filter Land: only land/plots", landTitles.join("|"));
    await page.click('.prop-chip[data-listing=""]'); await sleep(100);
    await page.select("#filterBhk", "2"); await sleep(150);
    const bhk2 = await page.$$eval("#propertyGrid .prop-title", els => els.map(e => e.textContent));
    check(bhk2.length === 2 && bhk2.every(t => /2 BHK/.test(t)), "filter BHK=2", bhk2.join("|"));
    const budgetVisible = await page.$eval("#filterBudget", el => !el.hidden);
    check(budgetVisible, "budget filter shown once listings have numeric prices");
    await page.click("#filterReset"); await sleep(100);
    await page.type("#filterLocation", "zzzz"); await sleep(450);
    const empty = await page.$eval("#propertyGrid", el => el.textContent);
    check(/No properties match your current search criteria/.test(empty), "empty search state message");
    await page.click("#propEmptyReset"); await sleep(150);
    check(await count() === 7, "clear filters restores all listings");

    // Hero intent buttons
    await page.click('.hero-nav-item[data-intent="rent"]'); await sleep(300);
    check(await count() === 1 && await page.$eval('.prop-chip[data-listing="rent"]', el => el.classList.contains("is-active")), "hero Rent button filters the grid");
    await page.click('.hero-nav-item[data-intent="sell"]'); await sleep(300);
    check(await page.$eval("#listWithUsModal", el => el.classList.contains("open")), "hero Sell opens the List With Us (seller) form");
    await page.keyboard.press("Escape"); await sleep(200);

    // Contact form -> database
    await page.click('.prop-chip[data-listing=""]');
    await page.type("#cf-name", "Browser Tester");
    await page.type("#cf-phone", "+91 98410 77701");
    await page.type("#cf-email", "tester@example.com");
    await page.type("#cf-message", "Looking for a 2 BHK in KK Nagar.");
    await page.click("#contactForm button[type=submit]");
    await page.waitForSelector("#formSuccess.show", { timeout: 8000 }).catch(() => {});
    check(await page.$eval("#formSuccess", el => el.classList.contains("show")), "contact form: success message");
    check(sql("select lead_type from leads where name='Browser Tester'") === "general_contact", "contact form: lead saved as general_contact");

    // Validation keeps data
    await page.type("#cf-name", "X");
    await page.type("#cf-phone", "abc");
    await page.click("#contactForm button[type=submit]"); await sleep(300);
    check(await page.$eval("#cf-phone", el => el.closest(".field").classList.contains("invalid")) && await page.$eval("#cf-name", el => el.value) === "X",
      "contact form: invalid phone flagged, typed data kept");

    // List With Us -> seller lead
    await page.click('.hero-nav-item[data-intent="sell"]'); await sleep(200);
    await page.type("#lw-name", "Owner Browser");
    await page.type("#lw-mobile", "9841077702");
    await page.select("#lw-type", "Villa");
    await page.type("#lw-location", "Injambakkam");
    await page.click("#listWithUsForm button[type=submit]");
    await page.waitForSelector("#listWithUsSuccess.show", { timeout: 8000 }).catch(() => {});
    check(sql("select lead_type||'|'||(source_details->>'Location') from leads where name='Owner Browser'") === "seller_lead|Injambakkam", "List With Us: saved as seller_lead with details");

    check(log.csp.length === 0, "homepage: no CSP violations", log.csp.join(" | "));
    check(log.errors.filter(e => !/favicon|ERR_|net::/.test(e)).length === 0, "homepage: no JS errors", log.errors.join(" | "));
    await page.close();
  }

  /* ------------- MOBILE / RESPONSIVE (homepage + property page) ------------- */
  for (const w of [320, 375, 390, 414, 768, 1024, 1440]) {
    for (const [name, url] of [["home", "/"], ["property", "/properties/2bhk-flat-nandanam/"], ["area", "/areas/uthandi/"], ["404", "/properties/nope/"]]) {
      const { page } = await newPage(browser, { width: w, height: w < 768 ? 800 : 900, mobile: w < 768 });
      await page.goto(BASE + url, { waitUntil: "networkidle0" }).catch(() => {});
      await sleep(250);
      const o = await overflow(page);
      check(o.scroll <= o.width + 1, `${name} @${w}px: no horizontal overflow`, `${o.scroll}>${o.width} ${o.offenders.join("; ")}`);
      if ([320, 390, 1440].includes(w)) await page.screenshot({ path: `${SHOTS}/${name}-${w}.png`, fullPage: name !== "home" });
      if (name === "home" && w <= 414) {
        const small = await page.evaluate(() => [...document.querySelectorAll(".prop-chip, .prop-filter-row select, .prop-filter-row input, .hero-nav-item, .btn")]
          .filter(el => el.offsetParent && !el.closest(".property-modal"))
          .map(el => el.getBoundingClientRect()).filter(r => r.height > 0 && r.height < 40).length);
        check(small === 0, `home @${w}px: filter/CTA touch targets ≥ 40px tall`, `${small} small targets`);
      }
      await page.close();
    }
  }

  /* ---------------- PROPERTY PAGE ---------------- */
  {
    const { page, log } = await newPage(browser, { width: 390, height: 844, mobile: true });
    await page.goto(BASE + "/properties/2bhk-flat-nandanam/", { waitUntil: "networkidle0" });
    check(await page.$eval("h1", h => h.textContent) === "2 BHK Flat – Nandanam", "property page: H1");
    check(await page.title() === "2 BHK Flat for Sale in Nandanam, Chennai | DGSS Realty", "property page: <title>");
    // add 2 more images so the gallery has something to page through
    await page.close();
    const pid = sql("select id from properties where slug='2bhk-flat-nandanam'");
    sql(`insert into property_images(property_id,storage_path,public_url,alt_text,sort_order) values
      ('${pid}','','https://dgssrealty.com/images/properties/prop-4-ashok-nagar.jpg','Kitchen view',1),
      ('${pid}','','https://dgssrealty.com/images/properties/prop-5-thiruvanmiyur.jpg','Hallway',2)`);
    await sleep(200);
    const r2 = await newPage(browser, { width: 390, height: 844, mobile: true });
    const p2 = r2.page;
    await p2.goto(BASE + "/properties/2bhk-flat-nandanam/", { waitUntil: "networkidle0" });
    const counter = () => p2.$eval(".pg-counter", el => el.textContent.replace(/\s+/g, " ").trim());
    check(await counter() === "1 / 3", "gallery: counter starts 1 / 3", await counter());
    check(await p2.$eval(".pg-slide.is-active .pg-featured", el => !!el).catch(() => false), "gallery: featured photo first and labelled");
    await p2.click("[data-next]"); await sleep(350);
    check(await counter() === "2 / 3", "gallery: next button", await counter());
    await p2.click("[data-prev]"); await p2.click("[data-prev]"); await sleep(350);
    check(await counter() === "3 / 3", "gallery: previous wraps around", await counter());
    await p2.click('[data-goto="1"]'); await sleep(350);
    check(await counter() === "2 / 3", "gallery: thumbnail click", await counter());
    // swipe
    const box = await p2.$eval(".pg-slides", el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await p2.touchscreen.touchStart(box.x + 100, box.y); await p2.touchscreen.touchMove(box.x - 100, box.y); await p2.touchscreen.touchEnd(); await sleep(350);
    check(await counter() === "3 / 3", "gallery: swipe left advances", await counter());
    // keyboard
    await p2.focus("[data-next]"); await p2.keyboard.press("ArrowLeft"); await sleep(300);
    check(await counter() === "2 / 3", "gallery: keyboard arrows", await counter());
    // lightbox
    await p2.click("[data-fullscreen]"); await sleep(300);
    check(await p2.$eval("#pgLightbox", d => d.open && d.querySelector("img").alt === "Kitchen view"), "gallery: full-screen lightbox with ALT text");
    await p2.keyboard.press("Escape"); await sleep(200);
    check(await p2.$eval("#pgLightbox", d => !d.open), "gallery: Esc closes lightbox");
    const imgsWithoutAlt = await p2.$$eval(".pg-slide img", els => els.filter(i => !i.alt).length);
    check(imgsWithoutAlt === 0, "gallery: every main image has ALT text");

    // WhatsApp CTA
    const wa = await p2.$eval('a[data-track="whatsapp_click"].btn', a => decodeURIComponent(a.href));
    check(wa.includes("I am interested in this property: 2 BHK Flat – Nandanam https://dgssrealty.com/properties/2bhk-flat-nandanam/"), "WhatsApp CTA carries title + canonical URL", wa);

    // Enquiry form
    await p2.type("#enq-name", "Gallery Tester");
    await p2.type("#enq-phone", "9841077703");
    await p2.click("#enquiryForm button[type=submit]");
    await p2.waitForFunction(() => /Thank you/.test(document.querySelector("#enquiryForm .form-status").textContent), { timeout: 8000 }).catch(() => {});
    check(/Thank you/.test(await p2.$eval("#enquiryForm .form-status", el => el.textContent)), "property enquiry: success message");
    check(sql("select (property_id is not null)::text||'|'||property_title_snapshot||'|'||lead_type from leads where name='Gallery Tester'") === "true|2 BHK Flat – Nandanam|buyer_enquiry",
      "property enquiry: stored with property_id, title snapshot, buyer_enquiry");
    check(r2.log.csp.length === 0, "property page: no CSP violations", r2.log.csp.join(" | "));
    check(r2.log.errors.filter(e => !/favicon|net::/.test(e)).length === 0, "property page: no JS errors", r2.log.errors.join(" | "));
    await p2.screenshot({ path: `${SHOTS}/property-gallery-390.png` });
    await p2.close();
  }

  /* ---------------- XSS property page ---------------- */
  {
    const { page, log } = await newPage(browser);
    const slug = sql("select slug from properties where title like 'Villa <script>%'");
    await page.goto(`${BASE}/properties/${slug}/`, { waitUntil: "networkidle0" });
    await page.click("[data-fullscreen]").catch(() => {});
    await sleep(300);
    check(log.dialogs.length === 0, "XSS listing page: nothing executed", log.dialogs.join(";"));
    await page.close();
  }

  /* ---------------- ADMIN ---------------- */
  async function login(email, { width = 1280 } = {}) {
    const r = await newPage(browser, { width, height: 900 });
    await r.page.goto(BASE + "/admin/login.html", { waitUntil: "networkidle0" });
    await r.page.type("#adminEmail", email);
    await r.page.type("#adminPassword", "test-password-123");
    await Promise.all([r.page.click("#adminLoginForm button[type=submit]"), sleep(1500)]);
    return r;
  }

  {
    const { page } = await login("stranger@test.local");
    const err = await page.$eval("#adminLoginError", el => el.textContent).catch(() => "");
    check(/isn't on the admin staff list/.test(err) && page.url().includes("login"), "admin: signed-up non-staff account is refused", page.url() + " " + err);
    await page.goto(BASE + "/admin/leads.html", { waitUntil: "networkidle0" }); await sleep(800);
    check(page.url().includes("login"), "admin: non-staff cannot open leads page directly", page.url());
    await page.close();
  }

  {
    const { page, log } = await login("gopi@dgssrealty.com");
    check(page.url().includes("dashboard"), "admin: super_admin logs in", page.url());
    await page.waitForFunction(() => document.getElementById("stat-active") && document.getElementById("stat-active").textContent !== "—", { timeout: 8000 }).catch(() => {});
    const stats = await page.$$eval(".admin-stat-card", els => Object.fromEntries(els.map(e => [e.querySelector(".admin-stat-label").textContent, e.querySelector(".admin-stat-value").textContent])));
    const realActive = sql("select count(*) from properties where is_published and not is_archived");
    const realDrafts = sql("select count(*) from properties where not is_published and not is_archived");
    const realNew = sql("select count(*) from leads where status='New' and not is_archived");
    check(stats["Active (Published)"] === realActive && stats["Draft Properties"] === realDrafts && stats["New Enquiries"] === realNew,
      "dashboard: numbers match the database exactly", JSON.stringify(stats) + ` db=${realActive}/${realDrafts}/${realNew}`);

    await page.goto(BASE + "/admin/leads.html", { waitUntil: "networkidle0" }); await sleep(800);
    const rows = await page.$$eval("#leadsTableBody tr", trs => trs.map(tr => tr.textContent.replace(/\s+/g, " ").trim()));
    check(rows.some(r => r.includes("<img src=x onerror=alert(document.cookie)>")), "leads: malicious lead name shown as text");
    check(log.dialogs.length === 0, "leads: stored XSS in leads did NOT execute in admin", log.dialogs.join(";"));
    check(rows.some(r => /Gallery Tester.*Buyer.*Property Enquiry.*2 BHK Flat – Nandanam/.test(r)), "leads: shows lead type + linked property", rows.find(r => /Gallery/.test(r)));
    const xssBtn = await page.$$("[data-view-lead]");
    for (const b of xssBtn) { await b.click(); await sleep(150); await page.click("#leadDetailCloseBtn"); }
    check(log.dialogs.length === 0, "leads: opening every lead detail executes nothing");
    await page.select("#leadFilterType", "seller_lead"); await sleep(200);
    const sellers = await page.$$eval("#leadsTableBody tr", trs => trs.length);
    check(sellers === Number(sql("select count(*) from leads where lead_type='seller_lead' and not is_archived")), "leads: lead-type filter", String(sellers));

    // Property editor: edit + save, publish controls, slug preview, counters
    const pid = sql("select id from properties where slug='2bhk-flat-nandanam'");
    await page.goto(`${BASE}/admin/property-edit.html?id=${pid}`, { waitUntil: "networkidle0" }); await sleep(800);
    check(await page.$eval("#slugPreview", el => el.textContent.includes("/properties/2bhk-flat-nandanam/")), "editor: slug preview shows public URL");
    check(await page.$eval("#unpublishBtn", el => el.style.display !== "none") && await page.$eval("#publishBtn", el => el.style.display === "none"),
      "editor: published property shows Unpublish (not Publish) for admin");
    await page.click('.pe-tab[data-tab="seo"]');
    await page.type("#f-seo_title", "A");
    check(/1 \/ 60/.test(await page.$eval(".admin-char-count", el => el.textContent)), "editor: SEO character counter");
    await page.click('.pe-tab[data-tab="basic"]');
    await page.$eval("#f-title", el => { el.value = ""; });
    await page.click("#saveBtn"); await sleep(400);
    check(await page.$eval("#f-title", el => el.closest(".admin-field").classList.contains("invalid")), "editor: required-field error shown inline");
    await page.type("#f-title", "2 BHK Flat – Nandanam");
    await page.click('.pe-tab[data-tab="price"]');
    await page.$eval("#f-price", el => { el.value = "19500000"; });
    await page.click("#saveBtn"); await sleep(1200);
    check(sql(`select price::bigint from properties where id='${pid}'`) === "19500000", "editor: save persists changes");
    check(sql(`select is_published from properties where id='${pid}'`) === "t", "editor: 'Save Changes' keeps a published property published");
    // ALT text on images
    await page.click('.pe-tab[data-tab="images"]'); await sleep(200);
    const altInput = await page.$(".admin-image-alt");
    if (altInput) {
      await altInput.click({ clickCount: 3 }); await altInput.type("Bright living room");
      await page.keyboard.press("Tab"); await sleep(800);
    }
    check(sql(`select count(*) from property_images where property_id='${pid}' and alt_text='Bright living room'`) === "1", "editor: image ALT text saved");

    // ---- Storage privacy (migration 04) ----
    const draftObj = sql("select name from storage.objects where name like '%/draft-photo.jpg'");
    const pubObj = sql("select name from storage.objects where name like '%/pub-photo.jpg'");
    const st = async u => (await fetch(u)).status;
    check(await st(`${BASE}/media/property-images/${draftObj}`) === 404, "storage: DRAFT photo via /media is 404 without login");
    check(await st(`${MOCK}/storage/v1/object/public/property-images/${draftObj}`) !== 200, "storage: DRAFT photo via old public Storage URL is blocked (bucket private)");
    check(await st(`${MOCK}/storage/v1/object/authenticated/property-images/${draftObj}`) !== 200, "storage: DRAFT photo via Storage API with only the public key is blocked");
    check(await st(`${BASE}/media/property-images/${pubObj}`) === 200, "storage: PUBLISHED photo loads via /media");
    const draftId0 = sql("select id from properties where slug='secret-draft-kk-nagar'");
    await page.goto(`${BASE}/admin/property-edit.html?id=${draftId0}`, { waitUntil: "networkidle0" }); await sleep(1200);
    await page.click('.pe-tab[data-tab="images"]'); await sleep(300);
    const adminImg = await page.$eval("#imageGrid img", i => ({ src: i.getAttribute("src"), w: i.naturalWidth })).catch(() => null);
    check(adminImg && /object\/sign\//.test(adminImg.src) && adminImg.w > 0, "admin: draft photo shown via short-lived signed URL", JSON.stringify(adminImg));
    // upload a new photo to the draft
    const input = await page.$("#imageFileInput");
    await input.uploadFile("/var/tmp/browser/upload.jpg");
    await page.waitForFunction(() => document.querySelectorAll("#imageGrid img").length >= 2, { timeout: 10000 }).catch(() => {});
    await sleep(800);
    const up = sql(`select public_url||'|'||storage_path from property_images where property_id='${draftId0}' and storage_path like '%/%' and storage_path not like '%draft-photo%'`);
    const [upUrl, upPath] = up.split("|");
    check(/^\/media\/property-images\/[0-9a-f-]{36}\/\d+-[a-z0-9]+\.jpg$/.test(upUrl || ""), "admin upload: stored as /media URL with a safe generated path", up);
    check(sql(`select count(*) from storage.objects where name='${upPath}'`) === "1", "admin upload: file recorded in Storage (upload policy allowed super_admin)");
    const newThumb = await page.$$eval("#imageGrid img", els => els.map(i => i.naturalWidth));
    check(newThumb.length === 2 && newThumb.every(w => w > 0), "admin upload: new draft photo visible in editor", JSON.stringify(newThumb));
    check(await st(`${BASE}${upUrl}`) === 404, "admin upload: new photo NOT public while property is a draft");
    // publish -> photo becomes public
    sql(`update properties set is_published = true where id='${draftId0}'`);
    check(await st(`${BASE}${upUrl}`) === 200, "after publish: the same photo loads publicly via /media");
    sql(`update properties set is_archived = true where id='${draftId0}'`);
    check(await st(`${BASE}${upUrl}`) === 404, "after archive: the photo is private again");
    sql(`update properties set is_published = false, is_archived = false where id='${draftId0}'`);
    // delete image -> storage object removed
    const delBtns = await page.$$("[data-delete-image]");
    await delBtns[delBtns.length - 1].click(); await sleep(1200);
    check(sql(`select count(*) from storage.objects where name='${upPath}'`) === "0" && sql(`select count(*) from property_images where storage_path='${upPath}'`) === "0",
      "admin delete: image row AND Storage file removed (no orphan)");

    // New draft: slug generated by DB, preview via Worker
    await page.goto(`${BASE}/admin/property-edit.html`, { waitUntil: "networkidle0" }); await sleep(600);
    await page.type("#f-title", "3 BHK Villa");
    await page.select("#f-category", "Villa");
    await page.select("#f-listing_type", "For Sale");
    await page.type("#f-location", "Injambakkam, ECR");
    await page.click("#saveBtn"); await sleep(1200);
    const newSlug = sql("select slug||'|'||is_published from properties where title='3 BHK Villa'");
    check(newSlug === "3-bhk-villa-injambakkam-ecr|false", "editor: new draft gets clean DB-generated slug", newSlug);
    check(await page.$eval("#previewBtn", el => el.style.display !== "none"), "editor: preview available for draft");
    const pages = browser.pages();
    await page.click("#previewBtn"); await sleep(2500);
    const all = await browser.pages();
    const previewTab = all[all.length - 1];
    const previewHtml = await previewTab.content().catch(() => "");
    check(/PREVIEW/.test(previewHtml) && /3 BHK Villa/.test(previewHtml), "editor: draft preview renders (private, via Worker + staff session)");
    if (previewTab !== page) await previewTab.close();
    const publicDraft = await fetch(`${BASE}/properties/3-bhk-villa-injambakkam-ecr/`);
    check(publicDraft.status === 404, "draft is still 404 publicly");
    check(log.errors.filter(e => !/favicon|net::|401|403|404/.test(e)).length === 0, "admin (super_admin): no JS errors", log.errors.join(" | "));
    await page.screenshot({ path: `${SHOTS}/admin-editor.png` });
    await page.close();
  }

  {
    const { page } = await login("editor@test.local");
    const nav = await page.$$eval(".admin-nav a", as => as.map(a => a.textContent.trim()));
    check(!nav.some(n => /Enquiries|Leads/.test(n)) && !nav.some(n => /^Settings$/.test(n)), "editor: Leads and Settings hidden from menu", nav.join(","));
    await page.goto(BASE + "/admin/leads.html", { waitUntil: "networkidle0" }); await sleep(800);
    check(/doesn't have access/.test(await page.$eval("#adminContent", el => el.textContent)), "editor: leads page shows no-access (RLS also returns nothing)");
    const draftId = sql("select id from properties where title='3 BHK Villa'");
    await page.goto(`${BASE}/admin/property-edit.html?id=${draftId}`, { waitUntil: "networkidle0" }); await sleep(800);
    check(await page.$eval("#publishBtn", el => el.style.display === "none"), "editor: no Publish button");
    // try to publish anyway via the API with the editor's own session
    const res = await page.evaluate(async id => {
      const { error } = await window.supabaseClient.from("properties").update({ is_published: true }).eq("id", id);
      return error ? error.message : "no error";
    }, draftId);
    check(/Only an admin can publish/.test(res) && sql(`select is_published from properties where id='${draftId}'`) === "f", "editor: publishing blocked by the database too", res);
    await page.close();
  }

  {
    const { page } = await login("sales@test.local");
    await page.goto(BASE + "/admin/leads.html", { waitUntil: "networkidle0" }); await sleep(800);
    const n = await page.$$eval("#leadsTableBody tr", trs => trs.length);
    check(n > 1, "sales: can see leads", String(n));
    const pid = sql("select id from properties where slug='2bhk-flat-nandanam'");
    await page.goto(`${BASE}/admin/property-edit.html?id=${pid}`, { waitUntil: "networkidle0" }); await sleep(800);
    check(await page.$eval("#f-title", el => el.disabled) && await page.$eval("#saveBtn", el => el.style.display === "none"), "sales: property editor is read-only");
    await page.close();
  }

  // mobile admin
  {
    const { page } = await login("gopi@dgssrealty.com", { width: 390 });
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await page.goto(BASE + "/admin/leads.html", { waitUntil: "networkidle0" }); await sleep(600);
    await page.screenshot({ path: `${SHOTS}/admin-leads-390.png` });
    const o = await overflow(page);
    check(o.scroll <= o.width + 1, "admin leads @390px: page itself doesn't overflow (table scrolls inside its card)", `${o.scroll}>${o.width} ${o.offenders.join(";")}`);
    await page.close();
  }

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
  fs.writeFileSync("/var/tmp/browser/results.json", JSON.stringify(results, null, 1));
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
