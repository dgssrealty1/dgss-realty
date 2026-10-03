/* ==========================================================================
   DGSS REALTY — HOMEPAGE SCRIPT
   Table of contents:
     1. Live data: listings, testimonials and contact details arrive with
        the page (#homeData, rendered by the Worker from Supabase). There
        is NO built-in property list: if the database can't be reached the
        page shows "temporarily unavailable" with Call / WhatsApp buttons,
        never stale listings.
     2. Property cards + filters (Buy / Rent / Land / type / BHK / budget)
     3. Lead forms (List With Us / Valuation / JV / NRI / Contact)
     4. Hero slideshow (lazy slides)
     5. Hero Buy / Sell / Rent / Land + search
     6. Header extras, mobile navigation, section dots, reveal, footer year
     7. Init
   Everything that comes from the database is escaped (esc()) or set with
   textContent before it touches the page.
   ========================================================================== */

const esc = (window.DGSS && window.DGSS.esc) || (v => String(v == null ? "" : v)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"));
const track = (...args) => { if (window.DGSS) window.DGSS.track(...args); };

function readHomeData() {
  try {
    const node = document.getElementById("homeData");
    return node ? JSON.parse(node.textContent) : null;
  } catch (_) { return null; }
}
const HOME = readHomeData();

/* Contact details: Admin → Contact Details, delivered with the page.
   Without the Worker (local static files) they come from
   /api/site-settings via common.js, or links fall back to #contact. */
let CONTACT = (HOME && HOME.settings) || null;
const telHref = () => (CONTACT && CONTACT.phone ? `tel:${CONTACT.phone}` : "#contact");
const waHref = text => (CONTACT && CONTACT.whatsapp
  ? `https://wa.me/${CONTACT.whatsapp}${text ? `?text=${encodeURIComponent(text)}` : ""}` : "#contact");
const companyName = () => (CONTACT && CONTACT.company) || "DGSS Realty";

const CLOSED_STATUSES = ["Sold", "Rented", "Leased"];
const LAND_CATEGORIES = ["Residential Plot", "Land"];
const RESIDENTIAL = ["Apartment", "Flat", "Independent House", "Villa"];

/* ==========================================================================
   1. LIVE DATA
   ========================================================================== */
let PROPERTIES = [];
let LISTINGS_UNAVAILABLE = false;
const SUPABASE_FETCH_BATCH_SIZE = 1000; // request batch size, not a listing limit

async function fetchAllPublishedProperties() {
  let from = 0;
  let allRows = [];
  while (true) {
    const { data, error } = await window.supabaseClient
      .from("properties")
      .select("id, slug, title, category, listing_type, status, location, locality, city, display_price, price, is_price_on_request, is_negotiable, bedrooms, builtup_area, land_area, plot_area, uds, area_unit, floor_number, car_parking, furnishing, property_age, is_featured, created_at, property_images(public_url, alt_text, is_featured_image, sort_order)")
      .eq("is_published", true)
      .eq("is_archived", false)
      .order("is_featured", { ascending: false })
      .order("created_at", { ascending: false })
      .range(from, from + SUPABASE_FETCH_BATCH_SIZE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    allRows = allRows.concat(data);
    if (data.length < SUPABASE_FETCH_BATCH_SIZE) break;
    from += SUPABASE_FETCH_BATCH_SIZE;
  }
  return allRows;
}

function mapRow(row) {
  const images = (row.property_images || []).slice().sort((a, b) =>
    (b.is_featured_image ? 1 : 0) - (a.is_featured_image ? 1 : 0) || (a.sort_order || 0) - (b.sort_order || 0));
  const img = images[0];
  const isLand = LAND_CATEGORIES.includes(row.category);
  // Bare numbers get the Area Unit chosen in Admin (same rule as the Worker).
  const area = v => { const t = String(v == null ? "" : v).trim(); return /^[\d.,]+$/.test(t) && row.area_unit ? `${t} ${row.area_unit}` : t; };
  const features = [
    !isLand && row.bedrooms ? `${row.bedrooms} BHK` : null,
    row.builtup_area ? `Built-up Area: ${area(row.builtup_area)}` : null,
    row.land_area ? `Land Area: ${area(row.land_area)}` : null,
    row.plot_area && !row.land_area ? `Plot Area: ${area(row.plot_area)}` : null,
    row.uds ? `UDS: ${area(row.uds)}` : null,
    !isLand ? row.floor_number || null : null,
    !isLand ? row.car_parking || null : null,
    !isLand ? row.furnishing || null : null,
    !isLand && row.property_age ? `Age: ${row.property_age}` : null
  ].filter(Boolean);
  let priceText = null;
  if (!row.is_price_on_request) {
    const monthly = row.listing_type === "For Rent" || row.listing_type === "For Lease" ? " / Month" : "";
    priceText = row.display_price ? String(row.display_price).trim() : (typeof row.price === "number" && row.price > 0 ? formatInr(row.price) + monthly : null);
  }
  return {
    id: row.slug,
    uuid: row.id,
    url: `/properties/${encodeURIComponent(row.slug)}/`,
    title: row.title,
    location: row.location || row.locality || "",
    locality: row.locality || "",
    category: row.category || "",
    listingType: row.listing_type || "",
    status: row.status || "Available",
    bedrooms: isLand ? null : (row.bedrooms || null),
    price: typeof row.price === "number" ? row.price : (row.price ? Number(row.price) : null),
    priceText,
    image: img ? toMediaUrl(img.public_url) : "",
    imageAlt: (img && img.alt_text) || row.title,
    features
  };
}

/* Old public Storage URLs stop working once the image bucket is private
   (migration 04); uploaded photos are served via /media/… by the Worker,
   which only returns photos of published listings. */
function toMediaUrl(u) {
  const m = String(u || "").match(/\/storage\/v1\/object\/(?:public|authenticated)\/property-images\/([0-9a-f-]{36}\/[A-Za-z0-9._-]+)(?:\?.*)?$/);
  return m ? `/media/property-images/${m[1]}` : String(u || "");
}

function formatInr(n) {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2).replace(/\.?0+$/, "")} Crore`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2).replace(/\.?0+$/, "")} Lakh`;
  return `₹${Number(n).toLocaleString("en-IN")}`;
}

