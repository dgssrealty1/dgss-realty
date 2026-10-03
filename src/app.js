/* ==========================================================================
   DGSS REALTY — CLOUDFLARE WORKER
   --------------------------------------------------------------------------
   The site is still a static site served from Workers Static Assets. This
   Worker only handles the routes that need live data (see wrangler.jsonc
   "run_worker_first"):

     GET  /  (and /index.html)   homepage: static index.html + hero, contact,
                                 logo, social links, founder, SEO, JSON-LD,
                                 live listings and testimonials from Supabase
                                 (Admin settings are the single source).
     GET  /properties/<slug>/   server-rendered property page (crawlable,
                                 shareable, own SEO + JSON-LD). 404 page for
                                 unknown/unpublished slugs, 301 for old slugs.
     GET  /areas/<area>/         area page listing live properties there
                                 (only exists when there is real inventory).
     GET  /sitemap.xml           generated from published properties.
     GET  /media/...             property photos (RLS decides) + site media.
     GET  /api/site-settings     public contact details for static pages.
     POST /api/lead              validated, rate-limited lead submission
                                 (honeypot + optional Cloudflare Turnstile),
                                 forwarded to the submit_lead() database
                                 function.
     POST /api/preview           private, no-index preview of a DRAFT property
                                 for a signed-in admin (their own session
                                 decides what they can see).
     POST /api/admin/invite-staff  super_admin only: Supabase Auth invite +
                                 staff role (optional; needs the
                                 SUPABASE_SERVICE_ROLE_KEY Worker secret).
     GET  /?property=<slug>      legacy share links -> 301 to the real URL.

   Public reads use only the publishable (anon) key — Supabase RLS decides
   what is visible. The service-role key, if configured, is a Worker
   secret used for exactly one call (sending a staff invite) after the
   caller has been verified as super_admin by the database. It is never
   sent to a browser.
   ========================================================================== */
import { SITE_DEFAULTS } from "./site-defaults.js";
import {
  normalizeSettings, publicSettings, applyCms, safeUrl,
  SETTINGS_COLUMNS, SETTINGS_COLUMNS_V1
} from "./cms.js";

const DEFAULTS = {
  SITE_ORIGIN: "https://dgssrealty.com",
  SUPABASE_URL: "https://uiirwgzyuhxyerakvzzf.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_vmxX9w4jlsBROUKBn181hA_quVr-0ts"
};

/* Area pages. `match` terms are checked against a property's location,
   locality and full address. A page only exists when at least one live
   property matches, and is only indexed (and listed in the sitemap) with
   two or more — no thin, empty SEO pages. Add areas here as inventory grows. */
export const AREAS = [
  { slug: "chennai", name: "Chennai", match: [], all: true },
  { slug: "kk-nagar", name: "K.K. Nagar", match: ["kk nagar", "k.k. nagar", "k k nagar", "k.k.nagar"] },
  { slug: "ashok-nagar", name: "Ashok Nagar", match: ["ashok nagar"] },
  { slug: "nandanam", name: "Nandanam", match: ["nandanam"] },
  { slug: "thiruvanmiyur", name: "Thiruvanmiyur", match: ["thiruvanmiyur"] },
  { slug: "velachery", name: "Velachery", match: ["velachery"] },
  { slug: "chromepet", name: "Chromepet", match: ["chromepet"] },
  { slug: "tambaram", name: "Tambaram", match: ["tambaram"] },
  { slug: "ecr", name: "ECR (East Coast Road)", match: ["ecr", "east coast road"] },
  { slug: "uthandi", name: "Uthandi", match: ["uthandi"] },
  { slug: "perambur", name: "Perambur", match: ["perambur"] }
];

const RESIDENTIAL = ["Apartment", "Flat", "Independent House", "Villa"];
const LAND = ["Residential Plot", "Land"];
const CLOSED_STATUSES = ["Sold", "Rented", "Leased"];

/* -------------------------------------------------------------------------
   Entry point
   ------------------------------------------------------------------------- */
export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (err) {
      console.error("Worker error:", err && err.stack || err);
      return htmlResponse(renderErrorPage(cfg(env), normalizeSettings(null)), 500, env, request);
    }
  }
};

export function cfg(env = {}, ctx = null) {
  return {
    origin: (env.SITE_ORIGIN || DEFAULTS.SITE_ORIGIN).replace(/\/$/, ""),
    supabaseUrl: (env.SUPABASE_URL || DEFAULTS.SUPABASE_URL).replace(/\/$/, ""),
    anonKey: env.SUPABASE_ANON_KEY || DEFAULTS.SUPABASE_ANON_KEY,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || "",
    turnstileSecret: env.TURNSTILE_SECRET_KEY || "",
    leadGate: env.LEAD_GATE_SECRET || "",
    // Optional secret (wrangler secret put SUPABASE_SERVICE_ROLE_KEY).
    // Only ever used server-side by handleStaffInvite().
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY || "",
    ctx
  };
}

async function handle(request, env, ctx) {
  const c = cfg(env, ctx);
  const url = new URL(request.url);
  const canonicalHost = new URL(c.origin).host;

  // www -> apex (one canonical domain everywhere)
  if (url.hostname === "www." + canonicalHost) {
    return Response.redirect(`${c.origin}${url.pathname}${url.search}`, 301);
  }

  const path = url.pathname;

  if (path === "/api/lead") return handleLead(request, env, c);
  if (path === "/api/preview") return handlePreview(request, env, c);
  if (path === "/api/site-settings") return handleSiteSettings(request, env, c);
  if (path === "/api/admin/invite-staff") return handleStaffInvite(request, env, c);
  if (path === "/sitemap.xml") return handleSitemap(request, env, c);
  if (path.startsWith("/media/")) return handleMedia(request, env, c, path);

  // Internal pages: /about.html, /properties.html, … are the canonical
  // URLs; /about, /about/, /properties and /properties/ redirect there.
  const pageMatch = path.match(/^\/([a-z-]+)(\.html|\/)?$/i);
  if (pageMatch && SITE_PAGES[pageMatch[1].toLowerCase()]) {
    const slug = pageMatch[1].toLowerCase();
    if (pageMatch[2] !== ".html" || pageMatch[1] !== slug) {
      return Response.redirect(`${c.origin}/${slug}.html${url.search}`, 301);
    }
    if (env.ASSETS && (request.method === "GET" || request.method === "HEAD")) {
      return handleSitePage(request, env, c, slug);
    }
  }

  // Legacy "/?property=<slug>" share links from the old modal system.
  if ((path === "/" || path === "/index.html") && url.searchParams.get("property")) {
    const slug = normalizeSlug(url.searchParams.get("property"));
    if (slug) return Response.redirect(`${c.origin}/properties/${slug}/`, 301);
  }

  if ((path === "/" || path === "/index.html") && env.ASSETS && (request.method === "GET" || request.method === "HEAD")) {
    return handleHomepage(request, env, c);
  }

  const propMatch = path.match(/^\/properties(?:\/([^/]*))?(\/?)$/i);
  if (propMatch) {
    const rawSlug = propMatch[1] ? safeDecode(propMatch[1]) : "";
    if (!rawSlug) return Response.redirect(`${c.origin}/properties.html`, 301);
    const slug = normalizeSlug(rawSlug);
    if (!slug) return notFound(c, env, request, "property");
    if (slug !== rawSlug || !propMatch[2]) {
      return Response.redirect(`${c.origin}/properties/${slug}/${url.search}`, 301);
    }
    return handlePropertyPage(request, env, c, slug);
  }

  const areaMatch = path.match(/^\/areas(?:\/([^/]*))?(\/?)$/i);
  if (areaMatch) {
    const rawSlug = areaMatch[1] ? safeDecode(areaMatch[1]).toLowerCase() : "";
    if (!rawSlug) return Response.redirect(`${c.origin}/areas/chennai/`, 301);
    if (!areaMatch[2] || rawSlug !== areaMatch[1]) {
      return Response.redirect(`${c.origin}/areas/${encodeURIComponent(rawSlug)}/`, 301);
    }
    return handleAreaPage(request, env, c, rawSlug);
  }

  // Everything else: the static site.
  if (env.ASSETS) {
    const res = await env.ASSETS.fetch(request);
    return withSecurityHeaders(res, env, request, { isAsset: true });
  }
  return notFound(c, env, request, "page");
}

/* -------------------------------------------------------------------------
   Supabase REST (anon key; RLS decides what is visible)
   ------------------------------------------------------------------------- */
