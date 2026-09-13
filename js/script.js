/* ==========================================================================
   DGSS REALTY — MAIN SCRIPT
   Table of contents:
     1. EDITABLE DATA (Properties + Testimonials) — edit ONLY this section
        to add/remove/update content. No HTML editing required.
     2. Property Card Renderer + Details Modal
     3. Testimonial Renderer + Carousel
     4. Back-to-Top + Scroll Progress Ring
     5. Hero Slideshow
     5b. Hero Property-Intent Selector (Buy/Sell/Rent/Land)
     6. Mobile Navigation
     7. Scroll Reveal Animations
     8. Contact Form Handling
     9. Footer Year
     10. Init
   ========================================================================== */

/* ==========================================================================
   1. EDITABLE DATA
   ------------------------------------------------------------------------
   PROPERTIES: To add a new property, copy one object below, paste it into
   the array, and edit the fields. The card, quick-spec chips and the
   "View Details" modal are all built automatically from this data — no
   HTML changes needed.

   Image field expects a base path WITHOUT extension, e.g.
   "images/properties/prop-7-new-listing" — the renderer automatically
   builds a <picture> tag that serves the .webp version with a .jpg
   fallback, so just save both files with that same name.
   ========================================================================== */
/* `let`, not `const` — loadPropertiesFromSupabase() below replaces this
   array with live data from the database once it loads. This hardcoded
   list is now only the fallback used if Supabase hasn't been configured
   yet (see js/supabase-client.js) or the fetch fails, so the public site
   never breaks. */
let PROPERTIES = [
  {
    id: "prop-1",
    tag: "For Sale",
    title: "Prime Residential Property – Perambur",
    location: "Office Paper Mills Road, Behind Jawahar Nagar, Perambur",
    price: "₹3 Crore per Ground (Negotiable)",
    image: "images/properties/prop-1-perambur",
    imageAlt: "Exterior of residential property for sale in Perambur, Office Paper Mills Road",
    features: [
      "4 BHK",
      "Land Area: 3,195 Sq.Ft. (35 × 91 Ft.)",
      "Built-up Area: 1,800 Sq.Ft.",
      "Structure: G + 1",
      "West Facing",
      "Age: 35 Years"
    ]
  },
  {
    id: "prop-2",
    tag: "For Sale",
    title: "Premium Beach-Side Land – Uthandi",
    location: "Uthandi – Before Toll, Sea Side",
    price: "₹15 Crore (Negotiable)",
    image: "images/properties/prop-2-uthandi-land",
    imageAlt: "Compound wall of beach-side land for sale in Uthandi, before toll",
    features: [
      "Land Area: 5.7 Grounds",
      "Plot Dimension: 169 × 82 Ft.",
      "Rectangular Plot",
      "South Facing",
      "Fully Compounded",
      "Private Road Access",
      "Direct Access to the Beach"
    ]
  },
  {
    id: "prop-3",
    tag: "For Sale",
    title: "2 BHK Flat – Nandanam",
    location: "Nandanam",
    price: "₹1.90 Crore",
    image: "images/properties/prop-3-nandanam",
    imageAlt: "Living room interior of 2 BHK flat for sale in Nandanam",
    features: [
      "2 BHK",
      "Built-up Area: 1,362 Sq.Ft.",
      "2nd Floor",
      "UDS: Approx. 770 Sq.Ft.",
      "Total Apartments: 11",
      "Covered Car Parking"
    ]
  },
  {
    id: "prop-4",
    tag: "For Rent",
    title: "5 BHK Independent House – Ashok Nagar",
    location: "Ashok Nagar",
    price: "₹1.50 Lakhs / Month",
    image: "images/properties/prop-4-ashok-nagar",
    imageAlt: "Interior of independent house for rent in Ashok Nagar",
    features: [
      "5 BHK",
      "Independent House",
      "Built-up Area: 3,700 Sq.Ft.",
      "Very Close to Metro & Pillar"
    ]
  },
  {
    id: "prop-5",
    tag: "For Sale",
    title: "2 BHK Flat – Thiruvanmiyur, Rajaji Nagar",
    location: "Thiruvanmiyur – Rajaji Nagar",
    price: null,
    image: "images/properties/prop-5-thiruvanmiyur",
    imageAlt: "Interior hallway of 2 BHK flat for sale in Thiruvanmiyur, Rajaji Nagar",
    features: [
      "2 BHK",
      "Built-up Area: 900 Sq.Ft.",
      "UDS: 508 Sq.Ft.",
      "1st Floor",
      "Lift Available",
      "1 Covered Car Park",
      "Property Age: 6 Years"
    ]
  }

  /* Example — copy this block to add another property:
  {
    id: "prop-6",
    tag: "For Rent",
    title: "2 BHK Apartment – Velachery",
    location: "Velachery",
    price: "₹35,000 / month",
    image: "images/properties/prop-6-velachery",
    imageAlt: "2 BHK apartment for rent in Velachery, Chennai",
    features: [
      "2 BHK",
      "Flat Area: 1100 Sq.Ft.",
      "Covered Car Parking",
      "Lift Available"
    ]
  },
  */
];

/* ==========================================================================
   FOUNDER CONTENT (admin-managed)
   ------------------------------------------------------------------------
   The founder's name, designation, location, experience line, bio and
   quote all live in the `settings` singleton row so they can be edited
   from Admin → Homepage without touching code. Nothing here is
   hard-coded in JS: the designation in particular is read straight from
   the database, so it can be changed to "Founder", "Realty Advisor",
   "Founder & Realty Advisor" or anything else at any time.

   Same safe pattern as properties/testimonials: if Supabase isn't
   configured, the fetch fails, or a given field is blank, the existing
   markup in index.html is simply left untouched — the section can never
   end up blank or half-empty.
   ========================================================================== */