function showListingsUnavailable() {
  LISTINGS_UNAVAILABLE = true;
  PROPERTIES = [];
  const grid = document.getElementById("propertyGrid");
  const filters = document.getElementById("propFilters");
  if (filters) filters.hidden = true;
  renderLoadMoreControl(0);
  if (!grid) return;
  grid.innerHTML = `<div class="prop-unavailable" role="status">
      <p><strong>Property listings are temporarily unavailable.</strong> Please contact us for the latest availability.</p>
      <p class="prop-unavailable-actions">
        <a class="btn btn-primary btn-sm" href="${esc(telHref())}" data-track="call_click">Call${CONTACT && CONTACT.phoneDisplay ? " " + esc(CONTACT.phoneDisplay) : " Us"}</a>
        <a class="btn btn-outline dark btn-sm" href="${esc(waHref())}" target="_blank" rel="noopener" data-track="whatsapp_click">WhatsApp Us</a>
      </p>
    </div>`;
}

/* Only used when the page runs WITHOUT the Worker (opened as static
   files): fetch from Supabase directly. Failure shows the unavailable
   notice — there is no built-in listing data to fall back to. */
async function loadPropertiesFromSupabase() {
  const grid = document.getElementById("propertyGrid");
  if (grid) grid.setAttribute("aria-busy", "true");
  try {
    if (!window.supabaseClient) throw new Error("Supabase not configured");
    const rows = await fetchAllPublishedProperties();
    PROPERTIES = rows.map(mapRow);
    buildFilterOptions();
    applyFilters();
  } catch (err) {
    console.warn("Could not load properties.", err);
    showListingsUnavailable();
  } finally {
    if (grid) grid.removeAttribute("aria-busy");
  }
}

function testimonialCardHtml(t) {
  const initials = String(t.client_name || "").split(" ").filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "•";
  const roleLine = [t.client_role, t.location].filter(Boolean).join(" · ");
  const rating = Number.isInteger(t.rating) && t.rating >= 1 && t.rating <= 5 ? t.rating : null;
  const photo = /^(https:\/\/|\/[A-Za-z0-9])[^\s"'<>]*$/.test(String(t.photo_url || "")) ? toMediaUrl(t.photo_url) : "";
  return `
        <article class="testimonial-card reveal in">
          ${rating ? `<p class="testimonial-rating" aria-label="Rated ${rating} out of 5"><span aria-hidden="true">${"★".repeat(rating)}${"☆".repeat(5 - rating)}</span></p>` : ""}
          <p class="testimonial-quote">"${esc(t.review)}"</p>
          <div class="testimonial-person">
            ${photo ? `<img class="testimonial-avatar testimonial-photo" src="${esc(photo)}" alt="" width="44" height="44" loading="lazy" decoding="async">`
                    : `<span class="testimonial-avatar" aria-hidden="true">${esc(initials)}</span>`}
            <div>
              <strong>${esc(t.client_name)}</strong>
              ${roleLine ? `<span>${esc(roleLine)}</span>` : ""}
            </div>
          </div>
        </article>`;
}

async function loadTestimonialsFromSupabase() {
  if (!window.supabaseClient) return;
  const section = document.getElementById("testimonials");
  const grid = section && section.querySelector(".testimonial-grid");
  if (!grid) return;
  try {
    const { data, error } = await window.supabaseClient
      .from("testimonials").select("client_name, client_role, location, review, rating, photo_url")
      .eq("is_published", true).order("sort_order", { ascending: true });
    if (error) throw error;
    if (!data || !data.length) return; // no real testimonials yet — section stays hidden
    grid.innerHTML = data.map(testimonialCardHtml).join("");
    section.hidden = false;
    const dot = document.querySelector('.section-dot[data-target="testimonials"]');
    if (dot) dot.hidden = false;
  } catch (err) {
    console.warn("Could not load testimonials.", err);
  }
}

/* Static-file mode: load supabase-js + config on demand. */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src; el.async = true;
    el.onload = resolve; el.onerror = () => reject(new Error("Could not load " + src));
    document.head.appendChild(el);
  });
}
async function ensureSupabaseClient() {
  if (window.supabaseClient) return true;
  try {
    if (!window.supabase) await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js");
    await loadScript("/js/supabase-client.js");
  } catch (err) {
    console.warn(err.message);
  }
  return !!window.supabaseClient;
}

/* ==========================================================================
   2. PROPERTY CARDS + FILTERS
   ========================================================================== */
const PROPERTY_GRID_INITIAL_COUNT = 24;
const PROPERTY_GRID_LOAD_MORE_COUNT = 24;
let currentGridList = null;
let visibleGridCount = PROPERTY_GRID_INITIAL_COUNT;

const FILTERS = { listing: "", location: "", type: "", bhk: "", budget: "" };
const BUDGETS = {
  sale: [["", "Any budget"], ["0-5000000", "Under ₹50 Lakh"], ["5000000-10000000", "₹50 Lakh – ₹1 Crore"], ["10000000-20000000", "₹1 – 2 Crore"], ["20000000-50000000", "₹2 – 5 Crore"], ["50000000-", "Above ₹5 Crore"]],
  rent: [["", "Any budget"], ["0-25000", "Under ₹25,000 / month"], ["25000-50000", "₹25,000 – 50,000"], ["50000-100000", "₹50,000 – 1 Lakh"], ["100000-", "Above ₹1 Lakh / month"]]
};