async function sb(c, pathAndQuery, { token, method = "GET", body } = {}) {
  const res = await fetch(`${c.supabaseUrl}/rest/v1/${pathAndQuery}`, {
    method,
    // Supabase publishable keys go ONLY in the apikey header (they are not
    // JWTs). Authorization is sent only with a real signed-in user's JWT.
    headers: {
      apikey: c.anonKey,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Supabase ${res.status} on ${pathAndQuery.split("?")[0]}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/* ---- Cache versioning ----------------------------------------------------
   Public reads are cached at the edge (Workers Cache API) under a key that
   contains site_cache_state.version. The database bumps that version on
   every change to properties, images, settings, testimonials or slug
   redirects (migration 05), so an Admin publish / price change / photo
   change shows up within ~5 seconds instead of waiting for a TTL — while
   unchanged content keeps being served from cache. */
const VERSION_MEMO_MS = 5000;
let versionMemo = { value: null, at: 0 };
export function _resetCacheVersionMemo() { versionMemo = { value: null, at: 0 }; }

async function cacheVersion(c) {
  const now = Date.now();
  if (versionMemo.value !== null && now - versionMemo.at < VERSION_MEMO_MS) return versionMemo.value;
  let v = versionMemo.value || "0";
  try {
    const rows = await sb(c, "site_cache_state?id=eq.1&select=version");
    if (rows && rows[0] && rows[0].version != null) v = String(rows[0].version);
  } catch (err) {
    // Before migration 05 the table doesn't exist: fall back to a time
    // bucket so cached data is never older than a minute.
    v = `t${Math.floor(now / 60000)}`;
  }
  versionMemo = { value: v, at: now };
  return v;
}

function edgeCache() {
  try { return typeof caches !== "undefined" && caches.default ? caches.default : null; } catch (_) { return null; }
}

async function cachedJson(c, key, ttl, load) {
  const cache = edgeCache();
  if (!cache) return load();
  const v = await cacheVersion(c);
  const req = new Request(`${c.origin}/__cache/v${encodeURIComponent(v)}/${key}`);
  const hit = await cache.match(req).catch(() => null);
  if (hit) return hit.json();
  const data = await load();
  const put = cache.put(req, new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` }
  })).catch(() => {});
  if (c.ctx && typeof c.ctx.waitUntil === "function") c.ctx.waitUntil(put); else await put;
  return data;
}

/* Public read through the versioned cache. */
function sbPublic(c, pathAndQuery, ttl = 300) {
  return cachedJson(c, `rest/${encodeURIComponent(pathAndQuery)}`, ttl, () => sb(c, pathAndQuery));
}

const PROPERTY_SELECT = "*,property_images(id,public_url,storage_path,alt_text,caption,is_featured_image,sort_order)";
const CARD_SELECT = "id,slug,title,category,listing_type,status,location,locality,city,display_price,price,is_price_on_request,is_negotiable,bedrooms,builtup_area,land_area,plot_area,uds,floor_number,car_parking,furnishing,property_age,area_unit,is_featured,created_at,updated_at,property_images(public_url,alt_text,is_featured_image,sort_order)";

/* Settings: the single source of truth for contact details, branding,
   hero, founder and SEO defaults. Falls back to the pre-migration-05
   column list so a deploy before the migration doesn't lose settings. */
export async function getSettings(c) {
  try {
    let rows;
    try {
      rows = await sbPublic(c, `settings?id=eq.1&select=${SETTINGS_COLUMNS.join(",")}`, 300);
    } catch (err) {
      if (err.status !== 400) throw err;
      rows = await sbPublic(c, `settings?id=eq.1&select=${SETTINGS_COLUMNS_V1.join(",")}`, 300);
    }
    return normalizeSettings(rows[0] || null);
  } catch (err) {
    console.warn("Settings fetch failed, using emergency defaults:", err.message);
    return normalizeSettings(null);
  }
}

/* Accepts normalized settings, or a partial contact object (tests). */
function asSettings(x) {
  if (x && x.hero && x.seo) return x;
  const base = normalizeSettings(null);
  return { ...base, ...(x || {}), socials: { ...base.socials, ...((x && x.socials) || {}) } };
}

async function getPublishedProperty(c, slug) {
  const rows = await sbPublic(c,
    `properties?slug=eq.${encodeURIComponent(slug)}&is_published=eq.true&is_archived=eq.false` +
    `&select=${encodeURIComponent(PROPERTY_SELECT)}&limit=1`, 300);
  return rows[0] || null;
}

async function getAllPublishedCards(c) {
  const all = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const rows = await sbPublic(c,
      `properties?is_published=eq.true&is_archived=eq.false&select=${encodeURIComponent(CARD_SELECT)}` +
      `&order=created_at.desc&offset=${from}&limit=${page}`, 300);
    all.push(...rows);
    if (rows.length < page) break;
  }
  return all;
}

async function getPublishedTestimonials(c) {
  return sbPublic(c, "testimonials?is_published=eq.true&select=id,client_name,client_role,location,review,rating,photo_url&order=sort_order.asc", 300);
}

/* -------------------------------------------------------------------------
   Property page
   ------------------------------------------------------------------------- */
async function handlePropertyPage(request, env, c, slug) {
  let property;
  try {
    property = await getPublishedProperty(c, slug);
  } catch (err) {
    console.error("Property fetch failed:", err.message);
    return htmlResponse(renderErrorPage(c, null, await loadChrome(env, request)), 503, env, request);
  }

  if (!property) {
    // Old slug? -> 301 to the current URL.
    try {
      const redirects = await sbPublic(c,
        `property_slug_redirects?old_slug=eq.${encodeURIComponent(slug)}&select=properties(slug,is_published,is_archived)&limit=1`, 300);
      const target = redirects[0] && redirects[0].properties;
      if (target && target.slug && target.is_published && !target.is_archived) {
        return Response.redirect(`${c.origin}/properties/${target.slug}/`, 301);
      }
    } catch (err) {
      console.warn("Redirect lookup failed:", err.message);
    }
    return notFound(c, env, request, "property");
  }

  const [contact, all] = await Promise.all([
    getSettings(c),
    getAllPublishedCards(c).catch(() => [])
  ]);
  const related = pickRelated(property, all);
  const area = detectArea(property);
  // Only link to an area page that is itself indexable (2+ listings).
  const areaLink = area && all.filter(p => areaMatches(area, p)).length >= 2 ? area : null;
  const chrome = await loadChrome(env, request);
  const html = renderPropertyPage({ c, property, contact, related, preview: false, areaLink, chrome });
  return htmlResponse(html, 200, env, request, { cache: PAGE_CACHE });
}

function pickRelated(property, all) {
  const area = detectArea(property);
  const others = all.filter(p => p.id !== property.id && !CLOSED_STATUSES.includes(p.status));
  const sameArea = area ? others.filter(p => areaMatches(area, p)) : [];
  const rest = others.filter(p => !sameArea.includes(p));
  return sameArea.concat(rest).slice(0, 3);
}

/* -------------------------------------------------------------------------
   Area pages
   ------------------------------------------------------------------------- */
async function handleAreaPage(request, env, c, areaSlug) {
  const area = AREAS.find(a => a.slug === areaSlug);
  if (!area) return notFound(c, env, request, "page");
  let all;
  try {
    all = await getAllPublishedCards(c);
  } catch (err) {
    console.error("Area fetch failed:", err.message);
    return htmlResponse(renderErrorPage(c, null, await loadChrome(env, request)), 503, env, request);
  }
  const list = all.filter(p => areaMatches(area, p));
  if (!list.length) return notFound(c, env, request, "area");
  const contact = await getSettings(c);
  const chrome = await loadChrome(env, request);
  const html = renderAreaPage({ c, area, list, contact, allCount: all.length, chrome });
  return htmlResponse(html, 200, env, request, { cache: PAGE_CACHE });
}

export function areaMatches(area, p) {
  if (area.all) return true;
  const hay = ` ${[p.location, p.locality, p.full_address, p.title].filter(Boolean).join(" ").toLowerCase().replace(/[^a-z0-9.]+/g, " ")} `;
  return area.match.some(term => hay.includes(` ${term} `) || hay.includes(` ${term.replace(/\./g, "")} `));
}

export function detectArea(p) {
  return AREAS.find(a => !a.all && areaMatches(a, p)) || null;
}

/* -------------------------------------------------------------------------
   Sitemap
   ------------------------------------------------------------------------- */
async function handleSitemap(request, env, c) {
  const urls = [{ loc: `${c.origin}/`, changefreq: "weekly", priority: "1.0" }];
  Object.keys(SITE_PAGES).forEach(slug => urls.push({
    loc: `${c.origin}/${slug}.html`, changefreq: slug === "properties" ? "daily" : "monthly",
    priority: slug === "properties" ? "0.9" : "0.7"
  }));
  try {
    const all = await getAllPublishedCards(c);
    all.forEach(p => urls.push({
      loc: `${c.origin}/properties/${p.slug}/`,
      lastmod: (p.updated_at || p.created_at || "").slice(0, 10),
      changefreq: "weekly",
      priority: CLOSED_STATUSES.includes(p.status) ? "0.4" : "0.8"
    }));
    AREAS.forEach(a => {
      const matches = all.filter(p => areaMatches(a, p));
      if (matches.length >= 2) {
        const newest = matches.map(p => p.updated_at || p.created_at || "").sort().pop();
        urls.push({ loc: `${c.origin}/areas/${a.slug}/`, lastmod: newest.slice(0, 10), changefreq: "weekly", priority: "0.6" });
      }
    });
  } catch (err) {
    console.error("Sitemap: property fetch failed, serving homepage only:", err.message);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(u => `  <url>\n    <loc>${xmlEsc(u.loc)}</loc>\n` +
      (u.lastmod ? `    <lastmod>${xmlEsc(u.lastmod)}</lastmod>\n` : "") +
      `    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`).join("\n") +
    `\n</urlset>\n`;
  return new Response(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=0, s-maxage=300" }
  });
}

/* -------------------------------------------------------------------------
   Homepage: index.html (static asset) + live settings, listings and
   testimonials. Crawlers get the real hero, contact details, SEO tags and
   JSON-LD in the HTML itself — no client-side replacement needed.
   ------------------------------------------------------------------------- */
const PAGE_CACHE = "public, max-age=0, s-maxage=60";

async function handleHomepage(request, env, c) {
  // Conditional headers are dropped: the static file's ETag doesn't
  // change when Admin settings do, so a 304 would show stale content.
  const assetReq = new Request(new URL("/index.html", request.url).toString(), { method: "GET" });
  let asset = await env.ASSETS.fetch(assetReq);
  if (asset.status >= 300 && asset.status < 400) {
    asset = await env.ASSETS.fetch(new Request(new URL("/", request.url).toString(), { method: "GET" }));
  }
  const type = asset.headers.get("Content-Type") || "";
  if (!asset.ok || !type.startsWith("text/html")) {
    return withSecurityHeaders(asset, env, request, { isAsset: true });
  }
  const template = await asset.text();

  const [settings, cardsResult, testimonials] = await Promise.all([
    getSettings(c),
    getAllPublishedCards(c).then(rows => ({ ok: true, rows }), err => {
      console.error("Homepage listings fetch failed:", err.message);
      return { ok: false, rows: [] };
    }),
    getPublishedTestimonials(c).catch(err => { console.warn("Testimonials fetch failed:", err.message); return []; })
  ]);
  const html = renderHomepage({ c, template, settings, cards: cardsResult.rows, cardsOk: cardsResult.ok, testimonials });
  const res = new Response(request.method === "HEAD" ? null : html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": PAGE_CACHE }
  });
  return withSecurityHeaders(res, env, request, {});
}

export function homepageSeo(c, s) {
  const title = s.seo.homeTitle || s.seo.defaultTitle || `${s.company} | Real Estate Services in Chennai`;
  const description = s.seo.homeDescription || s.seo.defaultDescription ||
    `${s.company} offers real estate services in Chennai including property sales, rentals, leasing, commercial real estate and property advisory.`;
  const image = absoluteUrl(c, toMediaUrl(s.seo.ogImage)) || `${c.origin}${SITE_DEFAULTS.ogImage}`;
  return { title, description, image, canonical: `${c.origin}/` };
}

export function homepageJsonLd(c, s) {
  const ld = {
    "@context": "https://schema.org",
    "@type": "RealEstateAgent",
    name: s.company,
    url: `${c.origin}/`,
    logo: absoluteUrl(c, s.logo),
    image: homepageSeo(c, s).image,
    telephone: s.phone,
    email: s.email,
    areaServed: { "@type": "City", name: "Chennai" }
  };
  const desc = s.seo.homeDescription || s.seo.defaultDescription;
  if (desc) ld.description = desc;
  const address = postalAddress(s.address);
  if (address) ld.address = address;
  const sameAs = Object.values(s.socials).filter(Boolean);
  if (sameAs.length) ld.sameAs = sameAs;
  if (s.founder.name) ld.founder = { "@type": "Person", name: s.founder.name };
  if (s.mapsUrl) ld.hasMap = s.mapsUrl;
  return ld;
}

/* The office address is one free-text field; only facts that are really
   in it are emitted (PIN code and city when present). */
export function postalAddress(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  const a = { "@type": "PostalAddress", streetAddress: t, addressCountry: "IN" };
  const pin = t.match(/\b(\d{6})\b/);
  if (pin) a.postalCode = pin[1];
  if (/chennai/i.test(t)) { a.addressLocality = "Chennai"; a.addressRegion = "Tamil Nadu"; }
  return a;
}

function homeHeadHtml(c, s) {
  const seo = homepageSeo(c, s);
  return `
<title>${esc(seo.title)}</title>
<meta name="description" content="${esc(seo.description)}">
<link rel="canonical" href="${esc(seo.canonical)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(seo.title)}">
<meta property="og:description" content="${esc(seo.description)}">
<meta property="og:image" content="${esc(seo.image)}">
<meta property="og:url" content="${esc(seo.canonical)}">
<meta property="og:site_name" content="${esc(s.company)}">
<meta property="og:locale" content="en_IN">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(seo.title)}">
<meta name="twitter:description" content="${esc(seo.description)}">
<meta name="twitter:image" content="${esc(seo.image)}">
`;
}

function testimonialHtml(t) {
  const name = String(t.client_name || "");
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "•";
  const roleLine = [t.client_role, t.location].filter(Boolean).join(" · ");
  const rating = Number.isInteger(t.rating) && t.rating >= 1 && t.rating <= 5 ? t.rating : null;
  const photo = safeUrl(t.photo_url);
  return `
        <article class="testimonial-card reveal in">
          ${rating ? `<p class="testimonial-rating" aria-label="Rated ${rating} out of 5"><span aria-hidden="true">${"★".repeat(rating)}${"☆".repeat(5 - rating)}</span></p>` : ""}
          <p class="testimonial-quote">"${esc(t.review)}"</p>
          <div class="testimonial-person">
            ${photo
              ? `<img class="testimonial-avatar testimonial-photo" src="${esc(toMediaUrl(photo))}" alt="" width="44" height="44" loading="lazy" decoding="async">`
              : `<span class="testimonial-avatar" aria-hidden="true">${esc(initials)}</span>`}
            <div>
              <strong>${esc(name)}</strong>
              ${roleLine ? `<span>${esc(roleLine)}</span>` : ""}
            </div>
          </div>
        </article>`;
}

export function unavailableListingsHtml(s) {
  return `<div class="prop-unavailable" role="status">
          <p><strong>Property listings are temporarily unavailable.</strong> Please contact us for the latest availability.</p>
          <p class="prop-unavailable-actions">
            <a class="btn btn-primary btn-sm" href="tel:${esc(s.phone)}" data-track="call_click">Call ${esc(s.phoneDisplay)}</a>
            <a class="btn btn-outline dark btn-sm" href="https://wa.me/${esc(s.whatsapp)}" target="_blank" rel="noopener" data-track="whatsapp_click">WhatsApp Us</a>
          </p>
        </div>`;
}

/* Homepage data for js/script.js (filters, load-more). Only public card
   columns — the select list above is explicit, never "*". */
export function renderHomepage({ c, template, settings, cards, cardsOk, testimonials = [] }) {
  const s = asSettings(settings);
  const ordered = (cards || []).slice().sort((a, b) =>
    (b.is_featured ? 1 : 0) - (a.is_featured ? 1 : 0) ||
    String(b.created_at || "").localeCompare(String(a.created_at || "")));
  const grid = !cardsOk
    ? unavailableListingsHtml(s)
    : ordered.length
      ? ordered.slice(0, 24).map(p => renderCard(c, p)).join("")
      : `<p class="prop-empty">New listings are being added — check back soon, or contact us directly for current inventory.</p>`;
  const data = {
    settings: publicSettings(s),
    properties: cardsOk ? ordered : null,
    propertiesUnavailable: !cardsOk
  };
  let html = applyCms(template, s, {
    head: homeHeadHtml(c, s),
    jsonld: `\n<script type="application/ld+json">${jsonForScript(homepageJsonLd(c, s))}</script>\n`,
    "property-grid": grid,
    testimonials: testimonials.map(testimonialHtml).join(""),
    "home-data": `<script type="application/json" id="homeData">${jsonForScript(data)}</script>`
  });
  if (testimonials.length) {
    html = html.replace(/(<section\b[^>]*\bid="testimonials"[^>]*?)\s+hidden(\s|>)/, "$1$2");
  }
  return html;
}

/* -------------------------------------------------------------------------
   Internal pages (About, Properties, List With Us, Free Valuation,
   Joint Venture, NRI Services). Each is a static template (/<slug>.html).
   The header, footer and back-to-top button are NOT written in those
   files: they are copied from index.html (between the <!--chrome:…-->
   markers), so every page shares the homepage's exact header and footer.
   ------------------------------------------------------------------------- */
export const SITE_PAGES = {
  about: {
    label: "About Us", image: "/images/pages/about-hero-1600.jpg", nav: "about",
    title: "About Us – Real Estate Advisors in Chennai",
    description: "A founder-led Chennai real estate practice helping buyers, sellers, investors and landowners with clear, professional property advice."
  },
  properties: {
    label: "Properties", image: "/images/pages/properties-hero-1600.jpg", nav: "properties", listings: true,
    title: "Properties for Sale and Rent in Chennai",
    description: "Browse homes, land and commercial property to buy or rent across Chennai. Filter by listing type, location, property type, BHK and budget."
  },
  "list-with-us": {
    label: "List With Us", image: "/images/pages/list-with-us-hero-1600.jpg", nav: "list-with-us",
    title: "List Your Property for Sale or Lease in Chennai",
    description: "Sell or lease your Chennai property with DGSS Realty: property marketing, screened buyer and tenant enquiries, site visits and transaction support."
  },
  "free-valuation": {
    label: "Free Valuation", image: "/images/pages/free-valuation-hero-1600.jpg", nav: "free-valuation",
    title: "Free Property Valuation in Chennai",
    description: "Request a free, no-obligation indicative valuation of your Chennai property, based on location, condition and recent comparable deals."
  },
  "joint-venture": {
    label: "Joint Venture", image: "/images/pages/joint-venture-hero-1600.jpg", nav: "joint-venture",
    title: "Joint Venture Opportunities for Chennai Landowners",
    description: "Own land in or around Chennai? Explore joint development with DGSS Realty: land assessment, developer introductions and early JV discussions."
  },
  "nri-services": {
    label: "NRI Services", image: "/images/pages/nri-services-hero-1600.jpg", nav: "nri-services",
    title: "NRI Property Services in Chennai",
    description: "Chennai property help for NRIs: property search, site inspections, documentation coordination and local assistance to buy, sell or lease."
  }
};

export function extractChrome(indexHtml) {
  const grab = name => {
    const m = String(indexHtml || "").match(new RegExp(`<!--chrome:${name}-->([\\s\\S]*?)<!--/chrome:${name}-->`));
    return m ? m[1] : "";
  };
  return { header: grab("header"), footer: grab("footer"), totop: grab("totop") };
}

/* The homepage's header/footer use in-page links (#about, #contact) and
   homepage-only behaviour (scroll spy, Buy/Rent/Land filter links). On
   other pages those become real links, and the current page is marked. */
const FOOTER_INTENT_LINKS = {
  buy: "/properties.html?listing=sale",
  sell: "/list-with-us.html",
  rent: "/properties.html?listing=rent",
  land: "/properties.html?listing=land"
};
export function chromeForPage(fragment, activeKey) {
  return String(fragment || "")
    .replace(/href="#[a-z-]*"\s+data-intent-link="([a-z]+)"/g, (m, k) => `href="${FOOTER_INTENT_LINKS[k] || "/properties.html"}"`)
    .replace(/\sdata-section="[^"]*"/g, "")
    .replace(/href="#top"/g, 'href="/"')
    .replace(/href="#([^"]*)"/g, 'href="/#$1"')
    .replace(/(\s(?:src|srcset)=")(icons|images)\//g, "$1/$2/")
    .replace(/\saria-current="page"/g, "")
    .replace(new RegExp(`data-nav="${activeKey}"`, "g"), `data-nav="${activeKey}" aria-current="page"`);
}

/* Replaces whatever is between each pair of chrome markers (the copy
   written into the page file by scripts/sync-chrome.mjs, or nothing) with
   the current header/footer from index.html. */
export function injectChrome(template, chrome, activeKey) {
  return ["header", "footer", "totop"].reduce((html, name) =>
    html.replace(new RegExp(`<!--chrome:${name}-->[\\s\\S]*?<!--/chrome:${name}-->`),
      () => `<!--chrome:${name}-->${chromeForPage(chrome[name], activeKey)}<!--/chrome:${name}-->`), template);
}

async function fetchAssetHtml(env, request, path) {
  if (!env.ASSETS) return null;
  let res = await env.ASSETS.fetch(new Request(new URL(path, request.url).toString(), { method: "GET" }));
  const loc = res.headers.get("Location");
  if (res.status >= 300 && res.status < 400 && loc) {
    res = await env.ASSETS.fetch(new Request(new URL(loc, request.url).toString(), { method: "GET" }));
  }
  const type = res.headers.get("Content-Type") || "";
  return res.ok && type.startsWith("text/html") ? res.text() : null;
}

/* Shared chrome for Worker-rendered pages (property, area, not-found).
   Falls back to the built-in header in layout() if index.html can't be read. */
async function loadChrome(env, request) {
  try {
    const index = await fetchAssetHtml(env, request, "/index.html");
    const chrome = index && extractChrome(index);
    return chrome && chrome.header && chrome.footer ? chrome : null;
  } catch (err) {
    console.warn("Shared header/footer unavailable:", err.message);
    return null;
  }
}

export function sitePageSeo(c, s, slug) {
  const p = SITE_PAGES[slug];
  return {
    title: `${p.title} | ${s.company}`,
    description: p.description,
    canonical: `${c.origin}/${slug}.html`,
    image: `${c.origin}${p.image}`
  };
}

function sitePageHead(c, s, slug) {
  const seo = sitePageSeo(c, s, slug);
  return `
<title>${esc(seo.title)}</title>
<meta name="description" content="${esc(seo.description)}">
<link rel="canonical" href="${esc(seo.canonical)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(seo.title)}">
<meta property="og:description" content="${esc(seo.description)}">
<meta property="og:image" content="${esc(seo.image)}">
<meta property="og:url" content="${esc(seo.canonical)}">
<meta property="og:site_name" content="${esc(s.company)}">
<meta property="og:locale" content="en_IN">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(seo.title)}">
<meta name="twitter:description" content="${esc(seo.description)}">
<meta name="twitter:image" content="${esc(seo.image)}">
`;
}

function sitePageJsonLd(c, s, slug) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${c.origin}/` },
      { "@type": "ListItem", position: 2, name: SITE_PAGES[slug].label, item: `${c.origin}/${slug}.html` }
    ]
  };
}