async function loadFounderFromSupabase() {
  if (!window.supabaseClient) return; // static markup stands as-is

  try {
    const { data, error } = await window.supabaseClient
      .from("settings")
      .select("company_name, founder_name, founder_designation, founder_location, founder_experience, founder_credential_line, founder_bio_intro, founder_bio_top, founder_bio_bottom, founder_quote, founder_photo_url")
      .eq("id", 1)
      .single();

    if (error || !data) return; // keep whatever is already in the markup

    // Only ever overwrite an element when there's a real value for it —
    // a blank/missing column leaves the existing content alone.
    const setText = (selector, value) => {
      if (!value) return;
      document.querySelectorAll(selector).forEach(el => { el.textContent = value; });
    };

    const name = data.founder_name;
    const designation = data.founder_designation;
    const company = data.company_name;

    setText("[data-founder-name]", name);
    setText("[data-founder-designation]", designation);
    setText("[data-founder-location]", data.founder_location);
    setText("[data-founder-experience]", data.founder_experience);
    setText("[data-founder-credential-line]", data.founder_credential_line);
    setText("[data-founder-bio-intro]", data.founder_bio_intro);
    setText("[data-founder-quote]", data.founder_quote);

    // Designation is shown in two combined forms elsewhere on the page —
    // both are composed here rather than stored separately, so changing
    // the designation once updates every occurrence consistently.
    if (designation) {
      setText("[data-founder-designation-comma]", company ? `${designation}, ${company}` : designation);
      setText("[data-founder-designation-dash]", company ? `${designation} – ${company}` : designation);
    }

    // Monogram fallback (shown only if the photo fails to load) follows
    // the name so it never shows stale initials.
    if (name) {
      const initials = name.split(" ").filter(Boolean).slice(0, 2)
        .map(w => w[0].toUpperCase()).join("");
      if (initials) setText("[data-founder-monogram]", initials);
    }

    // Photo: update both the <img> and its sibling <source> so the
    // <picture> element doesn't keep serving the old file, and refresh
    // alt text to match the current name/designation.
    if (data.founder_photo_url) {
      document.querySelectorAll("[data-founder-photo]").forEach(img => {
        img.src = data.founder_photo_url;
        const picture = img.closest("picture");
        if (picture) {
          picture.querySelectorAll("source").forEach(s => { s.srcset = data.founder_photo_url; });
        }
      });
    }
    if (name) {
      const altText = designation ? `${name}, ${designation} of ${company || "DGSS Realty"}` : name;
      document.querySelectorAll("[data-founder-photo]").forEach(img => { img.alt = altText; });
    }

    // Bio body: each field is a plain textarea in admin where blank
    // lines separate paragraphs, rendered back into the same <p>
    // structure the design already uses.
    const setParagraphs = (selector, value) => {
      if (!value) return;
      const wrap = document.querySelector(selector);
      if (!wrap) return;
      const paras = value.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
      if (!paras.length) return;
      wrap.innerHTML = paras.map(p => `<p>${p}</p>`).join("");
    };
    setParagraphs("[data-founder-bio-top]", data.founder_bio_top);
    setParagraphs("[data-founder-bio-bottom]", data.founder_bio_bottom);

    console.info("Loaded founder content from Supabase.");
  } catch (err) {
    console.warn("Could not load founder content from Supabase — showing existing founder content instead.", err);
  }
}

/* Testimonials are static markup directly in index.html now (see the
   Testimonials section) rather than JS-rendered, since it's a fixed
   3-card grid rather than a carousel — simpler to hand-edit later when
   swapping in real client reviews.
   UPDATE: loadTestimonialsFromSupabase() below now overwrites this
   static markup with live, published testimonials from the database
   if/when any exist — mirroring loadPropertiesFromSupabase()'s same
   safe pattern (Supabase not configured, fetch fails, or zero
   published rows → the static markup above is simply left alone, so
   the section never goes blank). */
async function loadTestimonialsFromSupabase() {
  if (!window.supabaseClient) return; // static markup stands as-is

  try {
    const { data, error } = await window.supabaseClient
      .from("testimonials")
      .select("*")
      .eq("is_published", true)
      .order("sort_order", { ascending: true });

    if (error || !data || !data.length) return; // keep the static cards rather than showing an empty section

    const grid = document.querySelector(".testimonial-grid");
    if (!grid) return;

    grid.innerHTML = data.map(t => {
      const initials = (t.client_name || "")
        .split(" ").filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "•";
      const roleLine = [t.client_role, t.location].filter(Boolean).join(" · ");
      return `
        <article class="testimonial-card reveal in">
          <p class="testimonial-quote">"${t.review}"</p>
          <div class="testimonial-person">
            <span class="testimonial-avatar">${initials}</span>
            <div>
              <strong>${t.client_name}</strong>
              ${roleLine ? `<span>${roleLine}</span>` : ""}
            </div>
          </div>
        </article>
      `;
    }).join("");

    console.info(`Loaded ${data.length} testimonial${data.length === 1 ? "" : "s"} from Supabase.`);
  } catch (err) {
    console.warn("Could not load testimonials from Supabase — showing static testimonials instead.", err);
  }
}

/* Shared contact details used across property cards and the modal. */
const CONTACT = {
  phone: "+919841009059",
  phoneDisplay: "+91 98410 09059",
  whatsapp: "919841009059"
};

/* ==========================================================================
   1b. LIVE PROPERTY DATA (Supabase)
   ------------------------------------------------------------------------
   Fetches published, non-archived properties (each with only its
   featured image, not the whole gallery — the gallery is fetched
   separately, scoped to one property, when its modal actually opens)
   and maps them into the exact same shape as the hardcoded PROPERTIES
   array above, so renderProperties(), openPropertyModal(), the hero
   search, and the ?property= deep-link all keep working completely
   unchanged — they have no idea whether a given property came from the
   fallback array or the database.

   IMPORTANT: Supabase/PostgREST caps any single .select() at a default
   maximum row count (commonly 1000) — silently, with no error. A plain
   .select() here would quietly stop showing new listings once the
   catalogue passed that number. fetchAllPublished() below batches the
   request with .range() instead, looping until a page comes back
   smaller than the batch size, so it correctly returns every published
   property regardless of how large the catalogue grows.

   Falls back to the existing hardcoded array (silently, with a console
   note) if Supabase isn't configured yet or the request fails, so the
   public site is never broken by a database hiccup.
   ========================================================================== */