function matchesListing(p, listing) {
  if (!listing) return true;
  if (listing === "sale") return p.listingType === "For Sale";
  if (listing === "rent") return p.listingType === "For Rent" || p.listingType === "For Lease";
  if (listing === "land") return LAND_CATEGORIES.includes(p.category);
  return true;
}

function filteredProperties() {
  const needle = FILTERS.location.trim().toLowerCase();
  let list = PROPERTIES.filter(p => {
    // Sold / rented / leased listings never appear in Buy/Rent/Land results.
    if (FILTERS.listing && CLOSED_STATUSES.includes(p.status)) return false;
    if (!matchesListing(p, FILTERS.listing)) return false;
    if (needle && ![p.location, p.locality, p.title].some(v => v && v.toLowerCase().includes(needle))) return false;
    if (FILTERS.type && p.category !== FILTERS.type) return false;
    if (FILTERS.bhk) {
      if (!p.bedrooms) return false;
      if (FILTERS.bhk === "5+" ? p.bedrooms < 5 : p.bedrooms !== Number(FILTERS.bhk)) return false;
    }
    if (FILTERS.budget) {
      if (typeof p.price !== "number" || !(p.price > 0)) return false;
      const [min, max] = FILTERS.budget.split("-").map(v => (v === "" ? null : Number(v)));
      if (min !== null && p.price < min) return false;
      if (max !== null && p.price >= max) return false;
    }
    return true;
  });
  // Available first, then under offer, then closed (shown for reference).
  const rank = p => (CLOSED_STATUSES.includes(p.status) ? 2 : p.status === "Under Offer" ? 1 : 0);
  list = list.slice().sort((a, b) => rank(a) - rank(b));
  return list;
}

function filtersActive() {
  return Object.values(FILTERS).some(Boolean);
}

/* Options are built from what actually exists in the live listings, so
   nobody can pick a filter that can never match. */
function buildFilterOptions() {
  const typeSel = document.getElementById("filterType");
  const bhkSel = document.getElementById("filterBhk");
  const budgetSel = document.getElementById("filterBudget");
  if (!typeSel) return;

  const categories = [...new Set(PROPERTIES.map(p => p.category).filter(Boolean))].sort();
  typeSel.innerHTML = `<option value="">Any type</option>` + categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  typeSel.value = categories.includes(FILTERS.type) ? FILTERS.type : "";
  typeSel.hidden = categories.length < 2;

  const bhks = [...new Set(PROPERTIES.filter(p => RESIDENTIAL.includes(p.category) && p.bedrooms).map(p => (p.bedrooms >= 5 ? "5+" : String(p.bedrooms))))]
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  bhkSel.innerHTML = `<option value="">Any BHK</option>` + bhks.map(b => `<option value="${b}">${b} BHK</option>`).join("");
  bhkSel.value = bhks.includes(FILTERS.bhk) ? FILTERS.bhk : "";
  bhkSel.hidden = bhks.length < 2;

  refreshBudgetOptions();
}

function refreshBudgetOptions() {
  const budgetSel = document.getElementById("filterBudget");
  if (!budgetSel) return;
  const mode = FILTERS.listing === "rent" ? "rent" : "sale";
  const pool = PROPERTIES.filter(p => (mode === "rent"
    ? (p.listingType === "For Rent" || p.listingType === "For Lease")
    : p.listingType === "For Sale") && typeof p.price === "number" && p.price > 0);
  // Budget only makes sense once enough listings have a numeric price set.
  const show = pool.length >= 2;
  budgetSel.innerHTML = BUDGETS[mode].map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("");
  if (!show || !BUDGETS[mode].some(([v]) => v === FILTERS.budget)) FILTERS.budget = "";
  budgetSel.value = FILTERS.budget;
  budgetSel.hidden = !show;
}

function syncFilterControls() {
  document.querySelectorAll(".prop-chip").forEach(chip => {
    const on = chip.dataset.listing === FILTERS.listing;
    chip.classList.toggle("is-active", on);
    chip.setAttribute("aria-pressed", on ? "true" : "false");
  });
  document.querySelectorAll(".hero-nav-item[data-intent]").forEach(item => {
    const intent = item.dataset.intent === "buy" ? "sale" : item.dataset.intent;
    const on = intent === FILTERS.listing;
    item.classList.toggle("active", on);
    if (item.hasAttribute("aria-pressed")) item.setAttribute("aria-pressed", on ? "true" : "false");
  });
  const loc = document.getElementById("filterLocation");
  if (loc && loc.value !== FILTERS.location) loc.value = FILTERS.location;
  const hero = document.getElementById("heroLocationInput");
  if (hero && hero.value !== FILTERS.location) hero.value = FILTERS.location;
  const reset = document.getElementById("filterReset");
  if (reset) reset.hidden = !filtersActive();
}

function applyFilters(reason) {
  refreshBudgetOptions();
  syncFilterControls();
  const list = filteredProperties();
  currentGridList = list;
  visibleGridCount = PROPERTY_GRID_INITIAL_COUNT;
  renderPropertyGridBatch();

  const count = document.getElementById("propResultCount");
  if (count) {
    count.textContent = filtersActive()
      ? `${list.length} ${list.length === 1 ? "property" : "properties"} match your filters`
      : "";
  }
  if (reason) track(reason, { listing: FILTERS.listing || "all", type: FILTERS.type || "any", bhk: FILTERS.bhk || "any", results: list.length });
}