export function renderSitePage({ c, slug, template, chrome, settings, cards = [], cardsOk = true }) {
  const s = asSettings(settings);
  const page = SITE_PAGES[slug];
  const regions = {
    head: sitePageHead(c, s, slug),
    jsonld: `\n<script type="application/ld+json">${jsonForScript(sitePageJsonLd(c, s, slug))}</script>\n`
  };
  // Same data shape the homepage uses, so js/script.js works unchanged.
  const data = { settings: publicSettings(s), properties: [], propertiesUnavailable: false };
  if (page.listings) {
    const ordered = (cards || []).slice().sort((a, b) =>
      (b.is_featured ? 1 : 0) - (a.is_featured ? 1 : 0) ||
      String(b.created_at || "").localeCompare(String(a.created_at || "")));
    regions["property-grid"] = !cardsOk
      ? unavailableListingsHtml(s)
      : ordered.length
        ? ordered.slice(0, 24).map(p => renderCard(c, p)).join("")
        : `<p class="prop-empty">New listings are being added — check back soon, or contact us directly for current inventory.</p>`;
    data.properties = cardsOk ? ordered : null;
    data.propertiesUnavailable = !cardsOk;
  }
  regions["home-data"] = `<script type="application/json" id="homeData">${jsonForScript(data)}</script>`;
  return applyCms(injectChrome(template, chrome, page.nav), s, regions);
}

async function handleSitePage(request, env, c, slug) {
  const page = SITE_PAGES[slug];
  const [template, index] = await Promise.all([
    fetchAssetHtml(env, request, `/${slug}.html`),
    fetchAssetHtml(env, request, "/index.html")
  ]);
  if (!template || !index) return notFound(c, env, request, "page");
  const [settings, cardsResult] = await Promise.all([
    getSettings(c),
    page.listings
      ? getAllPublishedCards(c).then(rows => ({ ok: true, rows }), err => {
          console.error("Properties page listings fetch failed:", err.message);
          return { ok: false, rows: [] };
        })
      : { ok: true, rows: [] }
  ]);
  const html = renderSitePage({
    c, slug, template, chrome: extractChrome(index), settings, cards: cardsResult.rows, cardsOk: cardsResult.ok
  });
  const res = new Response(request.method === "HEAD" ? null : html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": PAGE_CACHE }
  });
  return withSecurityHeaders(res, env, request, {});
}

/* -------------------------------------------------------------------------
   Public settings for static pages (404.html) — same values as above.
   ------------------------------------------------------------------------- */
async function handleSiteSettings(request, env, c) {
  if (request.method !== "GET" && request.method !== "HEAD") return json({ ok: false, error: "method_not_allowed" }, 405);
  const s = await getSettings(c);
  return new Response(JSON.stringify(publicSettings(s)), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60", "X-Content-Type-Options": "nosniff" }
  });
}

/* -------------------------------------------------------------------------
   Staff invite (super_admin only)
   1. The caller's own session must belong to an active super_admin — the
      DATABASE answers that (current_admin_role()), not this code.
   2. Supabase Auth sends the invite e-mail (needs the service key secret).
   3. The role is granted with add_staff_by_email() using the CALLER's
      session, so RLS / the function's own super_admin check apply again.
   ------------------------------------------------------------------------- */
const STAFF_ROLES = ["super_admin", "admin", "editor", "sales", "viewer"];