const SUPABASE_FETCH_BATCH_SIZE = 1000; // a request-batching chunk size, not a property-count limit

async function fetchAllPublishedProperties() {
  let from = 0;
  let allRows = [];

  while (true) {
    const { data, error } = await window.supabaseClient
      .from("properties")
      // Only the featured image (falling back to whichever comes first)
      // is fetched here — the full gallery for a property is fetched
      // separately, scoped to just that property, only when its modal
      // is opened. Pulling every gallery image for every card on the
      // homepage would multiply the payload for no benefit.
      .select("*, property_images(id, public_url, alt_text, is_featured_image)")
      .eq("is_published", true)
      .eq("is_archived", false)
      .order("created_at", { ascending: false })
      .order("is_featured_image", { ascending: false, foreignTable: "property_images" })
      .range(from, from + SUPABASE_FETCH_BATCH_SIZE - 1);

    if (error) throw error;
    if (!data || !data.length) break;

    allRows = allRows.concat(data);
    if (data.length < SUPABASE_FETCH_BATCH_SIZE) break; // last (partial) page — no more rows to fetch
    from += SUPABASE_FETCH_BATCH_SIZE;
  }

  return allRows;
}

async function loadPropertiesFromSupabase() {
  if (!window.supabaseClient) {
    console.info("Supabase not configured yet — showing built-in sample properties. See supabase/SETUP.md.");
    return;
  }

  try {
    const data = await fetchAllPublishedProperties();
    if (!data || !data.length) return; // keep the fallback list rather than showing an empty site

    PROPERTIES = data.map(row => {
      const images = row.property_images || [];
      const featuredImage = images.find(img => img.is_featured_image) || images[0];
      const tag = ["Sold", "Rented", "Under Offer"].includes(row.status) ? row.status : row.listing_type;

      const features = [
        row.bedrooms ? `${row.bedrooms} BHK` : null,
        row.builtup_area ? `Built-up Area: ${row.builtup_area}` : null,
        row.land_area ? `Land Area: ${row.land_area}` : null,
        row.uds ? `UDS: ${row.uds}` : null,
        row.floor_number ? row.floor_number : null,
        row.car_parking ? row.car_parking : null,
        row.furnishing || null,
        row.property_age ? `${row.property_age} Old` : null
      ].filter(Boolean);

      return {
        id: row.slug,
        tag: tag || "Available",
        title: row.title,
        location: row.location || "",
        price: row.is_price_on_request ? null : row.display_price,
        image: featuredImage ? featuredImage.public_url : "",
        imageAlt: (featuredImage && featuredImage.alt_text) || row.title,
        features: features.length ? features : ["Contact us for full specifications"]
      };
    });

    renderProperties();
    console.info(`Loaded ${PROPERTIES.length} propert${PROPERTIES.length === 1 ? "y" : "ies"} from Supabase.`);
  } catch (err) {
    console.warn("Could not load properties from Supabase — showing built-in sample properties instead.", err);
  }
}

/* ==========================================================================
   2. PROPERTY CARD RENDERER + DETAILS MODAL
   ========================================================================== */
// How many property cards render into the DOM at once. This is purely a
// rendering/pagination detail for the browser's sake — it has nothing to
// do with how many properties are fetched or how many exist in the
// database (that remains fully unlimited; see fetchAllPublishedProperties
// above). All matching properties are already in memory in `currentGridList`
// the moment a search/filter runs; "Load More" just reveals more of what's
// already there, no extra network request needed.
const PROPERTY_GRID_INITIAL_COUNT = 24;
const PROPERTY_GRID_LOAD_MORE_COUNT = 24;

let currentGridList = null;
let currentGridQuery = undefined;
let visibleGridCount = PROPERTY_GRID_INITIAL_COUNT;

function renderProperties(list, query) {
  // A genuinely new result set (initial load, a new search, a filter
  // change, "clear search") always starts back at the top with a fresh
  // batch — only the "Load More" button itself should extend the count
  // without resetting it (see loadMoreProperties() below).
  currentGridList = list || PROPERTIES;
  currentGridQuery = query;
  visibleGridCount = PROPERTY_GRID_INITIAL_COUNT;
  renderPropertyGridBatch();
}

function renderPropertyGridBatch() {
  const grid = document.getElementById("propertyGrid");
  if (!grid) return;
  const items = currentGridList || [];

  if (!items.length) {
    grid.innerHTML = currentGridQuery
      ? `<p class="prop-empty">No properties found for "${escapeHtml(currentGridQuery)}". <button type="button" class="prop-empty-reset" id="propEmptyReset">Clear search</button> or contact us directly for current inventory.</p>`
      : '<p class="prop-empty">New listings are being added — check back soon, or contact us directly for current inventory.</p>';
    const resetBtn = document.getElementById("propEmptyReset");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        const input = document.getElementById("heroLocationInput");
        if (input) input.value = "";
        renderProperties();
      });
    }
    return;
  }

  const visibleItems = items.slice(0, visibleGridCount);
  const remaining = items.length - visibleItems.length;

  grid.innerHTML = visibleItems.map(buildPropertyCard).join("");

  // Wire up "View Details" buttons after render
  grid.querySelectorAll("[data-view-details]").forEach(btn => {
    btn.addEventListener("click", () => openPropertyModal(btn.getAttribute("data-view-details")));
  });

  // Fade the freshly-injected cards in (own observer, scoped to this grid).
  observeReveal(grid.querySelectorAll(".reveal"));

  renderLoadMoreControl(remaining);
}