function resetFilters() {
  Object.keys(FILTERS).forEach(k => { FILTERS[k] = ""; });
  const t = document.getElementById("filterType"); if (t) t.value = "";
  const b = document.getElementById("filterBhk"); if (b) b.value = "";
  applyFilters();
}

function initFilters() {
  document.querySelectorAll(".prop-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      FILTERS.listing = chip.dataset.listing;
      applyFilters("filter_apply");
    });
  });
  const loc = document.getElementById("filterLocation");
  let t = null;
  if (loc) loc.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => { FILTERS.location = loc.value.trim(); applyFilters(FILTERS.location ? "search" : null); }, 250);
  });
  [["filterType", "type"], ["filterBhk", "bhk"], ["filterBudget", "budget"]].forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => { FILTERS[key] = el.value; applyFilters("filter_apply"); });
  });
  const reset = document.getElementById("filterReset");
  if (reset) reset.addEventListener("click", resetFilters);
}

function renderProperties() { applyFilters(); }

function renderPropertyGridBatch() {
  const grid = document.getElementById("propertyGrid");
  if (!grid || LISTINGS_UNAVAILABLE) return;
  const items = currentGridList || [];

  if (!items.length) {
    const msg = PROPERTIES.length
      ? (FILTERS.listing && !FILTERS.location && !FILTERS.type && !FILTERS.bhk && !FILTERS.budget
          ? "No properties are currently available in this category."
          : "No properties match your current search criteria.")
      : "New listings are being added — check back soon, or contact us directly for current inventory.";
    grid.innerHTML = `<p class="prop-empty">${esc(msg)} ${filtersActive() ? '<button type="button" class="prop-empty-reset" id="propEmptyReset">Clear filters</button> or ' : ""}<a class="prop-empty-reset" href="#contact">tell us what you're looking for</a>.</p>`;
    const resetBtn = document.getElementById("propEmptyReset");
    if (resetBtn) resetBtn.addEventListener("click", resetFilters);
    renderLoadMoreControl(0);
    return;
  }

  const visibleItems = items.slice(0, visibleGridCount);
  grid.innerHTML = visibleItems.map(buildPropertyCard).join("");
  observeReveal(grid.querySelectorAll(".reveal"));
  renderLoadMoreControl(items.length - visibleItems.length);
}

function renderLoadMoreControl(remaining) {
  const existing = document.getElementById("propLoadMoreWrap");
  if (existing) existing.remove();
  if (remaining <= 0) return;
  const grid = document.getElementById("propertyGrid");
  const wrap = document.createElement("div");
  wrap.id = "propLoadMoreWrap";
  wrap.className = "prop-load-more-wrap";
  wrap.innerHTML = `<button type="button" class="btn btn-outline dark" id="propLoadMoreBtn">Load More Properties <span class="prop-load-more-count">(${remaining} more)</span></button>`;
  grid.insertAdjacentElement("afterend", wrap);
  document.getElementById("propLoadMoreBtn").addEventListener("click", () => {
    visibleGridCount += PROPERTY_GRID_LOAD_MORE_COUNT;
    renderPropertyGridBatch();
  });
}

function statusTag(p) {
  if (CLOSED_STATUSES.includes(p.status) || p.status === "Under Offer") return p.status;
  return p.listingType || "Available";
}

function propertyAbsoluteUrl(p) {
  return `${window.location.origin}${p.url}`;
}

function buildPropertyCard(property) {
  const closed = CLOSED_STATUSES.includes(property.status);
  const priceHtml = property.priceText
    ? `<span class="prop-price-label">Price</span><div class="prop-price">${esc(property.priceText)}</div>`
    : `<span class="prop-price-label">Price</span><div class="prop-price prop-price-muted">On Request</div>`;

  // Chips: only fields that exist. Land never shows BHK.
  const chips = [];
  if (property.category) chips.push(property.category);
  if (property.bedrooms && !LAND_CATEGORIES.includes(property.category)) chips.push(`${property.bedrooms} BHK`);
  const area = property.features.find(f => /^(Built-up|Land|Plot) Area:/i.test(f));
  if (area) chips.push(area.replace(/^(Built-up|Land|Plot) Area:\s*/i, ""));

  const waLink = waHref(`Hi ${companyName()}, I am interested in this property: ${property.title} ${propertyAbsoluteUrl(property)}`);
  const titleId = `prop-${esc(property.id)}-title`;
  const detailsControl = `<a class="btn btn-outline dark btn-sm prop-details-btn" href="${esc(property.url)}">View Details</a>`;
  const media = `<a class="prop-media" href="${esc(property.url)}" tabindex="-1" aria-hidden="true">`;

  return `
    <article class="prop-card reveal${closed ? " is-closed" : ""}" aria-labelledby="${titleId}">
      ${media}
        ${buildPropertyPicture(property, 'loading="lazy" decoding="async" width="900" height="600"', "(max-width: 720px) 100vw, 400px")}
        <span class="prop-tag${closed ? " is-closed" : ""}">${esc(statusTag(property))}</span>
      </a>
      <div class="prop-body">
        ${priceHtml}
        <h3 class="prop-title" id="${titleId}"><a href="${esc(property.url)}">${esc(property.title)}</a></h3>
        ${property.location ? `<div class="prop-loc">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 10c0 7-9 12-9 12s-9-5-9-12a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          <span>${esc(property.location)}</span>
        </div>` : ""}
        ${chips.length ? `<div class="prop-specs">${chips.map(c => `<span>${featureIcon()} ${esc(c)}</span>`).join("")}</div>` : ""}
        <div class="prop-actions">
          <a class="btn-icon" href="${esc(telHref())}" aria-label="Call about ${esc(property.title)}" data-track="call_click">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.34 1.79.65 2.65a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.43-1.22a2 2 0 0 1 2.11-.45c.86.31 1.75.53 2.65.65A2 2 0 0 1 22 16.92z"/></svg>
          </a>
          <a class="btn-icon whatsapp" href="${esc(waLink)}" target="_blank" rel="noopener" aria-label="WhatsApp about ${esc(property.title)}" data-track="whatsapp_click">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3 20l1-5.4A8.5 8.5 0 1 1 21 11.5z"/></svg>
          </a>
          ${detailsControl}
        </div>
      </div>
    </article>`;
}

function featureIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
}

/* Two image conventions: a full URL (admin uploads) or a site base path
   without extension (the original photos, which have AVIF / WebP / JPG at
   800px and full size). */
function buildPropertyPicture(property, imgAttrs, sizes) {
  const src = String(property.image || "");
  const alt = esc(property.imageAlt || property.title);
  if (!src) return '<span class="prop-noimg">Photos coming soon</span>';
  const localBase = src.match(/^(?:https?:\/\/(?:www\.)?dgssrealty\.com)?\/?(images\/properties\/[a-z0-9-]+?)(?:\.jpe?g)?$/i);
  if (localBase) {
    const b = "/" + esc(localBase[1]);
    return `<picture>
      <source type="image/avif" srcset="${b}-800.avif 800w, ${b}.avif 1400w" sizes="${esc(sizes || "100vw")}">
      <source type="image/webp" srcset="${b}-800.webp 800w, ${b}.webp 1400w" sizes="${esc(sizes || "100vw")}">
      <img src="${b}.jpg" alt="${alt}" ${imgAttrs}>
    </picture>`;
  }
  if (!/^https?:\/\//i.test(src) && !/^\/media\/property-images\/[0-9a-f-]{36}\/[A-Za-z0-9._-]+$/.test(src)) return '<span class="prop-noimg">Photos coming soon</span>';
  return `<img src="${esc(src)}" alt="${alt}" ${imgAttrs}>`;
}

/* ==========================================================================
   Modal plumbing (lead-form modals)
   ========================================================================== */
let lastFocusBeforeModal = null;

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  lastFocusBeforeModal = document.activeElement;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  const focusTarget = modal.querySelector(".modal-close, input:not([type=hidden]):not([tabindex='-1']), select, textarea, button");
  if (focusTarget) focusTarget.focus();
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal || !modal.classList.contains("open")) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  if (!document.querySelector(".property-modal.open")) document.body.style.overflow = "";
  if (lastFocusBeforeModal && document.body.contains(lastFocusBeforeModal)) lastFocusBeforeModal.focus();
}

function initModalDismissal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.addEventListener("click", e => { if (e.target === modal) closeModal(modalId); });
  modal.querySelectorAll("[data-close-modal]").forEach(btn => btn.addEventListener("click", () => closeModal(modalId)));
  modal.addEventListener("keydown", e => {
    if (e.key === "Escape") closeModal(modalId);
    // Keep Tab inside the open dialog.
    if (e.key === "Tab" && modal.classList.contains("open")) {
      const f = Array.from(modal.querySelectorAll('a[href], button:not([disabled]), input:not([type=hidden]):not([tabindex="-1"]), select, textarea'))
        .filter(el => el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
    }
  });
}

function closeMobileDrawer() {
  const drawer = document.getElementById("mobileNav");
  if (drawer && drawer.classList.contains("open")) {
    drawer.classList.remove("open");
    document.getElementById("mobileNavOverlay")?.classList.remove("open");
    document.getElementById("hamburger")?.setAttribute("aria-expanded", "false");
    document.body.classList.remove("no-scroll");
  }
}

function initModalTriggers() {
  document.querySelectorAll("[data-open-modal]").forEach(trigger => {
    trigger.addEventListener("click", () => {
      closeMobileDrawer();
      openModal(trigger.getAttribute("data-open-modal"));
    });
  });
  ["listWithUsModal", "valuationModal", "jointVentureModal", "nriModal"].forEach(initModalDismissal);
}

/* ==========================================================================
   3. LEAD FORMS
   Each form saves to the Admin → Leads inbox through window.DGSS.submitLead
   (Worker /api/lead → database submit_lead(), which validates and
   rate-limits). If saving is impossible (offline / server down), the
   visitor is offered a pre-filled email instead so no enquiry is lost.
   ========================================================================== */
function showFormError(form, message, mailtoHref) {
  const box = form.querySelector(".form-error");
  if (!box) { if (message) window.alert(message); return; }
  box.textContent = message || "";
  if (message && mailtoHref) {
    box.append(" ");
    const a = document.createElement("a");
    a.href = mailtoHref;
    a.textContent = "Send it by email instead";
    box.append(a);
  }
}

function validateFields(form, requiredIds, extraChecks) {
  const V = (window.DGSS && window.DGSS.validators) || {};
  let firstBad = null;
  const all = new Set(requiredIds.concat(Object.keys(extraChecks || {})));
  all.forEach(id => {
    const field = document.getElementById(id);
    if (!field) return;
    const wrapper = field.closest(".field");
    const value = field.value.trim();
    let valid = true;
    if (requiredIds.includes(id)) valid = value.length > 0 && field.checkValidity();
    if (valid && extraChecks && extraChecks[id]) valid = extraChecks[id](value, V);
    if (wrapper) wrapper.classList.toggle("invalid", !valid);
    field.setAttribute("aria-invalid", valid ? "false" : "true");
    if (!valid && !firstBad) firstBad = field;
  });
  if (firstBad) firstBad.focus();
  return !firstBad;
}