async function handleStaffInvite(request, env, c) {
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const origin = request.headers.get("Origin");
  if (origin) {
    let host = "";
    try { host = new URL(origin).host; } catch (_) { /* invalid */ }
    if (![new URL(c.origin).host, new URL(request.url).host].includes(host)) return json({ ok: false, error: "forbidden" }, 403);
  }
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token || token.length > 4000) return json({ ok: false, error: "sign_in_required" }, 401);

  let body;
  try { body = JSON.parse((await request.text()).slice(0, 5000)); } catch (_) { return json({ ok: false, error: "bad_request" }, 400); }
  const email = String((body && body.email) || "").trim().toLowerCase();
  const role = String((body && body.role) || "");
  const displayName = String((body && body.displayName) || "").trim().slice(0, 80);
  if (!/^[^@\s<>"']+@[^@\s<>"']+\.[a-z]{2,}$/i.test(email) || email.length > 254) return json({ ok: false, error: "invalid_email" }, 400);
  if (!STAFF_ROLES.includes(role)) return json({ ok: false, error: "invalid_role" }, 400);

  let callerRole = null;
  try {
    callerRole = await sb(c, "rpc/current_admin_role", { token, method: "POST", body: {} });
  } catch (_) { callerRole = null; }
  if (callerRole !== "super_admin") return json({ ok: false, error: "forbidden" }, 403);

  if (!c.serviceKey) return json({ ok: false, error: "invite_not_configured" }, 501);

  // New-style secret keys (sb_secret_…) go only in apikey; legacy
  // service_role JWTs are also sent as the bearer token.
  const keyHeaders = { apikey: c.serviceKey, ...(c.serviceKey.startsWith("eyJ") ? { Authorization: `Bearer ${c.serviceKey}` } : {}) };
  const redirect = `${c.origin}/admin/reset-password.html?invite=1`;
  let invited = true;
  const inv = await fetch(`${c.supabaseUrl}/auth/v1/invite?redirect_to=${encodeURIComponent(redirect)}`, {
    method: "POST",
    headers: { ...keyHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ email, data: displayName ? { display_name: displayName } : {} })
  }).catch(() => null);
  if (!inv) return json({ ok: false, error: "auth_unreachable" }, 502);
  if (!inv.ok) {
    const text = (await inv.text().catch(() => "")).toLowerCase();
    // Existing account: no e-mail is sent; the role is still granted below.
    if (inv.status === 422 || /already (been )?registered|already exists/.test(text)) invited = false;
    else { console.error("Staff invite failed:", inv.status); return json({ ok: false, error: "invite_failed" }, 502); }
  }

  let result;
  try {
    result = await sb(c, "rpc/add_staff_by_email", { token, method: "POST", body: { p_email: email, p_role: role, p_display_name: displayName || null } });
  } catch (err) {
    return json({ ok: false, error: "role_not_granted" }, err.status === 403 || err.status === 401 ? 403 : 502);
  }
  if (!result || !result.ok) return json({ ok: false, error: (result && result.error) || "role_not_granted" }, 400);
  return json({ ok: true, invited });
}

/* -------------------------------------------------------------------------
   Lead submission
   ------------------------------------------------------------------------- */
const LEAD_SOURCES = ["property_enquiry", "list_with_us", "free_valuation", "joint_venture", "nri_services", "contact_form"];
const LEAD_ERRORS = {
  invalid_name: "Please enter your name (2–100 characters).",
  invalid_phone: "Please enter a valid phone number (8–15 digits).",
  invalid_whatsapp: "Please enter a valid WhatsApp number, or leave it blank.",
  invalid_email: "Please enter a valid email address, or leave it blank.",
  message_too_long: "Your message is too long — please keep it under 2,000 characters.",
  invalid_property: "This property is no longer available. Please contact us directly.",
  invalid_details: "Some of the extra details couldn't be accepted. Please shorten them.",
  invalid_source: "Something went wrong with this form. Please call or WhatsApp us.",
  rate_limited: "We've received several enquiries from you recently. We'll be in touch — or call us directly.",
  forbidden: "Your enquiry couldn't be verified. Please try again or call us.",
  captcha_failed: "Please complete the verification check and try again.",
  bad_request: "Your enquiry couldn't be read. Please try again.",
  server_error: "We couldn't save your enquiry right now. Please call or WhatsApp us."
};

async function handleLead(request, env, c) {
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  // Same-site only: browsers always send Origin on POST.
  const origin = request.headers.get("Origin");
  const allowedHosts = [new URL(c.origin).host, "www." + new URL(c.origin).host, new URL(request.url).host];
  if (origin) {
    let host = "";
    try { host = new URL(origin).host; } catch (_) { /* invalid */ }
    if (!allowedHosts.includes(host)) return json({ ok: false, error: "forbidden", message: LEAD_ERRORS.forbidden }, 403);
  }

  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > 20000) return json({ ok: false, error: "bad_request", message: LEAD_ERRORS.bad_request }, 413);

  let body;
  try {
    const text = await request.text();
    if (text.length > 20000) throw new Error("too large");
    body = JSON.parse(text);
  } catch (_) {
    return json({ ok: false, error: "bad_request", message: LEAD_ERRORS.bad_request }, 400);
  }
  if (!body || typeof body !== "object") return json({ ok: false, error: "bad_request", message: LEAD_ERRORS.bad_request }, 400);

  // Honeypot: pretend success, store nothing.
  if (typeof body.website === "string" && body.website.trim()) return json({ ok: true });

  const source = String(body.source || "");
  if (!LEAD_SOURCES.includes(source)) return json({ ok: false, error: "invalid_source", message: LEAD_ERRORS.invalid_source }, 400);

  const ip = request.headers.get("CF-Connecting-IP") || "";

  if (c.turnstileSecret) {
    const token = String(body.turnstileToken || "");
    const ok = token && await verifyTurnstile(c.turnstileSecret, token, ip);
    if (!ok) return json({ ok: false, error: "captcha_failed", message: LEAD_ERRORS.captcha_failed }, 400);
  }

  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : null) || null;
  const details = {};
  if (body.details && typeof body.details === "object" && !Array.isArray(body.details)) {
    Object.entries(body.details).slice(0, 30).forEach(([k, v]) => {
      if (typeof v === "string" && v.trim()) details[String(k).slice(0, 60)] = v.trim().slice(0, 1000);
    });
  }
  const propertyId = typeof body.propertyId === "string" && /^[0-9a-f-]{36}$/i.test(body.propertyId) ? body.propertyId : null;

  const args = {
    p_source: source,
    p_name: str(body.name, 200),
    p_phone: str(body.phone, 40),
    p_email: str(body.email, 300),
    p_whatsapp: str(body.whatsapp, 40),
    p_message: str(body.message, 2100),
    p_property_id: propertyId,
    p_source_details: Object.keys(details).length ? details : null,
    p_gate: c.leadGate || null,
    p_client_ip: c.leadGate ? ip || null : null
  };

  let result;
  try {
    const res = await fetch(`${c.supabaseUrl}/rest/v1/rpc/submit_lead`, {
      method: "POST",
      headers: {
        apikey: c.anonKey,
        "Content-Type": "application/json",
        // The visitor's real IP for per-visitor rate limiting. Without it
        // Supabase would only see Cloudflare's shared outbound address.
        ...(ip ? { "x-dgss-client-ip": ip } : {})
      },
      body: JSON.stringify(args)
    });
    if (!res.ok) {
      console.error("submit_lead failed:", res.status, (await res.text()).slice(0, 300));
      return json({ ok: false, error: "server_error", message: LEAD_ERRORS.server_error }, 502);
    }
    result = await res.json();
  } catch (err) {
    console.error("submit_lead network error:", err.message);
    return json({ ok: false, error: "server_error", message: LEAD_ERRORS.server_error }, 502);
  }

  if (result && result.ok) return json({ ok: true });
  const code = (result && result.error) || "server_error";
  return json({ ok: false, error: code, message: LEAD_ERRORS[code] || LEAD_ERRORS.server_error }, code === "rate_limited" ? 429 : 400);
}

async function verifyTurnstile(secret, token, ip) {
  try {
    const form = new FormData();
    form.append("secret", secret);
    form.append("response", token);
    if (ip) form.append("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const data = await res.json();
    return !!data.success;
  } catch (err) {
    console.error("Turnstile verification error:", err.message);
    return false;
  }
}

/* -------------------------------------------------------------------------
   Draft preview (signed-in staff only; RLS enforces it)
   ------------------------------------------------------------------------- */
/* Draft images aren't readable through /media (the bucket is private and
   anonymous reads are limited to published listings), so the preview
   asks Supabase for short-lived signed URLs using the staff member's own
   session — Storage RLS decides whether they may see them. */
async function signPreviewImages(c, property, token) {
  const imgs = (property.property_images || []).filter(i => i.storage_path);
  if (!imgs.length) return;
  try {
    const res = await fetch(`${c.supabaseUrl}/storage/v1/object/sign/property-images`, {
      method: "POST",
      headers: { apikey: c.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 900, paths: imgs.map(i => i.storage_path) })
    });
    if (!res.ok) throw new Error(`sign ${res.status}`);
    const signed = await res.json();
    const byPath = {};
    (signed || []).forEach(s => { if (s && s.signedURL && s.path) byPath[s.path] = s.signedURL; });
    imgs.forEach(i => {
      const u = byPath[i.storage_path];
      if (u) i.public_url = u.startsWith("http") ? u : `${c.supabaseUrl}/storage/v1${u.startsWith("/") ? "" : "/"}${u}`;
    });
  } catch (err) {
    console.warn("Preview image signing failed:", err.message);
  }
}

/* -------------------------------------------------------------------------
   Images
     /media/property-images/<propertyId>/<file>   Storage RLS decides:
        photos of published, non-archived listings load; drafts 404.
        Fetched with the public (anon) key through the "authenticated"
        object endpoint. Works whether the bucket is public (before
        migration 04) or private (after).
     /media/site-media/<category>/<file>          logo, founder, homepage,
        general images (public bucket, admin-managed).
   Legacy uploads with spaces / special characters / nested folders keep
   working: each path segment is decoded, checked, and re-encoded.
   Responses are cached under the content version, so an unpublished
   listing's photos stop loading as soon as the change is saved.
   ------------------------------------------------------------------------- */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* Returns the decoded, validated segments of a stored path, or null. */
export function safeStorageSegments(rawPath) {
  const parts = String(rawPath || "").split("/");
  if (parts.length < 2 || parts.length > 4) return null;
  const out = [];
  for (const part of parts) {
    let seg;
    try { seg = decodeURIComponent(part); } catch (_) { return null; }
    if (!seg || seg.length > 200 || seg === "." || seg.includes("..")) return null;
    if (/[\/\\\u0000-\u001f\u007f]/.test(seg)) return null;
    out.push(seg);
  }
  return out;
}
const encodeSegments = segs => segs.map(encodeURIComponent).join("/");

export function parseMediaPath(path) {
  let m = path.match(/^\/media\/property-images\/(.+)$/);
  if (m) {
    const segs = safeStorageSegments(m[1]);
    if (!segs || !UUID_RE.test(segs[0])) return null;
    return { bucket: "property-images", objectPath: encodeSegments(segs) };
  }
  m = path.match(/^\/media\/site-media\/(branding|founder|homepage|general)\/([A-Za-z0-9][A-Za-z0-9._-]{0,119})$/);
  if (m && !m[2].includes("..")) return { bucket: "site-media", objectPath: `${m[1]}/${m[2]}` };
  return null;
}

async function fetchStorageObject(c, bucket, objectPath) {
  if (bucket === "site-media") {
    return fetch(`${c.supabaseUrl}/storage/v1/object/public/site-media/${objectPath}`);
  }
  let res = await fetch(`${c.supabaseUrl}/storage/v1/object/authenticated/property-images/${objectPath}`, {
    headers: { apikey: c.anonKey }
  });
  if (!res.ok) {
    // Before migration 04 (bucket still public) only the public endpoint
    // serves; once the bucket is private it can never expose a draft.
    try {
      res = await fetch(`${c.supabaseUrl}/storage/v1/object/public/property-images/${objectPath}`);
    } catch (_) { /* fall through */ }
  }
  return res;
}

async function handleMedia(request, env, c, path) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const target = parseMediaPath(path);
  if (!target) return notFound(c, env, request, "page");

  const cache = edgeCache();
  let cacheKey = null;
  if (cache) {
    const v = await cacheVersion(c);
    cacheKey = new Request(`${c.origin}/__cache/v${encodeURIComponent(v)}/media/${target.bucket}/${target.objectPath}`);
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) return request.method === "HEAD" ? new Response(null, hit) : hit;
  }

  let res;
  try {
    res = await fetchStorageObject(c, target.bucket, target.objectPath);
  } catch (err) {
    console.error("Media fetch failed:", err.message);
    return new Response("Image temporarily unavailable", { status: 503 });
  }
  if (!res || !res.ok) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=60", "X-Content-Type-Options": "nosniff" } });
  }
  const type = res.headers.get("Content-Type") || "";
  if (!/^image\/(jpeg|png|webp|avif)$/i.test(type.split(";")[0].trim())) {
    return new Response("Not found", { status: 404 });
  }
  const out = new Response(res.body, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'"
    }
  });
  if (cache && cacheKey) {
    const put = cache.put(cacheKey, out.clone()).catch(() => {});
    if (c.ctx && typeof c.ctx.waitUntil === "function") c.ctx.waitUntil(put); else await put;
  }
  return request.method === "HEAD" ? new Response(null, out) : out;
}