function renderLoadMoreControl(remaining) {
  const existing = document.getElementById("propLoadMoreWrap");
  if (existing) existing.remove();
  if (remaining <= 0) return;

  const grid = document.getElementById("propertyGrid");
  const wrap = document.createElement("div");
  wrap.id = "propLoadMoreWrap";
  wrap.className = "prop-load-more-wrap";
  wrap.innerHTML = `
    <button type="button" class="btn btn-outline dark" id="propLoadMoreBtn">
      Load More Properties <span class="prop-load-more-count">(${remaining} more)</span>
    </button>
  `;
  grid.insertAdjacentElement("afterend", wrap);
  document.getElementById("propLoadMoreBtn").addEventListener("click", loadMoreProperties);
}

function loadMoreProperties() {
  visibleGridCount += PROPERTY_GRID_LOAD_MORE_COUNT;
  renderPropertyGridBatch();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function buildPropertyCard(property) {
  const priceHtml = property.price
    ? `<span class="prop-price-label">Price</span><div class="prop-price">${property.price}</div>`
    : `<span class="prop-price-label">Price</span><div class="prop-price prop-price-muted">On Request</div>`;

  const quickFeatures = property.features.slice(0, 3);
  const quickHtml = quickFeatures
    .map(f => `<span>${featureIcon()} ${f}</span>`)
    .join("");

  const waMessage = encodeURIComponent(`Hi DGSS Realty, I'm interested in "${property.title}". Could you share more details?`);

  return `
    <article class="prop-card reveal" aria-labelledby="${property.id}-title">
      <div class="prop-media">
        ${buildPropertyPicture(property, 'loading="lazy" width="900" height="600"')}
        <span class="prop-tag">${property.tag}</span>
      </div>
      <div class="prop-body">
        ${priceHtml}
        <div class="prop-loc" id="${property.id}-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 10c0 7-9 12-9 12s-9-5-9-12a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
          <span>${property.title}${property.location ? " · " + property.location : ""}</span>
        </div>
        <div class="prop-specs">${quickHtml}${property.features.length > 3 ? `<span class="prop-more">+${property.features.length - 3} more</span>` : ""}</div>
        <div class="prop-actions">
          <a class="btn-icon" href="tel:${CONTACT.phone}" aria-label="Call about ${property.title}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.34 1.79.65 2.65a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.43-1.22a2 2 0 0 1 2.11-.45c.86.31 1.75.53 2.65.65A2 2 0 0 1 22 16.92z"/></svg>
          </a>
          <a class="btn-icon whatsapp" href="https://wa.me/${CONTACT.whatsapp}?text=${waMessage}" target="_blank" rel="noopener" aria-label="WhatsApp about ${property.title}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3 20l1-5.4A8.5 8.5 0 1 1 21 11.5z"/></svg>
          </a>
          <button type="button" class="btn btn-outline dark btn-sm prop-details-btn" data-view-details="${property.id}">View Details</button>
        </div>
      </div>
    </article>
  `;
}

function featureIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
}

/* Supports two image conventions so admin-added properties (a single
   full Supabase Storage URL, already has its own extension) and the
   original hardcoded properties (a base path with separate .jpg/.webp
   files) both render correctly without any other code needing to care
   which one a given property uses. */
function buildPropertyPicture(property, imgAttrs) {
  const hasExtension = /\.(jpe?g|png|webp|avif)$/i.test(property.image);
  if (hasExtension) {
    return `<img src="${property.image}" alt="${property.imageAlt}" ${imgAttrs}>`;
  }
  return `
    <picture>
      <source srcset="${property.image}.webp" type="image/webp">
      <img src="${property.image}.jpg" alt="${property.imageAlt}" ${imgAttrs}>
    </picture>
  `;
}

function openPropertyModal(propertyId) {
  const property = PROPERTIES.find(p => p.id === propertyId);
  const modal = document.getElementById("propertyModal");
  const body = document.getElementById("propertyModalBody");
  if (!property || !modal || !body) return;

  const priceHtml = property.price
    ? `<div class="modal-price">${property.price}</div>`
    : `<div class="modal-price modal-price-muted">Price on Request</div>`;

  const featuresHtml = property.features.map(f => `<li>${featureIcon()} ${f}</li>`).join("");
  const waMessage = encodeURIComponent(`Hi DGSS Realty, I'm interested in "${property.title}". Could you share more details?`);

  body.innerHTML = `
    ${buildPropertyPicture(property, 'width="900" height="600"')}
    <div class="modal-tag-row">
      <span class="prop-tag modal-tag">${property.tag}</span>
      <button type="button" class="modal-share-btn" data-share-property aria-label="Share this property">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="10.5" x2="15.4" y2="6.5"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/></svg>
      </button>
    </div>
    <h3 id="propertyModalTitle">${property.title}</h3>
    ${property.location ? `<p class="modal-location"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 12-9 12s-9-5-9-12a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> ${property.location}</p>` : ""}
    ${priceHtml}
    <ul class="modal-features">${featuresHtml}</ul>
    <div class="modal-actions">
      <a class="btn btn-primary" href="tel:${CONTACT.phone}">Call ${CONTACT.phoneDisplay}</a>
      <a class="btn btn-outline dark" href="https://wa.me/${CONTACT.whatsapp}?text=${waMessage}" target="_blank" rel="noopener">WhatsApp DGSS Realty</a>
      <button type="button" class="btn btn-outline dark" data-enquire="${property.title}">Enquire Now</button>
    </div>
  `;

  modal.querySelector("[data-enquire]").addEventListener("click", () => {
    closeModal("propertyModal");
    openEnquiryModal(property.title);
  });

  modal.querySelector("[data-share-property]").addEventListener("click", e => sharePropertyLink(property, e.currentTarget));

  openModal("propertyModal");
  document.getElementById("propertyModalClose").focus();
}