function initLeadForm({ formId, successId, requiredIds, subjectPrefix, labels, source, coreFields, trackEvent, checks }) {
  const form = document.getElementById(formId);
  const success = document.getElementById(successId);
  if (!form || !success) return;

  form.addEventListener("submit", async e => {
    e.preventDefault();
    showFormError(form, "");
    success.classList.remove("show");
    if (!validateFields(form, requiredIds, checks)) return;

    const get = id => { const el = id && document.getElementById(id); return el ? el.value.trim() : ""; };
    const details = {};
    const lines = [];
    labels.forEach(([id, label]) => {
      const field = document.getElementById(id);
      if (!field || field.type === "file" || field.type === "hidden") return;
      const value = field.value.trim();
      if (!value) return;
      lines.push(`${label}: ${value}`);
      if (!Object.values(coreFields).includes(id)) details[label] = value;
    });

    const button = form.querySelector('button[type="submit"]');
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "Sending…";

    const honeypot = form.querySelector('input[name="website"]');
    const result = await window.DGSS.submitLead({
      source,
      name: get(coreFields.name),
      phone: get(coreFields.phone),
      whatsapp: get(coreFields.whatsapp) || null,
      email: get(coreFields.email) || null,
      message: get(coreFields.message) || null,
      propertyId: get(coreFields.propertyId) || null,
      details,
      website: honeypot ? honeypot.value : ""
    });

    button.disabled = false;
    button.textContent = label;

    if (result.ok) {
      success.classList.add("show");
      form.reset();
      track(trackEvent || "enquiry_submit", { source });
      return;
    }
    const subject = encodeURIComponent(`${subjectPrefix}${get(coreFields.name) ? " from " + get(coreFields.name) : ""}`);
    const mailto = (result.offline || result.error === "server_error") && CONTACT && CONTACT.email
      ? `mailto:${CONTACT.email}?subject=${subject}&body=${encodeURIComponent(lines.join("\n"))}`
      : null;
    showFormError(form, result.message, mailto);
  });
}

const PHONE_CHECK = (v, V) => (V.phone ? V.phone(v) : v.length >= 8);
const EMAIL_CHECK = (v, V) => (V.email ? V.email(v) : true);
const NAME_CHECK = (v, V) => (V.name ? V.name(v) : v.length >= 2);

function initLeadForms() {
  initLeadForm({
    formId: "listWithUsForm", successId: "listWithUsSuccess",
    requiredIds: ["lw-name", "lw-mobile", "lw-type", "lw-location"],
    checks: { "lw-name": NAME_CHECK, "lw-mobile": PHONE_CHECK, "lw-whatsapp": (v, V) => !v || PHONE_CHECK(v, V), "lw-email": EMAIL_CHECK },
    subjectPrefix: "New Property Listing", source: "list_with_us", trackEvent: "seller_form_submit",
    coreFields: { name: "lw-name", phone: "lw-mobile", whatsapp: "lw-whatsapp", email: "lw-email" },
    labels: [
      ["lw-name", "Name"], ["lw-mobile", "Mobile"], ["lw-whatsapp", "WhatsApp"], ["lw-email", "Email"],
      ["lw-type", "Property Type"], ["lw-listing-type", "Listing Type"], ["lw-location", "Location"],
      ["lw-address", "Address"], ["lw-size", "Property Size"], ["lw-builtup", "Built-up Area"],
      ["lw-bedrooms", "Bedrooms"], ["lw-bathrooms", "Bathrooms"], ["lw-price", "Expected Price/Rent"],
      ["lw-description", "Description"], ["lw-additional", "Additional Info"],
      ["lw-contact-method", "Preferred Contact Method"]
    ]
  });

  initLeadForm({
    formId: "valuationForm", successId: "valuationSuccess",
    requiredIds: ["fv-name", "fv-mobile", "fv-location"],
    checks: { "fv-name": NAME_CHECK, "fv-mobile": PHONE_CHECK, "fv-whatsapp": (v, V) => !v || PHONE_CHECK(v, V), "fv-email": EMAIL_CHECK },
    subjectPrefix: "Free Valuation Request", source: "free_valuation", trackEvent: "seller_form_submit",
    coreFields: { name: "fv-name", phone: "fv-mobile", whatsapp: "fv-whatsapp", email: "fv-email" },
    labels: [
      ["fv-name", "Name"], ["fv-mobile", "Mobile"], ["fv-whatsapp", "WhatsApp"], ["fv-email", "Email"],
      ["fv-type", "Property Type"], ["fv-location", "Location"], ["fv-address", "Address"],
      ["fv-size", "Property Size"], ["fv-builtup", "Built-up Area"], ["fv-age", "Property Age"],
      ["fv-price", "Expected Value"], ["fv-details", "Additional Details"]
    ]
  });

  initLeadForm({
    formId: "jointVentureForm", successId: "jointVentureSuccess",
    requiredIds: ["jv-name", "jv-phone", "jv-location"],
    checks: { "jv-name": NAME_CHECK, "jv-phone": PHONE_CHECK, "jv-email": EMAIL_CHECK },
    subjectPrefix: "Joint Venture Enquiry", source: "joint_venture", trackEvent: "seller_form_submit",
    coreFields: { name: "jv-name", phone: "jv-phone", email: "jv-email", message: "jv-message" },
    labels: [
      ["jv-name", "Name"], ["jv-phone", "Phone"], ["jv-email", "Email"],
      ["jv-location", "Property/Project Location"], ["jv-type", "Property Type"],
      ["jv-details", "Land Area/Project Details"], ["jv-requirement", "JV Requirement"],
      ["jv-message", "Message"]
    ]
  });

  initLeadForm({
    formId: "nriForm", successId: "nriSuccess",
    requiredIds: ["nri-name", "nri-mobile", "nri-email", "nri-country", "nri-requirement"],
    checks: { "nri-name": NAME_CHECK, "nri-mobile": PHONE_CHECK, "nri-whatsapp": (v, V) => !v || PHONE_CHECK(v, V), "nri-email": EMAIL_CHECK },
    subjectPrefix: "NRI Property Enquiry", source: "nri_services",
    coreFields: { name: "nri-name", phone: "nri-mobile", whatsapp: "nri-whatsapp", email: "nri-email", message: "nri-message" },
    labels: [
      ["nri-name", "Name"], ["nri-mobile", "Mobile"], ["nri-whatsapp", "WhatsApp"], ["nri-email", "Email"],
      ["nri-country", "Country of Residence"], ["nri-contact-method", "Preferred Contact Method"],
      ["nri-requirement", "Property Requirement"], ["nri-location", "Preferred Location"],
      ["nri-type", "Property Type"], ["nri-budget", "Budget"], ["nri-timeline", "Timeline"],
      ["nri-message", "Message"]
    ]
  });

  initLeadForm({
    formId: "contactForm", successId: "formSuccess",
    requiredIds: ["cf-name", "cf-phone", "cf-email", "cf-message"],
    checks: { "cf-name": NAME_CHECK, "cf-phone": PHONE_CHECK, "cf-email": EMAIL_CHECK },
    subjectPrefix: "New Enquiry", source: "contact_form",
    coreFields: { name: "cf-name", phone: "cf-phone", email: "cf-email", message: "cf-message" },
    labels: [["cf-name", "Name"], ["cf-phone", "Phone"], ["cf-email", "Email"], ["cf-message", "Message"]]
  });

  const fileInput = document.getElementById("lw-images");
  const fileLabel = document.getElementById("lw-images-label");
  if (fileInput && fileLabel) {
    fileInput.addEventListener("change", () => {
      fileLabel.textContent = fileInput.files.length
        ? `${fileInput.files.length} photo${fileInput.files.length > 1 ? "s" : ""} selected — please send them on WhatsApp`
        : "Choose photos of the property";
    });
  }
}