/* Stored image URLs may be old public Storage URLs
   (…/storage/v1/object/public/property-images/<path>) — those stop
   working once the bucket is private — so they are served through
   /media/… instead (legacy names re-encoded safely). Anything else is
   returned unchanged. */
export function toMediaUrl(u) {
  const s = String(u || "");
  const m = s.match(/\/storage\/v1\/object\/(?:public|authenticated)\/(property-images|site-media)\/([^?#]+)(?:[?#].*)?$/);
  if (!m) return s;
  const segs = safeStorageSegments(m[2]);
  if (!segs) return s;
  if (m[1] === "property-images" && !UUID_RE.test(segs[0])) return s;
  return `/media/${m[1]}/${encodeSegments(segs)}`;
}

async function handlePreview(request, env, c) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token || token.length > 4000) return new Response("Sign in required", { status: 401 });

  let id;
  try { id = (await request.json()).id; } catch (_) { /* ignore */ }
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) return new Response("Bad request", { status: 400 });

  let rows;
  try {
    rows = await sb(c, `properties?id=eq.${id}&select=${encodeURIComponent(PROPERTY_SELECT)}&limit=1`, { token });
  } catch (err) {
    return new Response("Could not load draft (are you signed in as staff?)", { status: 403 });
  }
  const property = rows[0];
  if (!property) return new Response("Not found or not allowed", { status: 404 });
  (property.property_images || []).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  await signPreviewImages(c, property, token);

  const contact = await getSettings(c);
  const html = renderPropertyPage({ c, property, contact, related: [], preview: true });
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow"
    }
  });
}

/* -------------------------------------------------------------------------
   Responses + headers
   ------------------------------------------------------------------------- */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

async function notFound(c, env, request, kind) {
  const [contact, chrome] = await Promise.all([getSettings(c), loadChrome(env, request)]);
  return htmlResponse(renderNotFoundPage({ c, kind, contact, chrome }), 404, env, request, { cache: "public, max-age=0, s-maxage=60" });
}

function htmlResponse(html, status, env, request, { cache } = {}) {
  const res = new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": cache || "no-store" }
  });
  return withSecurityHeaders(res, env, request, {});
}

export const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
  "frame-src https://www.google.com https://maps.google.com https://challenges.cloudflare.com",
  "form-action 'self' mailto:",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'"
].join("; ");

function withSecurityHeaders(res, env, request, { isAsset }) {
  // Assets already carry headers from the _headers file; only fill gaps.
  const out = new Response(res.body, res);
  const h = out.headers;
  const set = (k, v) => { if (!h.has(k)) h.set(k, v); };
  set("X-Content-Type-Options", "nosniff");
  set("Referrer-Policy", "strict-origin-when-cross-origin");
  set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  set("X-Frame-Options", "SAMEORIGIN");
  if (!isAsset && (h.get("Content-Type") || "").startsWith("text/html")) {
    set("Content-Security-Policy", CSP);
  }
  // Keep the workers.dev preview hostname (and any other non-canonical
  // host) out of search results — only the real domain should be indexed.
  const canonicalHost = new URL(cfg(env).origin).host;
  if (request && new URL(request.url).host !== canonicalHost) {
    h.set("X-Robots-Tag", "noindex, nofollow");
  }
  return out;
}

/* -------------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------------- */
export function esc(v) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function xmlEsc(v) { return esc(v); }
function safeDecode(s) { try { return decodeURIComponent(s); } catch (_) { return s; } }