/* ==========================================================================
   2d. PROPERTY SHARE
   ------------------------------------------------------------------------
   Builds a URL that identifies this specific property (?property=<id>) and
   shares it via the native Web Share sheet where available, falling back
   to copying the link to the clipboard (with a brief "Link copied" tooltip
   on the button) on desktop browsers that don't support navigator.share.
   That URL is also what openPropertyFromUrl() below reads on page load, so
   a shared link actually opens straight to that property, not just the
   homepage.
   ========================================================================== */
function getPropertyShareUrl(property) {
  const url = new URL(window.location.href);
  url.hash = "";
  url.search = `?property=${encodeURIComponent(property.id)}`;
  return url.toString();
}

function sharePropertyLink(property, button) {
  const url = getPropertyShareUrl(property);

  if (navigator.share) {
    navigator.share({ title: property.title, text: `${property.title} — DGSS Realty`, url }).catch(() => {});
    return;
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => {
      if (!button) return;
      button.classList.add("copied");
      window.setTimeout(() => button.classList.remove("copied"), 1600);
    });
    return;
  }

  window.prompt("Copy this property link:", url);
}

function openPropertyFromUrl() {
  const propertyId = new URLSearchParams(window.location.search).get("property");
  if (propertyId && PROPERTIES.some(p => p.id === propertyId)) {
    openPropertyModal(propertyId);
  }
}

function closePropertyModal() {
  closeModal("propertyModal");
}

function initPropertyModal() {
  const closeBtn = document.getElementById("propertyModalClose");
  if (closeBtn) closeBtn.addEventListener("click", () => closeModal("propertyModal"));
  initModalDismissal("propertyModal");
}

/* ==========================================================================
   2b. GENERIC MODAL SYSTEM
   ------------------------------------------------------------------------
   Shared open/close plumbing for every ".property-modal" on the page —
   the property-details modal plus the three lead-form modals below.
   Each modal closes on: its own close button(s), clicking the dimmed
   backdrop, or ESC. Body scroll is locked while any one of them is open.
   ========================================================================== */
function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  const focusTarget = modal.querySelector(".modal-close, input, select, textarea, button");
  if (focusTarget) focusTarget.focus();
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  // Only restore scrolling if no other modal is still open.
  const anyOpen = document.querySelector(".property-modal.open");
  if (!anyOpen) document.body.style.overflow = "";
}

function initModalDismissal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;

  modal.addEventListener("click", e => {
    if (e.target === modal) closeModal(modalId);
  });

  modal.querySelectorAll("[data-close-modal]").forEach(btn => {
    btn.addEventListener("click", () => closeModal(modalId));
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && modal.classList.contains("open")) closeModal(modalId);
  });
}

/* Wires up every element with data-open-modal="someModalId" (header nav,
   mobile drawer nav) to open that modal — and close the mobile drawer
   first if it happens to be open. */
function initModalTriggers() {
  document.querySelectorAll("[data-open-modal]").forEach(trigger => {
    trigger.addEventListener("click", () => {
      const targetId = trigger.getAttribute("data-open-modal");
      const drawer = document.getElementById("mobileNav");
      if (drawer && drawer.classList.contains("open")) {
        drawer.classList.remove("open");
        document.getElementById("mobileNavOverlay")?.classList.remove("open");
        document.getElementById("hamburger")?.setAttribute("aria-expanded", "false");
        document.body.classList.remove("no-scroll");
      }
      openModal(targetId);
    });
  });

  ["listWithUsModal", "valuationModal", "jointVentureModal", "nriModal", "enquiryModal"].forEach(initModalDismissal);
}

/* ==========================================================================
   2c. LEAD FORMS (List With Us / Free Valuation / Property Enquiry)
   ------------------------------------------------------------------------
   This is a static site with no backend, so "submitting" a form composes
   a pre-filled email to the office inbox via mailto: — the same real
   mechanism the Contact form already uses — then shows a success message
   and resets the form. File inputs can't be attached via mailto:, so the
   List With Us form's photo field is a courtesy convenience only; the
   copy next to it says as much.
   ========================================================================== */
function initLeadForm({ formId, successId, requiredIds, subjectPrefix, labels, source, coreFields }) {
  const form = document.getElementById(formId);
  const success = document.getElementById(successId);
  if (!form || !success) return;

  form.addEventListener("submit", async e => {
    e.preventDefault();

    // Validate every required field (not just until the first failure)
    // so all invalid fields get flagged at once, not just the first one.
    const isValid = requiredIds
      .map(id => {
        const field = document.getElementById(id);
        const wrapper = field.closest(".field");
        const valid = field.value.trim().length > 0 && field.checkValidity();
        wrapper.classList.toggle("invalid", !valid);
        return valid;
      })
      .every(Boolean);

    if (!isValid) return;

    const nameField = form.querySelector('input[name="name"]');
    const subject = encodeURIComponent(`${subjectPrefix}${nameField ? " from " + nameField.value : ""}`);

    const lines = [];
    const sourceDetails = {};
    labels.forEach(([id, label]) => {
      const field = document.getElementById(id);
      if (!field || field.type === "file") return;
      const value = field.value.trim();
      if (value) {
        lines.push(`${label}: ${value}`);
        sourceDetails[label] = value;
      }
    });

    // Write to the Leads inbox in Admin (if Supabase is configured) — this
    // is what actually lets an admin see and manage the enquiry, not just
    // receive an email about it. Runs alongside the existing mailto
    // notification, never blocking it: if the database write fails for
    // any reason (offline, RLS misconfigured, etc.) the visitor's email
    // still opens exactly as before, so no enquiry is ever silently lost.
    if (window.supabaseClient && source) {
      const get = id => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };
      window.supabaseClient.from("leads").insert({
        name: coreFields && coreFields.name ? get(coreFields.name) : (nameField ? nameField.value.trim() : null),
        phone: coreFields && coreFields.phone ? get(coreFields.phone) : null,
        whatsapp: coreFields && coreFields.whatsapp ? get(coreFields.whatsapp) : null,
        email: coreFields && coreFields.email ? get(coreFields.email) : null,
        message: coreFields && coreFields.message ? get(coreFields.message) : null,
        property_title_snapshot: coreFields && coreFields.property ? get(coreFields.property) : null,
        source,
        source_details: sourceDetails
      }).then(({ error }) => {
        if (error) console.warn(`Lead saved via email only (database write failed): ${error.message}`);
      });
    }

    window.location.href = `mailto:info@dgssrealty.com?subject=${subject}&body=${encodeURIComponent(lines.join("\n"))}`;
    success.classList.add("show");
    form.reset();
  });
}