/* ==========================================================================
   4. HERO SLIDESHOW
   Only slide 1 loads with the page. Each later slide is requested a few
   seconds before it's shown, so it's ready in time without competing with
   the first paint. Pauses when the tab is hidden; no autoplay motion for
   visitors who prefer reduced motion.
   ========================================================================== */
function initHeroSlideshow() {
  const slides = Array.from(document.querySelectorAll(".hero-slide"));
  const dots = Array.from(document.querySelectorAll(".hero-slide-dot"));
  if (slides.length < 2) return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const SLIDE_DURATION = 6000;
  let index = 0;
  let timer = null;
  let warmTimer = null;

  // Slides 2+ ship without real image addresses (see index.html) so they
  // can't compete with the first image. Swap them in shortly before use.
  function warm(i) {
    const slide = slides[i];
    if (!slide) return;
    slide.querySelectorAll("source[data-srcset]").forEach(s => { s.srcset = s.dataset.srcset; s.removeAttribute("data-srcset"); });
    const img = slide.querySelector("img[data-src]");
    if (img) { img.src = img.dataset.src; img.removeAttribute("data-src"); }
  }

  function activate(i) {
    slides.forEach((slide, si) => {
      const isActive = si === i;
      slide.classList.toggle("active", isActive);
      if (isActive) {
        const img = slide.querySelector("img");
        if (img) { img.style.animation = "none"; void img.offsetWidth; img.style.animation = ""; }
      }
    });
    dots.forEach((dot, di) => dot.classList.toggle("active", di === i));
    index = i;
    scheduleWarm();
  }

  function scheduleWarm() {
    clearTimeout(warmTimer);
    warmTimer = setTimeout(() => warm((index + 1) % slides.length), SLIDE_DURATION - 2500);
  }

  function start() {
    stop();
    timer = window.setInterval(() => activate((index + 1) % slides.length), SLIDE_DURATION);
    scheduleWarm();
  }
  function stop() {
    if (timer) { window.clearInterval(timer); timer = null; }
    clearTimeout(warmTimer);
  }

  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  // Start after the page has loaded so slide 2 never competes with the LCP image.
  if (document.readyState === "complete") start();
  else window.addEventListener("load", start, { once: true });
}

/* ==========================================================================
   5. HERO BUY / SELL / RENT / LAND + SEARCH
   Buy / Rent / Land really filter the listings (using the database's
   listing type and category). Sell opens the List With Us form.
   ========================================================================== */
function applyIntent(intent) {
  if (intent === "sell") {
    closeMobileDrawer();
    openModal("listWithUsModal");
    track("seller_cta_click", { from: "intent" });
    return;
  }
  const map = { buy: "sale", rent: "rent", land: "land" };
  FILTERS.listing = FILTERS.listing === map[intent] ? "" : (map[intent] || "");
  applyFilters("filter_apply");
  const section = document.getElementById("properties");
  if (section) section.scrollIntoView({ behavior: "smooth", block: "start" });
}

function initHeroIntentSelector() {
  document.querySelectorAll(".hero-nav-item[data-intent]").forEach(item => {
    item.addEventListener("click", () => applyIntent(item.dataset.intent));
  });
  document.querySelectorAll("[data-intent-link]").forEach(link => {
    link.addEventListener("click", e => { e.preventDefault(); applyIntent(link.dataset.intentLink); });
  });
}