export function normalizeSlug(s) {
  return String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function safeHttpUrl(u) {
  const s = String(u || "").trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : "";
}

function absoluteUrl(c, u) {
  const s = String(u || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return safeHttpUrl(s);
  if (s.startsWith("/")) return c.origin + s;
  return `${c.origin}/${s}`;
}

function decodeEntities(s) {
  return String(s).replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

/* Property descriptions: the editor accepts plain text with simple
   markdown (## headings, - bullets, blank-line paragraphs). Older rows may
   contain basic HTML. Either way the output is rebuilt from scratch: only
   a strict whitelist of tags, never any attributes, everything else
   escaped — nothing stored in the database can become executable. */
const ALLOWED_TAGS = new Set(["p", "br", "strong", "b", "em", "i", "ul", "ol", "li", "h2", "h3", "h4"]);

export function sanitizeRichText(input) {
  // Script/style blocks are removed outright, contents included.
  const s = String(input || "").replace(/<(script|style|iframe|object|embed|template)\b[\s\S]*?<\/\1\s*>/gi, "");
  if (!s.trim()) return "";
  // Block-level HTML (older rows) -> whitelist sanitizer. Anything else is
  // treated as plain text with simple markdown.
  if (/<\/?(p|ul|ol|li|h[1-6])\b/i.test(s)) {
    return s.split(/(<[^>]*>)/g).map(part => {
      const m = part.match(/^<\s*(\/?)\s*([a-z0-9]+)\b[^>]*>$/i);
      if (m) {
        let tag = m[2].toLowerCase();
        if (tag === "h1") tag = "h2";
        if (!ALLOWED_TAGS.has(tag)) return "";
        if (tag === "br") return "<br>";
        return `<${m[1]}${tag}>`;
      }
      if (part.startsWith("<")) return "";
      return esc(decodeEntities(part));
    }).join("");
  }
  return markdownLite(s);
}

function markdownLite(text) {
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n\s*\n/);
  return blocks.map(block => {
    const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
    if (!lines.length) return "";
    if (lines.every(l => /^[-*•]\s+/.test(l))) {
      return `<ul>${lines.map(l => `<li>${inline(l.replace(/^[-*•]\s+/, ""))}</li>`).join("")}</ul>`;
    }
    const out = [];
    let para = [];
    let list = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };
    const flushList = () => { if (list.length) { out.push(`<ul>${list.map(l => `<li>${inline(l)}</li>`).join("")}</ul>`); list = []; } };
    lines.forEach(l => {
      const h = l.match(/^(#{2,4})\s+(.*)$/);
      if (h) { flushPara(); flushList(); out.push(`<h3>${inline(h[2])}</h3>`); return; }
      const li = l.match(/^[-*•]\s+(.*)$/);
      if (li) { flushPara(); list.push(li[1]); return; }
      flushList(); para.push(l);
    });
    flushPara(); flushList();
    return out.join("");
  }).join("");
}

function inline(s) {
  return esc(s)
    // allow a few inline tags typed into the editor, never with attributes
    .replace(/&lt;(\/?)(b|strong|em|i)(?:\s[^<>]*?)?&gt;/gi, (m, slash, tag) => `<${slash}${tag.toLowerCase()}>`)
    .replace(/&lt;br\s*\/?&gt;/gi, "<br>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

/* ---- property facts ---- */
function featuredImage(p) {
  const imgs = sortedImages(p);
  return imgs.find(i => i.is_featured_image) || imgs[0] || null;
}
function sortedImages(p) {
  const imgs = (p.property_images || [])
    .map(i => ({ ...i, public_url: toMediaUrl(i.public_url) }))
    .filter(i => safeHttpUrl(i.public_url) || String(i.public_url || "").startsWith("/"));
  // Featured image first, then the admin's chosen order.
  return imgs.slice().sort((a, b) =>
    (b.is_featured_image ? 1 : 0) - (a.is_featured_image ? 1 : 0) || (a.sort_order || 0) - (b.sort_order || 0));
}

function isLand(p) { return LAND.includes(p.category); }

/* Admin → Specifications → Area Unit: applied when an area was typed as a
   bare number ("1200" + Sq.ft → "1200 Sq.ft"). Values that already carry
   a unit ("5.7 Grounds") are shown exactly as typed. */
export function withUnit(value, unit) {
  const v = String(value == null ? "" : value).trim();
  if (!v) return "";
  return /^[\d.,]+$/.test(v) && unit ? `${v} ${String(unit).trim()}` : v;
}
const areaOf = (p, key) => withUnit(p[key], p.area_unit);
function isResidential(p) { return RESIDENTIAL.includes(p.category); }

export function shortArea(p) {
  const area = detectArea(p);
  if (area) return area.name;
  if (p.locality) return p.locality;
  return String(p.location || "").split(/\s[–-]\s|,/)[0].trim();
}

export function listingPhrase(p) {
  return { "For Sale": "for Sale", "For Rent": "for Rent", "For Lease": "for Lease" }[p.listing_type] || "";
}

/* "2 BHK Flat – Nandanam" + location "Nandanam" -> "2 BHK Flat" */
function titleWithoutLocation(p) {
  const t = String(p.title || "").trim();
  const parts = t.split(/\s[–—-]\s/);
  if (parts.length < 2) return t;
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const tail = norm(parts.slice(1).join(" "));
  const loc = norm([p.location, p.locality].filter(Boolean).join(" "));
  return tail && loc.includes(tail.split(" ")[0]) ? parts[0].trim() : t;
}

/* SEO hierarchy for a property:
     1. the property's own SEO field (Admin → property → SEO tab)
     2. automatic text built from the property's real data
     3. the global default from Admin → SEO (only if 2 has nothing to use) */
const companyOf = s => (s && s.company) || SITE_DEFAULTS.company;

export function seoTitle(p, s) {
  if (p.seo_title && p.seo_title.trim()) return p.seo_title.trim();
  const brand = companyOf(s);
  const base = titleWithoutLocation(p);
  if (!base) return (s && s.seo && s.seo.defaultTitle) || brand;
  const city = p.city || "Chennai";
  const area = shortArea(p);
  const place = area && area.toLowerCase() !== city.toLowerCase() ? `${area}, ${city}` : city;
  const phrase = listingPhrase(p);
  let t = `${base}${phrase ? " " + phrase : ""} in ${place} | ${brand}`;
  if (t.length > 70) t = `${base}${phrase ? " " + phrase : ""} in ${area || city} | ${brand}`;
  return t;
}

export function seoDescription(p, s) {
  if (p.seo_description && p.seo_description.trim()) return p.seo_description.trim();
  if (!p.title && !p.category && s && s.seo && s.seo.defaultDescription) return s.seo.defaultDescription;
  const bits = [];
  const kind = [p.bedrooms && isResidential(p) ? `${p.bedrooms} BHK` : "", (p.category || "property").toLowerCase()]
    .filter(Boolean).join(" ");
  bits.push(`${cap(kind)} ${(listingPhrase(p) || "available").toLowerCase()} in ${p.location || shortArea(p) || p.city || "Chennai"}.`);
  const size = p.builtup_area ? `Built-up area ${areaOf(p, "builtup_area")}` : (p.land_area || p.plot_area) ? `Land area ${areaOf(p, p.land_area ? "land_area" : "plot_area")}` : "";
  if (size) bits.push(size.replace(/\.+$/, "") + ".");
  if (p.short_description) bits.push(String(p.short_description).trim().replace(/\.?$/, "."));
  const price = priceText(p);
  if (price && price !== "Price on Request") bits.push(`Price: ${price}.`);
  bits.push(`Contact ${companyOf(s)} for details or a site visit.`);
  return truncateWords(bits.join(" "), 158);
}

/* Canonical URL: the admin's value only if it points at this site (any
   scheme / www variant is normalized to the production origin);
   otherwise the property's own URL. */
export function canonicalFor(c, p) {
  const own = `${c.origin}/properties/${p.slug}/`;
  const raw = String(p.canonical_url || "").trim();
  if (!raw) return own;
  let u;
  try { u = new URL(raw); } catch (_) { return own; }
  const host = new URL(c.origin).host;
  if (!/^https?:$/.test(u.protocol) || (u.host !== host && u.host !== `www.${host}`)) return own;
  if (u.username || u.password) return own;
  const path = u.pathname.replace(/\/{2,}/g, "/");
  if (/^\/properties\/[^/]+$/.test(path)) return `${c.origin}${path}/`;
  return `${c.origin}${path}${u.search}`;
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
function truncateWords(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}

export function priceText(p) {
  if (p.is_price_on_request) return "Price on Request";
  if (p.display_price && String(p.display_price).trim()) return String(p.display_price).trim();
  const n = typeof p.price === "string" && p.price.trim() !== "" ? Number(p.price) : p.price;
  if (typeof n === "number" && n > 0) {
    return formatInr(n) + (p.listing_type === "For Rent" || p.listing_type === "For Lease" ? " / Month" : "");
  }
  return "Price on Request";
}

function formatInr(n) {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2).replace(/\.?0+$/, "")} Crore`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2).replace(/\.?0+$/, "")} Lakh`;
  return `₹${n.toLocaleString("en-IN")}`;
}

function statusLabel(p) {
  if (CLOSED_STATUSES.includes(p.status)) return p.status;
  if (p.status === "Under Offer") return "Under Offer";
  return p.listing_type || "Available";
}

/* Key facts as [label, value] — only values that exist. Land never shows
   bedrooms/bathrooms. */
export function propertyFacts(p) {
  const f = [];
  const add = (label, value) => { if (value !== null && value !== undefined && String(value).trim() !== "") f.push([label, String(value).trim()]); };
  add("Property Type", p.category);
  add("Listing", p.listing_type);
  if (!isLand(p)) {
    if (p.bedrooms) add("Bedrooms", `${p.bedrooms} BHK`);
    if (p.bathrooms) add("Bathrooms", p.bathrooms);
    if (p.balconies) add("Balconies", p.balconies);
  }
  add("Built-up Area", areaOf(p, "builtup_area"));
  add("Carpet Area", areaOf(p, "carpet_area"));
  add("Land Area", areaOf(p, "land_area"));
  add("Plot Area", areaOf(p, "plot_area"));
  add("UDS", areaOf(p, "uds"));
  if (!isLand(p)) {
    add("Floor", p.floor_number && p.total_floors ? `${p.floor_number} of ${p.total_floors}` : p.floor_number);
    add("Furnishing", p.furnishing);
    add("Car Parking", p.car_parking);
    add("Property Age", p.property_age);
  }
  add("Facing", p.facing);
  add("Possession", p.possession_status);
  add("Road Width", p.road_width);
  add("Frontage", p.frontage);
  add("Depth", p.depth);
  add("Approval", p.approval_authority);
  add("RERA", p.rera_info);
  if (p.price_per_sqft) add("Price / Sq.ft", `₹${Number(p.price_per_sqft).toLocaleString("en-IN")}`);
  add("Reference", p.reference_id);
  return f;
}

function sqftFrom(text) {
  const m = String(text || "").replace(/,/g, "").match(/([\d.]+)\s*(sq\.?\s*ft|sqft|sft|square feet)/i);
  return m ? Number(m[1]) : null;
}

/* Schema.org JSON-LD — only fields that exist in the database. */
export function buildJsonLd(c, p, images, areaLink, settings) {
  const st = asSettings(settings);
  const url = `${c.origin}/properties/${p.slug}/`;
  const area = areaLink || null;
  const imageUrls = images.map(i => absoluteUrl(c, i.public_url)).filter(Boolean);

  const address = { "@type": "PostalAddress", addressCountry: "IN" };
  if (p.full_address) address.streetAddress = p.full_address;
  const locality = p.locality || shortArea(p);
  if (locality) address.addressLocality = locality;
  if (p.city) address.addressRegion = p.state ? `${p.city}, ${p.state}` : p.city;
  else if (p.state) address.addressRegion = p.state;
  if (p.pincode) address.postalCode = p.pincode;

  const itemType = ["Apartment", "Flat"].includes(p.category) ? "Apartment"
    : ["Independent House", "Villa"].includes(p.category) ? "SingleFamilyResidence"
    : "Place";
  const item = { "@type": itemType, name: p.title, address };
  if (itemType !== "Place") {
    if (p.bedrooms) item.numberOfBedrooms = p.bedrooms;
    if (p.bathrooms) item.numberOfBathroomsTotal = p.bathrooms;
    const sqft = sqftFrom(p.builtup_area) || sqftFrom(p.carpet_area);
    if (sqft) item.floorSize = { "@type": "QuantitativeValue", value: sqft, unitCode: "FTK" };
    if (Array.isArray(p.amenities) && p.amenities.length) {
      item.amenityFeature = p.amenities.filter(a => a !== "Other").map(a => ({ "@type": "LocationFeatureSpecification", name: a, value: true }));
    }
  }
  if (typeof p.latitude === "number" && typeof p.longitude === "number") {
    item.geo = { "@type": "GeoCoordinates", latitude: p.latitude, longitude: p.longitude };
  }

  const listing = {
    "@context": "https://schema.org",
    "@type": "RealEstateListing",
    "@id": url + "#listing",
    url,
    name: p.title,
    description: seoDescription(p, st),
    about: item,
    provider: providerLd(c, st)
  };
  if (p.created_at) listing.datePosted = String(p.created_at).slice(0, 10);
  if (imageUrls.length) listing.image = imageUrls;

  const hasPrice = typeof p.price === "number" && p.price > 0 && !p.is_price_on_request;
  const closed = CLOSED_STATUSES.includes(p.status);
  if (hasPrice || closed || p.status) {
    const offer = { "@type": "Offer", url, businessFunction: p.listing_type === "For Sale" ? "http://purl.org/goodrelations/v1#Sell" : "http://purl.org/goodrelations/v1#LeaseOut" };
    if (hasPrice) { offer.price = p.price; offer.priceCurrency = "INR"; }
    offer.availability = closed ? "https://schema.org/SoldOut"
      : p.status === "Under Offer" ? "https://schema.org/LimitedAvailability"
      : "https://schema.org/InStock";
    listing.offers = offer;
  }

  const crumbs = [{ name: "Home", url: c.origin + "/" }];
  if (area) crumbs.push({ name: `Properties in ${area.name}`, url: `${c.origin}/areas/${area.slug}/` });
  else crumbs.push({ name: "Properties in Chennai", url: `${c.origin}/areas/chennai/` });
  crumbs.push({ name: p.title, url });
  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((cr, i) => ({ "@type": "ListItem", position: i + 1, name: cr.name, item: cr.url }))
  };
  return { listing, breadcrumb, crumbs };
}

/* The agency behind every listing — from Admin settings. Only public
   business details; nothing from property_internal can ever appear here
   (that table isn't readable with the public key). */
export function providerLd(c, s) {
  const provider = { "@type": "RealEstateAgent", name: s.company, url: c.origin + "/" };
  const logo = absoluteUrl(c, s.logo);
  if (logo) provider.logo = logo;
  if (s.phone) provider.telephone = s.phone;
  if (s.email) provider.email = s.email;
  const address = postalAddress(s.address);
  if (address) provider.address = address;
  return provider;
}

/* JSON inside <script> must never contain "</script" or "<!--". */
function jsonForScript(obj) {
  return JSON.stringify(obj).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

/* The site's own property photos (/images/properties/*.jpg) have AVIF and
   WebP versions at 800px and full size, so browsers get the smallest
   format and size they support. Admin-uploaded Supabase images are used
   as-is. */
function pictureHtml(c, img, attrs, alt, sizes = "(max-width: 720px) 100vw, 800px") {
  const src = absoluteUrl(c, img.public_url);
  const rel = src.startsWith(c.origin + "/") ? src.slice(c.origin.length) : null;
  const imgTag = `<img src="${esc(rel || src)}" alt="${esc(alt)}" ${attrs}>`;
  const m = rel && rel.match(/^(\/images\/properties\/[a-z0-9-]+)\.jpe?g$/i);
  if (m) {
    const b = esc(m[1]);
    return `<picture>` +
      `<source type="image/avif" srcset="${b}-800.avif 800w, ${b}.avif 1400w" sizes="${esc(sizes)}">` +
      `<source type="image/webp" srcset="${b}-800.webp 800w, ${b}.webp 1400w" sizes="${esc(sizes)}">` +
      `${imgTag}</picture>`;
  }
  return imgTag;
}

/* -------------------------------------------------------------------------
   HTML: shared layout
   ------------------------------------------------------------------------- */
const ICONS = {
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.34 1.79.65 2.65a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.43-1.22a2 2 0 0 1 2.11-.45c.86.31 1.75.53 2.65.65A2 2 0 0 1 22 16.92z"/>',
  wa: '<path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3 20l1-5.4A8.5 8.5 0 1 1 21 11.5z"/>',
  pin: '<path d="M21 10c0 7-9 12-9 12s-9-5-9-12a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="10.5" x2="15.4" y2="6.5"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  prev: '<path d="m15 18-6-6 6-6"/>',
  next: '<path d="m9 18 6-6-6-6"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'
};
function icon(name, extra = "") {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" ${extra}>${ICONS[name]}</svg>`;
}

function socialLinksHtml(s, cls) {
  const items = [
    ["instagram", "Instagram", '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1"/>'],
    ["facebook", "Facebook", '<path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>'],
    ["youtube", "YouTube", '<path d="M22.5 7.2a3 3 0 0 0-2.1-2.1C18.5 4.6 12 4.6 12 4.6s-6.5 0-8.4.5A3 3 0 0 0 1.5 7.2 31 31 0 0 0 1 12a31 31 0 0 0 .5 4.8 3 3 0 0 0 2.1 2.1c1.9.5 8.4.5 8.4.5s6.5 0 8.4-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 23 12a31 31 0 0 0-.5-4.8z"/><path d="m10 15 5-3-5-3z"/>']
  ].filter(([k]) => s.socials[k]);
  if (!items.length) return "";
  return `<div class="${cls}">${items.map(([k, label, path]) =>
    `<a href="${esc(s.socials[k])}" target="_blank" rel="noopener" aria-label="${esc(s.company)} on ${label}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false">${path}</svg></a>`).join("")}</div>`;
}

function layout({ c, title, description, canonical, ogImage, ogType = "website", robots, jsonLd = [], body, contact, preview, extraHead = "", chrome = null, activeNav = "" }) {
  const s = asSettings(contact);
  // Shared homepage header/footer (see loadChrome); the markup below is
  // only a fallback for when index.html can't be read.
  const sharedHeader = chrome ? applyCms(chromeForPage(chrome.header, activeNav), s) : "";
  const sharedFooter = chrome ? applyCms(chromeForPage(chrome.footer + "\n" + (chrome.totop || ""), activeNav), s) : "";
  const og = ogImage ? absoluteUrl(c, ogImage) : (absoluteUrl(c, toMediaUrl(s.seo.ogImage)) || `${c.origin}${SITE_DEFAULTS.ogImage}`);
  const logo = s.logo || SITE_DEFAULTS.logo;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${preview ? `<base href="${esc(c.origin)}/">` : ""}
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${robots ? `<meta name="robots" content="${esc(robots)}">` : ""}
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ""}
<meta property="og:type" content="${esc(ogType)}">
<meta property="og:site_name" content="${esc(s.company)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
${canonical ? `<meta property="og:url" content="${esc(canonical)}">` : ""}
<meta property="og:image" content="${esc(og)}">
<meta property="og:locale" content="en_IN">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(og)}">
<link rel="icon" type="image/png" href="/icons/dgss-realty-favicon-32.png">
<link rel="apple-touch-icon" href="/icons/dgss-realty-icon.png">
<link rel="preload" href="/fonts/plus-jakarta-sans-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/manrope-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/css/style.css">
<link rel="stylesheet" href="/css/property.css">
${extraHead}
${jsonLd.map(j => `<script type="application/ld+json">${jsonForScript(j)}</script>`).join("\n")}
</head>
<body class="subpage">
<a class="skip-link" href="#main">Skip to content</a>
${preview ? `<div class="preview-banner" role="status">PREVIEW — this is how the page will look. It is not public until published.</div>` : ""}
${sharedHeader || `<header id="siteHeader">
  <div class="container">
    <a href="/" class="brand" aria-label="${esc(s.company)} home">
      <img src="${esc(logo)}" class="brand-logo-img" alt="${esc(s.company)}" width="131" height="44">
    </a>
    <nav class="primary-nav" aria-label="Primary navigation">
      <a href="/">Home</a>
      <a href="/about.html">About Us</a>
      <a href="/properties.html">Properties</a>
      <a href="/list-with-us.html">List With Us</a>
      <a href="/free-valuation.html">Free Valuation</a>
      <a href="/joint-venture.html">Joint Venture</a>
      <a href="/nri-services.html">NRI Services</a>
      <a href="/admin/login.html">Admin</a>
    </nav>
    <div class="nav-actions">
      <a class="icon-btn" href="tel:${esc(s.phone)}" aria-label="Call ${esc(s.company)}" data-track="call_click">${icon("phone")}</a>
      <a class="icon-btn" href="https://wa.me/${esc(s.whatsapp)}" target="_blank" rel="noopener" aria-label="Chat with ${esc(s.company)} on WhatsApp" data-track="whatsapp_click">${icon("wa")}</a>
      <button class="hamburger" id="hamburger" aria-label="Open menu" aria-expanded="false" aria-controls="mobileNav"><span></span><span></span><span></span></button>
    </div>
  </div>
</header>
<div class="mobile-nav-overlay" id="mobileNavOverlay"></div>
<nav class="mobile-nav" id="mobileNav" aria-label="Mobile navigation">
  <button class="mobile-nav-close" id="mobileNavClose" aria-label="Close menu">${icon("close")}</button>
  <div class="mobile-nav-links">
    <a href="/">Home</a>
    <a href="/about.html">About Us</a>
    <a href="/properties.html">Properties</a>
    <a href="/list-with-us.html">List With Us</a>
    <a href="/free-valuation.html">Free Valuation</a>
    <a href="/joint-venture.html">Joint Venture</a>
    <a href="/nri-services.html">NRI Services</a>
    <a href="/admin/login.html">Admin</a>
  </div>
  <div class="mobile-nav-icons">
    <a class="icon-btn" href="tel:${esc(s.phone)}" aria-label="Call ${esc(s.company)}" data-track="call_click">${icon("phone")}</a>
    <a class="icon-btn" href="https://wa.me/${esc(s.whatsapp)}" target="_blank" rel="noopener" aria-label="Chat with ${esc(s.company)} on WhatsApp" data-track="whatsapp_click">${icon("wa")}</a>
  </div>
</nav>`}
<main id="main">
${body}
</main>
${sharedFooter || `<footer>
  <div class="container footer-grid">
    <div class="footer-brand">
      <img src="${esc(logo)}" class="footer-brand-logo-img" alt="${esc(s.company)}" width="131" height="44" loading="lazy">
      <p>Real estate services helping Chennai buyers, sellers, tenants and investors move with confidence.</p>
      ${socialLinksHtml(s, "footer-social")}
    </div>
    <div>
      <h2 class="footer-h">Explore</h2>
      <ul>
        <li><a href="/about.html">About Us</a></li>
        <li><a href="/properties.html">Properties</a></li>
        <li><a href="/areas/chennai/">Properties by Area</a></li>
        <li><a href="/?open=list-with-us#contact">Sell Your Property</a></li>
      </ul>
    </div>
    <div>
      <h2 class="footer-h">Contact</h2>
      <ul>
        <li><a href="tel:${esc(s.phone)}" data-track="call_click">${esc(s.phoneDisplay)}</a></li>
        <li><a href="mailto:${esc(s.email)}">${esc(s.email)}</a></li>
        ${s.address ? `<li>${s.mapsUrl ? `<a href="${esc(s.mapsUrl)}" target="_blank" rel="noopener">${esc(s.address)}</a>` : esc(s.address)}</li>` : ""}
        ${s.hours ? `<li class="footer-hours">${esc(s.hours)}</li>` : ""}
      </ul>
    </div>
  </div>
  <div class="container footer-bottom">
    <span>© ${new Date().getFullYear()} DGSS Realty Asset Consulting Services. All rights reserved.</span>
    <span>Buy · Sell · Rent · Invest</span>
  </div>
</footer>`}
<script src="/js/common.js" defer></script>
<script src="/js/property.js" defer></script>
</body>
</html>`;
}

/* -------------------------------------------------------------------------
   HTML: property page
   ------------------------------------------------------------------------- */
export function renderPropertyPage({ c, property: p, contact: rawContact, related, preview, areaLink = null, chrome = null }) {
  const contact = asSettings(rawContact);
  const images = sortedImages(p);
  const canonicalDefault = `${c.origin}/properties/${p.slug}/`;
  const canonical = canonicalFor(c, p);
  const title = seoTitle(p, contact);
  const description = seoDescription(p, contact);
  const { listing, breadcrumb, crumbs } = buildJsonLd(c, p, images, areaLink, contact);
  // Share image: property's own → featured photo → global default (layout).
  const ogImage = toMediaUrl(safeUrl(p.og_image_url) || safeHttpUrl(p.og_image_url)) || (featuredImage(p) && featuredImage(p).public_url) || null;
  const area = areaLink;
  const nearArea = detectArea(p);
  const closed = CLOSED_STATUSES.includes(p.status);
  const price = priceText(p);
  const facts = propertyFacts(p);
  const waText = `Hi ${contact.company}, I am interested in this property: ${p.title} ${canonicalDefault}`;
  const waHref = `https://wa.me/${contact.whatsapp}?text=${encodeURIComponent(waText)}`;

  const gallery = images.length ? `
    <section class="pg" data-gallery aria-label="Property photos">
      <div class="pg-stage">
        <div class="pg-slides">
          ${images.map((img, i) => `
          <figure class="pg-slide${i === 0 ? " is-active" : ""}" data-index="${i}" ${i === 0 ? "" : 'aria-hidden="true"'}>
            ${pictureHtml(c, img, `width="1200" height="800" ${i === 0 ? 'fetchpriority="high" loading="eager"' : 'loading="lazy"'} decoding="async"`, img.alt_text || `${p.title} — photo ${i + 1}`, "(max-width: 1024px) 100vw, 800px")}
            ${img.is_featured_image ? '<span class="pg-featured">Featured photo</span>' : ""}
          </figure>`).join("")}
        </div>
        ${images.length > 1 ? `
        <button type="button" class="pg-nav pg-prev" data-prev aria-label="Previous photo">${icon("prev")}</button>
        <button type="button" class="pg-nav pg-next" data-next aria-label="Next photo">${icon("next")}</button>` : ""}
        <span class="pg-counter" aria-live="polite"><span data-current>1</span> / ${images.length}</span>
        <button type="button" class="pg-full" data-fullscreen aria-label="View photos full screen">${icon("expand")}</button>
      </div>
      ${images.length > 1 ? `
      <ul class="pg-thumbs" role="list">
        ${images.map((img, i) => `<li><button type="button" class="pg-thumb${i === 0 ? " is-active" : ""}" data-goto="${i}" aria-label="Show photo ${i + 1} of ${images.length}" ${i === 0 ? 'aria-current="true"' : ""}>${pictureHtml(c, img, 'width="120" height="80" loading="lazy" decoding="async"', "", "92px")}</button></li>`).join("")}
      </ul>` : ""}
    </section>` : `
    <div class="pg pg-empty" role="img" aria-label="Photos coming soon">
      <img src="/icons/dgss-realty-icon.png" alt="" width="96" height="96">
      <p>Photos coming soon — call or WhatsApp us for pictures of this property.</p>
    </div>`;

  const statusBanner = closed
    ? `<div class="pd-status pd-status-closed" role="status">This property has been <strong>${esc(p.status.toLowerCase())}</strong>. It's shown for reference — <a href="/properties.html">see available properties</a> or tell us what you're looking for.</div>`
    : p.status === "Under Offer"
      ? `<div class="pd-status pd-status-offer" role="status">This property is currently <strong>under offer</strong>. You can still enquire in case it becomes available again.</div>`
      : "";

  const highlights = Array.isArray(p.highlights) ? p.highlights.filter(h => String(h).trim()) : [];
  const amenities = Array.isArray(p.amenities) ? p.amenities.filter(a => a && a !== "Other") : [];
  const videos = [
    ["YouTube video", safeHttpUrl(p.video_youtube_url)],
    ["Instagram reel", safeHttpUrl(p.video_instagram_url)],
    ["Property video", safeHttpUrl(p.video_other_url)]
  ].filter(v => v[1]);
  const mapUrl = safeHttpUrl(p.google_maps_url) ||
    (typeof p.latitude === "number" && typeof p.longitude === "number" ? `https://www.google.com/maps?q=${p.latitude},${p.longitude}` : "");
  const descriptionHtml = sanitizeRichText(p.full_description);

  const body = `
  <div class="container pd">
    <nav class="pd-crumbs" aria-label="Breadcrumb">
      <ol>${crumbs.map((cr, i) => i === crumbs.length - 1
        ? `<li aria-current="page">${esc(cr.name)}</li>`
        : `<li><a href="${esc(cr.url.replace(c.origin, "") || "/")}">${esc(cr.name)}</a></li>`).join("")}</ol>
    </nav>

    ${statusBanner}

    <div class="pd-grid">
      <div class="pd-main">
        ${gallery}

        <header class="pd-head">
          <div class="pd-tags">
            <span class="prop-tag pd-tag${closed ? " is-closed" : ""}">${esc(statusLabel(p))}</span>
            ${p.category ? `<span class="pd-chip">${esc(p.category)}</span>` : ""}
          </div>
          <h1>${esc(p.title)}</h1>
          ${p.location ? `<p class="pd-loc">${icon("pin")} <span>${esc(p.location)}${p.city && !String(p.location).toLowerCase().includes(String(p.city).toLowerCase()) ? ", " + esc(p.city) : ""}</span></p>` : ""}
          <p class="pd-price${price === "Price on Request" ? " is-muted" : ""}">${esc(price)}${p.is_negotiable && !/negotiable/i.test(price) && price !== "Price on Request" ? ' <span class="pd-neg">(Negotiable)</span>' : ""}</p>
        </header>

        ${facts.length ? `
        <section class="pd-section" aria-labelledby="facts-h">
          <h2 id="facts-h">Key Details</h2>
          <dl class="pd-facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
        </section>` : ""}

        ${p.short_description || descriptionHtml ? `
        <section class="pd-section" aria-labelledby="desc-h">
          <h2 id="desc-h">About This Property</h2>
          ${p.short_description ? `<p class="pd-lead">${esc(p.short_description)}</p>` : ""}
          ${descriptionHtml ? `<div class="pd-rich">${descriptionHtml}</div>` : ""}
        </section>` : ""}

        ${highlights.length ? `
        <section class="pd-section" aria-labelledby="hl-h">
          <h2 id="hl-h">Highlights</h2>
          <ul class="pd-list">${highlights.map(h => `<li>${icon("check")}<span>${esc(h)}</span></li>`).join("")}</ul>
        </section>` : ""}

        ${amenities.length ? `
        <section class="pd-section" aria-labelledby="am-h">
          <h2 id="am-h">Amenities</h2>
          <ul class="pd-list pd-list-cols">${amenities.map(a => `<li>${icon("check")}<span>${esc(a)}</span></li>`).join("")}</ul>
        </section>` : ""}

        ${p.nearby_landmarks || mapUrl ? `
        <section class="pd-section" aria-labelledby="loc-h">
          <h2 id="loc-h">Location</h2>
          ${p.nearby_landmarks ? `<p class="pd-pre">${esc(p.nearby_landmarks)}</p>` : ""}
          ${mapUrl ? `<p><a class="pd-link" href="${esc(mapUrl)}" target="_blank" rel="noopener">${icon("pin")} Open in Google Maps</a></p>` : ""}
          ${area ? `<p><a class="pd-link" href="/areas/${esc(area.slug)}/">More properties in ${esc(area.name)} →</a></p>` : ""}
        </section>` : area ? `
        <section class="pd-section"><p><a class="pd-link" href="/areas/${esc(area.slug)}/">More properties in ${esc(area.name)} →</a></p></section>` : ""}

        ${videos.length ? `
        <section class="pd-section" aria-labelledby="vid-h">
          <h2 id="vid-h">Videos</h2>
          <ul class="pd-videos">${videos.map(([label, u]) => `<li><a class="pd-link" href="${esc(u)}" target="_blank" rel="noopener">▶ ${esc(label)}</a></li>`).join("")}</ul>
        </section>` : ""}
      </div>

      <aside class="pd-side" aria-label="Enquire about this property">
        <div class="pd-card">
          <p class="pd-card-title">${closed ? "Looking for something similar?" : "Interested in this property?"}</p>
          <div class="pd-cta">
            <a class="btn btn-primary btn-block" href="tel:${esc(contact.phone)}" data-track="call_click">${icon("phone")} Call ${esc(contact.phoneDisplay)}</a>
            <a class="btn btn-outline dark btn-block" href="mailto:${esc(contact.email)}?subject=${encodeURIComponent("Enquiry: " + p.title)}">Email Us</a>
            <a class="btn btn-outline dark btn-block" href="${esc(waHref)}" target="_blank" rel="noopener" data-track="whatsapp_click">${icon("wa")} WhatsApp Us</a>
          </div>

          <form class="pd-form" id="enquiryForm" novalidate data-lead-source="property_enquiry">
            <h2 class="pd-form-h">Send an Enquiry</h2>
            <input type="hidden" name="propertyId" value="${esc(p.id)}">
            <div class="hp-field" aria-hidden="true">
              <label for="enq-website">Leave this field empty</label>
              <input type="text" id="enq-website" name="website" tabindex="-1" autocomplete="off">
            </div>
            <div class="field">
              <label for="enq-name">Full Name *</label>
              <input type="text" id="enq-name" name="name" autocomplete="name" required minlength="2" maxlength="100">
              <span class="error-msg">Please enter your name.</span>
            </div>
            <div class="field">
              <label for="enq-phone">Mobile Number *</label>
              <input type="tel" id="enq-phone" name="phone" autocomplete="tel" inputmode="tel" required maxlength="25" pattern="[+0-9 ()\\-.]{8,25}" placeholder="+91 XXXXX XXXXX">
              <span class="error-msg">Please enter a valid mobile number.</span>
            </div>
            <div class="field">
              <label for="enq-email">Email <span class="optional">(optional)</span></label>
              <input type="email" id="enq-email" name="email" autocomplete="email" maxlength="254">
              <span class="error-msg">Please enter a valid email address.</span>
            </div>
            <div class="field">
              <label for="enq-message">Message <span class="optional">(optional)</span></label>
              <textarea id="enq-message" name="message" maxlength="2000" rows="3">I'm interested in "${esc(p.title)}". Please share more details.</textarea>
              <span class="error-msg">Please keep your message under 2,000 characters.</span>
            </div>
            ${c.turnstileSiteKey ? `<div class="cf-turnstile" data-sitekey="${esc(c.turnstileSiteKey)}" data-size="flexible"></div>` : ""}
            <button type="submit" class="btn btn-primary btn-block">Send Enquiry</button>
            <p class="form-status" role="status" aria-live="polite"></p>
          </form>

          <div class="pd-share">
            <span>Share:</span>
            <button type="button" class="pd-share-btn" data-share data-url="${esc(canonicalDefault)}" data-title="${esc(p.title)}" aria-label="Share this property">${icon("share")}</button>
            <a class="pd-share-btn" href="https://wa.me/?text=${encodeURIComponent(p.title + " — " + canonicalDefault)}" target="_blank" rel="noopener" aria-label="Share on WhatsApp" data-track="property_share" data-track-method="whatsapp">${icon("wa")}</a>
            <button type="button" class="pd-share-btn" data-copy data-url="${esc(canonicalDefault)}" aria-label="Copy link">${icon("link")}</button>
            <span class="pd-copied" role="status" aria-live="polite"></span>
          </div>
        </div>
      </aside>
    </div>

    ${related && related.length ? `
    <section class="pd-related" aria-labelledby="rel-h">
      <h2 id="rel-h">${nearArea && related.some(r => areaMatches(nearArea, r)) ? `Other Properties Near ${esc(nearArea.name)}` : "Other Properties"}</h2>
      <div class="prop-grid">${related.map(r => renderCard(c, r)).join("")}</div>
      <p class="pd-more"><a class="btn btn-outline dark" href="/properties.html">View all properties</a></p>
    </section>` : ""}
  </div>

  <dialog class="pg-lightbox" id="pgLightbox" aria-label="Property photos">
    <button type="button" class="pg-lb-close" data-lb-close aria-label="Close full screen photos">${icon("close")}</button>
    <button type="button" class="pg-nav pg-prev" data-lb-prev aria-label="Previous photo">${icon("prev")}</button>
    <img class="pg-lb-img" alt="">
    <button type="button" class="pg-nav pg-next" data-lb-next aria-label="Next photo">${icon("next")}</button>
    <span class="pg-counter pg-lb-counter" aria-live="polite"></span>
  </dialog>
  <script type="application/json" id="pageData">${jsonForScript({
    propertyId: p.id,
    title: p.title,
    url: canonicalDefault,
    // same-site images as relative paths so the lightbox also works on preview hosts
    images: images.map((img, i) => {
      const abs = absoluteUrl(c, img.public_url);
      return { src: abs.startsWith(c.origin + "/") ? abs.slice(c.origin.length) : abs, alt: img.alt_text || `${p.title} — photo ${i + 1}` };
    }),
    preview: !!preview
  })}</script>`;

  return layout({
    c, title, description, canonical: preview ? null : canonical, ogImage, ogType: "article",
    robots: preview ? "noindex, nofollow" : null,
    jsonLd: preview ? [] : [listing, breadcrumb],
    body, contact, preview, chrome, activeNav: "properties",
    extraHead: c.turnstileSiteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ""
  });
}

export function renderCard(c, p) {
  const img = featuredImage(p);
  const url = `/properties/${esc(p.slug)}/`;
  const closed = CLOSED_STATUSES.includes(p.status);
  const chips = [];
  if (p.category) chips.push(p.category);
  if (p.bedrooms && isResidential(p)) chips.push(`${p.bedrooms} BHK`);
  const size = areaOf(p, p.builtup_area ? "builtup_area" : p.land_area ? "land_area" : "plot_area");
  if (size) chips.push(size);
  const price = priceText(p);
  return `
    <article class="prop-card in${closed ? " is-closed" : ""}">
      <a class="prop-media" href="${url}" tabindex="-1" aria-hidden="true">
        ${img ? pictureHtml(c, img, 'loading="lazy" decoding="async" width="900" height="600"', img.alt_text || p.title, "(max-width: 720px) 100vw, 400px") : '<span class="prop-noimg">Photos coming soon</span>'}
        <span class="prop-tag${closed ? " is-closed" : ""}">${esc(statusLabel(p))}</span>
      </a>
      <div class="prop-body">
        <span class="prop-price-label">Price</span>
        <div class="prop-price${price === "Price on Request" ? " prop-price-muted" : ""}">${esc(price)}</div>
        <h3 class="prop-title"><a href="${url}">${esc(p.title)}</a></h3>
        ${p.location ? `<div class="prop-loc">${icon("pin")}<span>${esc(p.location)}</span></div>` : ""}
        ${chips.length ? `<div class="prop-specs">${chips.map(ch => `<span>${esc(ch)}</span>`).join("")}</div>` : ""}
        <div class="prop-actions"><a class="btn btn-outline dark btn-sm prop-details-btn" href="${url}">View Details</a></div>
      </div>
    </article>`;
}

/* -------------------------------------------------------------------------
   HTML: area page
   ------------------------------------------------------------------------- */
export function renderAreaPage({ c, area, list, contact: rawContact, allCount, chrome = null }) {
  const contact = asSettings(rawContact);
  const brand = contact.company;
  const available = list.filter(p => !CLOSED_STATUSES.includes(p.status));
  const canonical = `${c.origin}/areas/${area.slug}/`;
  const title = area.all
    ? `Properties for Sale & Rent in Chennai | ${brand}`
    : `Properties in ${area.name}, Chennai | ${brand}`;
  const counts = { sale: 0, rent: 0 };
  list.forEach(p => { if (p.listing_type === "For Sale") counts.sale++; else counts.rent++; });
  const description = truncateWords(
    `${list.length} ${list.length === 1 ? "property" : "properties"} listed by ${brand} in ${area.all ? "Chennai" : area.name}` +
    `${counts.sale ? `, ${counts.sale} for sale` : ""}${counts.rent ? `, ${counts.rent} for rent or lease` : ""}. ` +
    "View photos, prices and details, or contact us to arrange a visit.", 158);
  const indexable = list.length >= 2;

  const otherAreas = AREAS.filter(a => !a.all && a.slug !== area.slug);
  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: title.replace(` | ${brand}`, ""),
    itemListElement: list.map((p, i) => ({ "@type": "ListItem", position: i + 1, url: `${c.origin}/properties/${p.slug}/`, name: p.title }))
  };
  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: c.origin + "/" },
      { "@type": "ListItem", position: 2, name: area.all ? "Properties in Chennai" : `Properties in ${area.name}`, item: canonical }
    ]
  };

  const body = `
  <div class="container pd">
    <nav class="pd-crumbs" aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li aria-current="page">${esc(area.all ? "Properties in Chennai" : `Properties in ${area.name}`)}</li></ol></nav>
    <header class="area-head">
      <h1>${esc(area.all ? "Properties in Chennai" : `Properties in ${area.name}`)}</h1>
      <p>${esc(`${list.length} ${list.length === 1 ? "property" : "properties"} currently listed with ${brand}${available.length !== list.length ? ` (${available.length} available)` : ""}.`)}
        Can't find what you need? <a href="/#contact">Tell us your requirement</a> or <a href="https://wa.me/${esc(contact.whatsapp)}" target="_blank" rel="noopener" data-track="whatsapp_click">WhatsApp us</a>.</p>
    </header>
    <div class="prop-grid">${list.map(p => renderCard(c, p)).join("")}</div>
    <section class="area-links" aria-labelledby="areas-h">
      <h2 id="areas-h">Browse other areas</h2>
      <p class="area-note">Only areas where we currently have listings will open.</p>
      <ul>${area.all ? "" : '<li><a href="/areas/chennai/">All of Chennai</a></li>'}${otherAreas.map(a => `<li><a href="/areas/${esc(a.slug)}/">${esc(a.name)}</a></li>`).join("")}</ul>
    </section>
  </div>`;

  return layout({
    c, title, description, canonical, robots: indexable ? null : "noindex, follow",
    jsonLd: [breadcrumb, itemList], body, contact, chrome, activeNav: "properties"
  });
}