function initLeadForms() {
  initLeadForm({
    formId: "listWithUsForm",
    successId: "listWithUsSuccess",
    requiredIds: ["lw-name", "lw-mobile", "lw-type", "lw-location"],
    subjectPrefix: "New Property Listing",
    source: "list_with_us",
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
    formId: "valuationForm",
    successId: "valuationSuccess",
    requiredIds: ["fv-name", "fv-mobile", "fv-location"],
    subjectPrefix: "Free Valuation Request",
    source: "free_valuation",
    coreFields: { name: "fv-name", phone: "fv-mobile", whatsapp: "fv-whatsapp", email: "fv-email" },
    labels: [
      ["fv-name", "Name"], ["fv-mobile", "Mobile"], ["fv-whatsapp", "WhatsApp"], ["fv-email", "Email"],
      ["fv-type", "Property Type"], ["fv-location", "Location"], ["fv-address", "Address"],
      ["fv-size", "Property Size"], ["fv-builtup", "Built-up Area"], ["fv-age", "Property Age"],
      ["fv-price", "Expected Value"], ["fv-details", "Additional Details"]
    ]
  });

  initLeadForm({
    formId: "jointVentureForm",
    successId: "jointVentureSuccess",
    requiredIds: ["jv-name", "jv-phone", "jv-location"],
    subjectPrefix: "Join Venture Enquiry",
    source: "joint_venture",
    coreFields: { name: "jv-name", phone: "jv-phone", email: "jv-email", message: "jv-message" },
    labels: [
      ["jv-name", "Name"], ["jv-phone", "Phone"], ["jv-email", "Email"],
      ["jv-location", "Property/Project Location"], ["jv-type", "Property Type"],
      ["jv-details", "Land Area/Project Details"], ["jv-requirement", "JV Requirement"],
      ["jv-message", "Message"]
    ]
  });

  initLeadForm({
    formId: "nriForm",
    successId: "nriSuccess",
    requiredIds: ["nri-name", "nri-mobile", "nri-email", "nri-country", "nri-requirement"],
    subjectPrefix: "NRI Property Enquiry",
    source: "nri_services",
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
    formId: "enquiryForm",
    successId: "enquirySuccess",
    requiredIds: ["enq-name", "enq-mobile"],
    subjectPrefix: "Property Enquiry",
    source: "property_enquiry",
    coreFields: { name: "enq-name", phone: "enq-mobile", whatsapp: "enq-whatsapp", email: "enq-email", message: "enq-message", property: "enq-property" },
    labels: [
      ["enq-property", "Property"], ["enq-name", "Name"], ["enq-mobile", "Mobile"],
      ["enq-whatsapp", "WhatsApp"], ["enq-email", "Email"], ["enq-message", "Message"]
    ]
  });

  // File input label: reflect the chosen file count so it doesn't look inert.
  const fileInput = document.getElementById("lw-images");
  const fileLabel = document.getElementById("lw-images-label");
  if (fileInput && fileLabel) {
    fileInput.addEventListener("change", () => {
      fileLabel.textContent = fileInput.files.length
        ? `${fileInput.files.length} photo${fileInput.files.length > 1 ? "s" : ""} selected`
        : "Choose photos of the property";
    });
  }
}

function openEnquiryModal(propertyTitle) {
  const nameEl = document.getElementById("enquiry-property-name");
  const hiddenField = document.getElementById("enq-property");
  if (nameEl) nameEl.textContent = propertyTitle;
  if (hiddenField) hiddenField.value = propertyTitle;
  openModal("enquiryModal");
}

/* ==========================================================================
   4. BACK-TO-TOP + SCROLL PROGRESS RING
   ------------------------------------------------------------------------
   Note: the header is a normal in-flow block (not fixed/sticky) per the
   client's requirement — it scrolls away with the page, so there is no
   header scroll-state logic here. The back-to-top button's outer ring
   fills clockwise with the brand orange as the visitor scrolls down the
   page, via the --progress custom property.
   ========================================================================== */
function initHeaderScrollEffects() {
  const ring = document.getElementById("toTopRing");
  const button = document.getElementById("toTop");
  const waFloat = document.querySelector(".wa-float");
  const hero = document.querySelector(".hero");
  if (!ring || !button) return;

  function update() {
    const scrollTop = window.scrollY;
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    const progress = docHeight > 0 ? Math.min(100, (scrollTop / docHeight) * 100) : 0;

    ring.style.setProperty("--progress", progress.toFixed(1));
    ring.classList.toggle("show", scrollTop > 400);

    // Mobile only (see .wa-float CSS): keep the floating WhatsApp button
    // out of the way of the hero's Buy/Sell/Rent/Land + search panel by
    // only revealing it once the hero has scrolled out of view. No effect
    // on desktop, where the button is always visible via CSS.
    if (waFloat && hero) {
      const heroPastView = hero.getBoundingClientRect().bottom <= 0;
      waFloat.classList.toggle("show", heroPastView);
    }
  }

  window.addEventListener("scroll", update);
  update(); // set correct initial state on load, before any scrolling

  button.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
}