function initHeroSearch() {
  const form = document.getElementById("heroSearchForm");
  const input = document.getElementById("heroLocationInput");
  if (!form || !input) return;
  form.addEventListener("submit", e => {
    e.preventDefault();
    FILTERS.location = input.value.trim();
    applyFilters(FILTERS.location ? "search" : null);
    const section = document.getElementById("properties");
    if (section) section.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

/* ==========================================================================
   6. HEADER EXTRAS, MOBILE NAV, SECTION DOTS, REVEAL, FOOTER YEAR
   ========================================================================== */
function initHeaderScrollEffects() {
  const ring = document.getElementById("toTopRing");
  const button = document.getElementById("toTop");
  const waFloat = document.querySelector(".wa-float");
  const hero = document.querySelector(".hero");
  if (!ring || !button) return;
  let ticking = false;
  function update() {
    ticking = false;
    const scrollTop = window.scrollY;
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    const progress = docHeight > 0 ? Math.min(100, (scrollTop / docHeight) * 100) : 0;
    ring.style.setProperty("--progress", progress.toFixed(1));
    ring.classList.toggle("show", scrollTop > 400);
    if (waFloat && hero) waFloat.classList.toggle("show", hero.getBoundingClientRect().bottom <= 0);
  }
  window.addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  update();
  button.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
}

function initMobileNav() {
  const hamburger = document.getElementById("hamburger");
  const mobileNav = document.getElementById("mobileNav");
  const overlay = document.getElementById("mobileNavOverlay");
  const closeBtn = document.getElementById("mobileNavClose");
  if (!hamburger || !mobileNav || !overlay) return;
  function openDrawer() {
    mobileNav.classList.add("open"); overlay.classList.add("open");
    hamburger.setAttribute("aria-expanded", "true"); document.body.classList.add("no-scroll");
    if (closeBtn) closeBtn.focus();
  }
  function closeDrawer() {
    mobileNav.classList.remove("open"); overlay.classList.remove("open");
    hamburger.setAttribute("aria-expanded", "false"); document.body.classList.remove("no-scroll");
  }
  hamburger.addEventListener("click", () => (mobileNav.classList.contains("open") ? closeDrawer() : openDrawer()));
  if (closeBtn) closeBtn.addEventListener("click", () => { closeDrawer(); hamburger.focus(); });
  overlay.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && mobileNav.classList.contains("open")) { closeDrawer(); hamburger.focus(); } });
  mobileNav.querySelectorAll("a").forEach(link => link.addEventListener("click", closeDrawer));
}

function initSectionDots() {
  const dots = Array.from(document.querySelectorAll(".section-dot"));
  if (!dots.length) return;
  const sections = dots
    .map(dot => {
      const id = dot.dataset.target;
      const scrollEl = document.getElementById(id);
      const observeEl = id === "top" ? document.querySelector(".hero") : scrollEl;
      if (scrollEl && scrollEl.hidden) dot.hidden = true; // e.g. testimonials before any are published
      return { id, scrollEl, observeEl, dot };
    })
    .filter(s => s.scrollEl && s.observeEl);
  if (!sections.length) return;
  const navLinks = document.querySelectorAll("[data-section]");
  function setActive(id) {
    sections.forEach(s => s.dot.classList.toggle("active", s.id === id));
    navLinks.forEach(link => link.classList.toggle("active", link.dataset.section === id));
  }
  dots.forEach(dot => dot.addEventListener("click", () => {
    const target = document.getElementById(dot.dataset.target);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  const current = new Set();
  const io = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      const s = sections.find(x => x.observeEl === entry.target);
      if (!s) return;
      if (entry.isIntersecting) current.add(s.id); else current.delete(s.id);
    });
    const activeId = sections.map(s => s.id).filter(id => current.has(id)).pop();
    if (activeId) setActive(activeId);
  }, { threshold: 0, rootMargin: "-45% 0px -50% 0px" });
  sections.forEach(s => io.observe(s.observeEl));
  setActive("top");
}

function observeReveal(els) {
  if (!els || !els.length) return;
  if (!("IntersectionObserver" in window)) { els.forEach(el => el.classList.add("in")); return; }
  const io = new IntersectionObserver((entries, obs) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add("in"); obs.unobserve(entry.target); }
    });
  }, { threshold: 0.15 });
  els.forEach(el => io.observe(el));
}

function initScrollReveal() {
  observeReveal(Array.from(document.querySelectorAll(".reveal")).filter(el => !el.closest("#propertyGrid")));
}

function setFooterYear() {
  const yearEl = document.getElementById("year");
  if (yearEl && !yearEl.textContent.trim()) yearEl.textContent = new Date().getFullYear();
}

/* Links like "/?open=list-with-us#contact" (from property pages) open the
   seller form directly. */
function openModalFromUrl() {
  const open = new URLSearchParams(window.location.search).get("open");
  const map = { "list-with-us": "listWithUsModal", valuation: "valuationModal", "joint-venture": "jointVentureModal", nri: "nriModal" };
  if (map[open]) openModal(map[open]);
}

/* ==========================================================================
   7. INIT
   ========================================================================== */
document.addEventListener("DOMContentLoaded", async () => {
  initFilters();
  initModalTriggers();
  initLeadForms();
  initHeaderScrollEffects();
  initHeroSlideshow();
  initHeroIntentSelector();
  initMobileNav();
  initSectionDots();
  initHeroSearch();
  initScrollReveal();
  setFooterYear();
  openModalFromUrl();

  if (HOME) {
    // Normal case: everything came with the page from the Worker.
    if (HOME.propertiesUnavailable || !Array.isArray(HOME.properties)) {
      showListingsUnavailable();
    } else {
      PROPERTIES = HOME.properties.map(mapRow);
      buildFilterOptions();
      applyFilters();
    }
    return;
  }

  // Opened without the Worker (local static files): fetch directly.
  if (window.DGSS && window.DGSS.siteSettingsReady) {
    CONTACT = (await window.DGSS.siteSettingsReady) || CONTACT;
  }
  const ok = await ensureSupabaseClient();
  if (!ok) { showListingsUnavailable(); return; }
  await Promise.all([loadPropertiesFromSupabase(), loadTestimonialsFromSupabase()]);
});