/* -------------------------------------------------------------------------
   HTML: 404 / error
   ------------------------------------------------------------------------- */
export function renderNotFoundPage({ c, kind, contact: rawContact, chrome = null }) {
  const contact = asSettings(rawContact);
  const heading = kind === "property" ? "Property not found"
    : kind === "area" ? "No listings in this area right now"
    : "Page not found";
  const text = kind === "property"
    ? "This property may have been sold, rented or removed, or the link may be mistyped."
    : kind === "area"
      ? "We don't have live listings here at the moment, but we may have something off-market."
      : "The page you're looking for doesn't exist or has moved.";
  const body = `
  <div class="container nf">
    <p class="nf-code" aria-hidden="true">404</p>
    <h1>${esc(heading)}</h1>
    <p>${esc(text)}</p>
    <div class="nf-actions">
      <a class="btn btn-primary" href="/properties.html">Browse Properties</a>
      <a class="btn btn-outline dark" href="/#hero-services">Search Properties</a>
      <a class="btn btn-outline dark" href="/#contact">Contact ${esc(contact.company)}</a>
    </div>
    <p class="nf-alt">Or call <a href="tel:${esc(contact.phone)}">${esc(contact.phoneDisplay)}</a> / <a href="https://wa.me/${esc(contact.whatsapp)}" target="_blank" rel="noopener">WhatsApp us</a> / <a href="mailto:${esc(contact.email)}">email us</a>.</p>
  </div>`;
  return layout({ c, title: `${heading} | ${contact.company}`, description: text, canonical: null, robots: "noindex, follow", body, contact, chrome, activeNav: kind === "page" ? "" : "properties" });
}

function renderErrorPage(c, settings, chrome = null) {
  const s = asSettings(settings);
  return layout({
    chrome,
    c: c.origin ? c : cfg({}), title: `Temporarily unavailable | ${s.company}`, description: "Please try again shortly.",
    robots: "noindex", contact: s,
    body: `<div class="container nf"><h1>We'll be right back</h1><p>This page couldn't load just now. Please refresh in a moment, or contact us directly.</p>
      <div class="nf-actions"><a class="btn btn-primary" href="/">Go to homepage</a><a class="btn btn-outline dark" href="tel:${esc(s.phone)}">Call ${esc(s.phoneDisplay)}</a><a class="btn btn-outline dark" href="https://wa.me/${esc(s.whatsapp)}" target="_blank" rel="noopener">WhatsApp Us</a></div></div>`
  });
}