/* ==========================================================================
   5. HERO SLIDESHOW
   ------------------------------------------------------------------------
   Crossfades between the .hero-slide layers behind the (fixed-position)
   hero text/CTA/discovery panel — only the background visual changes.
   Each slide's Ken Burns scale (defined in CSS, skipped automatically
   under prefers-reduced-motion) is restarted on activation by toggling
   its inline animation off/on across a forced reflow, so it always plays
   from 100% scale rather than jumping in mid-way.
   All slide <img>s are eager-loaded in the HTML, and warmed here too, so
   the first frame is instant and later ones never show a blank flash.
   Pauses while the tab is hidden (Page Visibility API) to save battery.
   ========================================================================== */
function initHeroSlideshow() {
  const slides = Array.from(document.querySelectorAll(".hero-slide"));
  const dots = Array.from(document.querySelectorAll(".hero-slide-dot"));
  if (slides.length < 2) return; // nothing to cycle

  // Warm the browser cache for every slide up front.
  slides.forEach(slide => {
    const img = slide.querySelector("img");
    if (img && img.src) {
      const preload = new Image();
      preload.src = img.src;
    }
  });

  let index = 0;
  let timer = null;
  const SLIDE_DURATION = 6000; // ms on screen per slide (5–6s per brief)

  function activate(i) {
    slides.forEach((slide, si) => {
      const isActive = si === i;
      slide.classList.toggle("active", isActive);
      if (isActive) {
        const img = slide.querySelector("img");
        if (img) {
          // Force the Ken Burns keyframe animation to restart from 100%
          // scale every time this slide comes back around.
          img.style.animation = "none";
          void img.offsetWidth; // eslint-disable-line no-unused-expressions
          img.style.animation = "";
        }
      }
    });
    dots.forEach((dot, di) => dot.classList.toggle("active", di === i));
    index = i;
  }

  function next() {
    activate((index + 1) % slides.length);
  }

  function start() {
    stop();
    timer = window.setInterval(next, SLIDE_DURATION);
  }

  function stop() {
    if (timer) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stop();
    } else {
      start();
    }
  });

  start();
}

/* ==========================================================================
   5b. HERO PROPERTY-INTENT SELECTOR (Buy / Sell / Rent / Land)
   ------------------------------------------------------------------------
   Segmented-control behaviour: clicking marks that intent active (orange
   highlight) and still takes the visitor to the right section, same as
   the plain links did before.
   ========================================================================== */
function initHeroIntentSelector() {
  const items = document.querySelectorAll(".hero-nav-item");
  if (!items.length) return;

  const targets = { buy: "#properties", sell: "#contact", rent: "#properties", land: "#properties" };

  items.forEach(item => {
    item.addEventListener("click", () => {
      items.forEach(el => el.classList.remove("active"));
      item.classList.add("active");

      const target = document.querySelector(targets[item.dataset.intent] || "#properties");
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

/* ==========================================================================
   6. MOBILE NAVIGATION
   ------------------------------------------------------------------------
   Right-side slide-in drawer: dark overlay behind, page stays visible,
   closes via the close button, overlay click, ESC, or picking a link.
   Body scroll is locked while open and restored on close.
   ========================================================================== */
function initMobileNav() {
  const hamburger = document.getElementById("hamburger");
  const mobileNav = document.getElementById("mobileNav");
  const overlay = document.getElementById("mobileNavOverlay");
  const closeBtn = document.getElementById("mobileNavClose");
  if (!hamburger || !mobileNav || !overlay) return;

  function openDrawer() {
    mobileNav.classList.add("open");
    overlay.classList.add("open");
    hamburger.setAttribute("aria-expanded", "true");
    document.body.classList.add("no-scroll");
  }

  function closeDrawer() {
    mobileNav.classList.remove("open");
    overlay.classList.remove("open");
    hamburger.setAttribute("aria-expanded", "false");
    document.body.classList.remove("no-scroll");
  }

  hamburger.addEventListener("click", () => {
    mobileNav.classList.contains("open") ? closeDrawer() : openDrawer();
  });

  if (closeBtn) closeBtn.addEventListener("click", closeDrawer);
  overlay.addEventListener("click", closeDrawer);

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && mobileNav.classList.contains("open")) closeDrawer();
  });

  mobileNav.querySelectorAll("a").forEach(link =>
    link.addEventListener("click", closeDrawer)
  );
}

/* ==========================================================================
   6b. HERO PROPERTY SEARCH
   ------------------------------------------------------------------------
   Lightweight client-side filter over the existing PROPERTIES data —
   matches the search term against each listing's title and location,
   re-renders the Featured Properties grid, and scrolls it into view.
   No backend/routing involved; the Buy/Sell/Rent/Land bar above it links
   straight to the Properties / Contact sections, same as before.
   ========================================================================== */
function initHeroSearch() {
  const form = document.getElementById("heroSearchForm");
  const input = document.getElementById("heroLocationInput");
  const propertiesSection = document.getElementById("properties");
  if (!form || !input) return;

  form.addEventListener("submit", e => {
    e.preventDefault();
    const query = input.value.trim();

    if (!query) {
      renderProperties();
    } else {
      const needle = query.toLowerCase();
      const matches = PROPERTIES.filter(p =>
        (p.location && p.location.toLowerCase().includes(needle)) ||
        p.title.toLowerCase().includes(needle)
      );
      renderProperties(matches, query);
    }

    if (propertiesSection) {
      propertiesSection.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
}

/* ==========================================================================
   6b. SECTION DOT NAVIGATION
   ------------------------------------------------------------------------
   Drives the fixed right-side dot navigator: clicking a dot smooth-scrolls
   to its section, and an IntersectionObserver keeps the active dot (and
   the matching header/mobile-drawer nav link, matched by data-section)
   in sync as the visitor scrolls. Whichever tracked section currently has
   the largest visible share of the viewport wins.
   ========================================================================== */
function initSectionDots() {
  const dots = Array.from(document.querySelectorAll(".section-dot"));
  if (!dots.length) return;

  // The "top" dot scrolls to #top (the very start of the page) but must
  // watch the .hero section for active-state purposes, not #top itself —
  // #top is the <main> element wrapping the entire page, so its own
  // intersection ratio (intersecting area ÷ its own huge bounding box)
  // would always be tiny and lose to small sections.
  const sections = dots
    .map(dot => {
      const id = dot.dataset.target;
      const scrollEl = document.getElementById(id);
      const observeEl = id === "top" ? document.querySelector(".hero") : scrollEl;
      return { id, scrollEl, observeEl, dot };
    })
    .filter(s => s.scrollEl && s.observeEl);

  if (!sections.length) return;

  const navLinks = document.querySelectorAll("[data-section]");

  function setActive(id) {
    sections.forEach(s => s.dot.classList.toggle("active", s.id === id));
    navLinks.forEach(link => link.classList.toggle("active", link.dataset.section === id));
  }

  dots.forEach(dot => {
    dot.addEventListener("click", () => {
      const target = document.getElementById(dot.dataset.target);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  // Standard "scrollspy" technique: watch for each section crossing a thin
  // horizontal trigger line a little above viewport-center (rootMargin
  // shrinks the observer's effective viewport to just that band), rather
  // than comparing intersection ratios across very differently-sized
  // sections (which "Services" — a small panel nested inside the much
  // larger hero — would otherwise win unfairly on initial load).
  const currentlyIntersecting = new Set();
  const io = new IntersectionObserver(
    entries => {
      entries.forEach(entry => {
        const section = sections.find(s => s.observeEl === entry.target);
        if (!section) return;
        if (entry.isIntersecting) currentlyIntersecting.add(section.id);
        else currentlyIntersecting.delete(section.id);
      });
      // Prefer the last (lowest, most-recently-entered) section touching
      // the trigger line, matching DOM/section order.
      const activeId = sections.map(s => s.id).filter(id => currentlyIntersecting.has(id)).pop();
      if (activeId) setActive(activeId);
    },
    { threshold: 0, rootMargin: "-45% 0px -50% 0px" }
  );

  sections.forEach(s => io.observe(s.observeEl));
  setActive("top");
}

/* ==========================================================================
   7. SCROLL REVEAL ANIMATIONS
   ========================================================================== */
function observeReveal(els) {
  if (!els || !els.length) return;
  const io = new IntersectionObserver(
    (entries, obs) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          obs.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15 }
  );
  els.forEach(el => io.observe(el));
}

function initScrollReveal() {
  // Property cards observe themselves (see renderProperties) since they're
  // rebuilt on every search — everything else is observed once here.
  const els = Array.from(document.querySelectorAll(".reveal")).filter(
    el => !el.closest("#propertyGrid")
  );
  observeReveal(els);
}

/* ==========================================================================
   8. CONTACT FORM HANDLING
   ========================================================================== */
function initContactForm() {
  const form = document.getElementById("contactForm");
  const success = document.getElementById("formSuccess");
  if (!form || !success) return;

  form.addEventListener("submit", function (e) {
    e.preventDefault();

    const nameField = document.getElementById("cf-name");
    const phoneField = document.getElementById("cf-phone");
    const emailField = document.getElementById("cf-email");
    const messageField = document.getElementById("cf-message");

    const isValid = [nameField, phoneField, emailField, messageField]
      .map(field => {
        const wrapper = field.closest(".field");
        const valid = field.value.trim().length > 0 && field.checkValidity();
        wrapper.classList.toggle("invalid", !valid);
        return valid;
      })
      .every(Boolean);

    if (!isValid) return;

    // Same pattern as the other lead forms: write to the Admin Leads
    // inbox (if configured) alongside the existing mailto notification,
    // without ever blocking or depending on it.
    if (window.supabaseClient) {
      window.supabaseClient.from("leads").insert({
        name: nameField.value.trim(),
        phone: phoneField.value.trim(),
        email: emailField.value.trim(),
        message: messageField.value.trim(),
        source: "contact_form"
      }).then(({ error }) => {
        if (error) console.warn(`Lead saved via email only (database write failed): ${error.message}`);
      });
    }

    const subject = encodeURIComponent(`New Enquiry from ${nameField.value}`);
    const body = encodeURIComponent(
      `Name: ${nameField.value}\nPhone: ${phoneField.value}\nEmail: ${emailField.value}\n\nMessage:\n${messageField.value}`
    );

    window.location.href = `mailto:info@dgssrealty.com?subject=${subject}&body=${body}`;
    success.classList.add("show");
    form.reset();
  });
}

/* ==========================================================================
   9. FOOTER YEAR
   ========================================================================== */
function setFooterYear() {
  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();
}

/* ==========================================================================
   10. INIT
   ========================================================================== */
document.addEventListener("DOMContentLoaded", async () => {
  renderProperties(); // paint immediately with fallback data — no blank/loading flash
  initPropertyModal();
  initModalTriggers();
  initLeadForms();
  initHeaderScrollEffects();
  initHeroSlideshow();
  initHeroIntentSelector();
  initMobileNav();
  initSectionDots();
  initHeroSearch();
  initScrollReveal();
  initContactForm();
  setFooterYear();
  await loadPropertiesFromSupabase(); // swaps in live data if/once it's ready
  await loadTestimonialsFromSupabase(); // same pattern — swaps in published testimonials if/once any exist
  await loadFounderFromSupabase(); // same pattern — swaps in admin-managed founder content if/once it exists
  openPropertyFromUrl(); // runs after, so a shared link resolves against live data
});
