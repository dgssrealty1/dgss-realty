const AMENITIES_LIST = [
  "Car Parking", "Lift", "Power Backup", "Security", "CCTV", "Gated Community",
  "Swimming Pool", "Gym", "Clubhouse", "Garden", "Balcony", "Private Terrace",
  "Water Supply", "EB Connection", "Rainwater Harvesting", "Metro Water",
  "Borewell", "Pet Friendly", "Corner Property", "Main Road Property", "Sea View", "Other"
];

const SITE_ORIGIN = "https://dgssrealty.com";
const MARKET_STATUSES = ["Available", "Under Offer", "Sold", "Rented", "Leased", "Inactive"];
const INTERNAL_FIELDS = ["owner_name", "owner_phone", "mandate", "listing_date", "expiry_date", "acquisition_source", "internal_notes"];

// Every field id in the form maps 1:1 to a `properties` column via the
// "f-<column_name>" convention, so load/save can loop instead of listing
// every field twice.
const TEXT_FIELDS = [
  "title", "reference_id", "category", "listing_type", "status",
  "location", "locality", "city", "state", "pincode", "full_address",
  "google_maps_url", "latitude", "longitude",
  "display_price", "price_per_sqft", "price",
  "land_area", "builtup_area", "carpet_area", "uds", "plot_area", "area_unit",
  "bedrooms", "bathrooms", "balconies", "car_parking", "property_age",
  "floor_number", "total_floors", "facing", "furnishing", "possession_status",
  "road_width", "frontage", "depth", "approval_authority", "rera_info",
  "short_description", "full_description", "nearby_landmarks",
  "video_youtube_url", "video_instagram_url", "video_other_url",
  "slug", "seo_title", "seo_description", "canonical_url", "og_image_url"
];
const NUMERIC_FIELDS = ["price", "price_per_sqft", "bedrooms", "bathrooms", "balconies", "latitude", "longitude"];
const INTEGER_FIELDS = ["bedrooms", "bathrooms", "balconies"];
const URL_FIELDS = ["google_maps_url", "video_youtube_url", "video_instagram_url", "video_other_url", "canonical_url", "og_image_url"];
const CHECKBOX_FIELDS = ["is_negotiable", "is_price_on_request"];
const REQUIRED_FIELDS = { title: "Property title", category: "Category", listing_type: "Listing type", location: "Location" };
const FIELD_TAB = {}; // field -> tab name, filled from the DOM on load

let editingPropertyId = null;
let loadedProperty = null;     // last saved state from the database
let currentImages = [];
let draggedImageId = null;
let isDirty = false;
let isSaving = false;
let loadedInternal = null;     // property_internal row (staff only)
let internalDirty = false;

async function loadPropertyEditPage() {
  const session = await requireAdminAuth("staff");
  if (!session) return;
  watchAuthState();
  renderAdminShell();

  const content = document.getElementById("adminContent");
  const template = document.getElementById("propertyEditTemplate");
  content.appendChild(template.content.cloneNode(true));

  initTabs();
  renderAmenitiesChecklist();
  initImageUpload();
  addInlineErrorSlots();
  initSeoCounters();
  initSlugPreview();
  initBusinessRuleChecks();
  initInternalTab();

  editingPropertyId = new URLSearchParams(window.location.search).get("id");
  if (editingPropertyId) {
    const ok = await loadExistingProperty(editingPropertyId);
    if (!ok) return;
  }

  applyRolePermissions();
  updateActionButtons();

  document.getElementById("saveBtn").addEventListener("click", () => saveProperty("save"));
  document.getElementById("publishBtn").addEventListener("click", () => saveProperty("publish"));
  document.getElementById("unpublishBtn").addEventListener("click", () => saveProperty("unpublish"));
  document.getElementById("submitReviewBtn").addEventListener("click", () => saveProperty("submit_review"));
  document.getElementById("approveBtn").addEventListener("click", () => saveProperty("approve"));
  document.getElementById("returnDraftBtn").addEventListener("click", () => saveProperty("to_draft"));
  document.getElementById("archiveBtn").addEventListener("click", toggleArchive);
  document.getElementById("duplicateBtn").addEventListener("click", duplicateProperty);
  document.getElementById("previewBtn").addEventListener("click", previewProperty);

  // Unsaved-changes guard.
  const form = document.getElementById("propertyForm");
  form.addEventListener("input", markDirty);
  form.addEventListener("change", markDirty);
  window.addEventListener("beforeunload", e => {
    if (isDirty) { e.preventDefault(); e.returnValue = ""; }
  });
}

function markDirty(e) {
  if (e && e.target && e.target.closest && e.target.closest("#imageGrid, #imageDropzone")) return;
  if (e && e.target && e.target.id && e.target.id.startsWith("i-")) internalDirty = true;
  isDirty = true;
  const status = document.getElementById("propertyFormStatus");
  if (status && !isSaving) status.textContent = "Unsaved changes";
}

function initTabs() {
  const tabs = document.querySelectorAll(".pe-tab");
  tabs.forEach(tab => {
    tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  });
  document.querySelectorAll(".pe-panel").forEach(panel => {
    panel.querySelectorAll("[id^='f-']").forEach(el => { FIELD_TAB[el.id.slice(2)] = panel.dataset.panel; });
  });
}

function activateTab(name) {
  document.querySelectorAll(".pe-tab").forEach(t => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".pe-panel").forEach(p => p.classList.toggle("active", p.dataset.panel === name));
}

function renderAmenitiesChecklist() {
  const grid = document.getElementById("amenitiesGrid");
  grid.innerHTML = AMENITIES_LIST.map(a => `
    <label class="admin-checkbox">
      <input type="checkbox" value="${esc(a)}" class="amenity-checkbox">
      ${esc(a)}
    </label>
  `).join("");
}

/* Adds an (initially hidden) error line under every field so validation
   messages appear right next to the problem. */
function addInlineErrorSlots() {
  document.querySelectorAll("#propertyForm [id^='f-']").forEach(el => {
    const field = el.closest(".admin-field");
    if (!field || field.querySelector(".admin-field-error")) return;
    const msg = document.createElement("span");
    msg.className = "admin-field-error";
    msg.id = `${el.id}-error`;
    field.appendChild(msg);
    el.setAttribute("aria-describedby", msg.id);
  });
}

function initSeoCounters() {
  [["f-seo_title", 60], ["f-seo_description", 160]].forEach(([id, limit]) => {
    const input = document.getElementById(id);
    if (!input) return;
    const counter = document.createElement("span");
    counter.className = "admin-char-count";
    input.insertAdjacentElement("afterend", counter);
    const update = () => {
      const n = input.value.length;
      counter.textContent = `${n} / ${limit} characters${n === 0 ? " — leave blank to use an automatic one" : ""}`;
      counter.classList.toggle("over", n > limit);
    };
    input.addEventListener("input", update);
    input._updateCounter = update;
    update();
  });
}

function initSlugPreview() {
  const slugInput = document.getElementById("f-slug");
  const preview = document.createElement("div");
  preview.className = "admin-slug-preview";
  preview.id = "slugPreview";
  slugInput.insertAdjacentElement("afterend", preview);
  const update = () => {
    const typed = slugify(slugInput.value);
    const fallback = slugify([document.getElementById("f-title").value, document.getElementById("f-location").value].filter(Boolean).join(" "));
    const slug = typed || (loadedProperty && loadedProperty.slug) || fallback || "…";
    let text = `Public URL: ${SITE_ORIGIN}/properties/${slug}/`;
    if (loadedProperty && loadedProperty.is_published && typed && typed !== loadedProperty.slug) {
      text += "  — the old URL will automatically redirect here.";
    } else if (!typed && !loadedProperty) {
      text += "  (generated automatically when you save; the database adds -2, -3… if it's already taken)";
    }
    preview.textContent = text;
  };
  ["f-slug", "f-title", "f-location"].forEach(id => document.getElementById(id).addEventListener("input", update));
  slugInput._updatePreview = update;
  update();
}

async function loadExistingProperty(id) {
  const { data, error } = await window.supabaseClient
    .from("properties").select("*, property_images(*)").eq("id", id).single();

  if (error || !data) {
    console.error("Property load failed:", error);
    const content = document.getElementById("adminContent");
    content.innerHTML = "";
    const box = document.createElement("div");
    box.className = "admin-card admin-empty";
    box.style.padding = "40px";
    box.textContent = "This property couldn't be loaded — it may have been deleted, or your role can't see it.";
    content.appendChild(box);
    return false;
  }

  fillForm(data);
  currentImages = (data.property_images || []).sort((a, b) => a.sort_order - b.sort_order);
  await attachAdminImageUrls(currentImages);
  renderImageGrid();
  await loadInternalData(id);
  return true;
}

/* ---------- Business rules (mirror of the database trigger) ---------- */
function initBusinessRuleChecks() {
  const lt = document.getElementById("f-listing_type");
  const st = document.getElementById("f-status");
  const sync = () => {
    const allowed = window.DGSSRules.allowedStatuses(lt.value, MARKET_STATUSES);
    Array.from(st.options).forEach(o => { o.disabled = !allowed.includes(o.value); });
    const problem = window.DGSSRules.listingStatusProblem(lt.value, st.value);
    if (problem) setFieldError("status", problem); else clearFieldError("status");
  };
  lt.addEventListener("change", sync);
  st.addEventListener("change", sync);
  lt._syncRules = sync;

  ["f-price", "f-display_price", "f-is_price_on_request", "f-listing_type"].forEach(id =>
    document.getElementById(id).addEventListener("input", updatePriceCheck));
  document.getElementById("f-is_price_on_request").addEventListener("change", updatePriceCheck);
  document.getElementById("suggestDisplayPrice").addEventListener("click", () => {
    const n = Number(document.getElementById("f-price").value);
    const text = window.DGSSRules.formatInr(n, document.getElementById("f-listing_type").value);
    if (!text) { showAdminToast("Enter the numeric price first.", "error"); document.getElementById("f-price").focus(); return; }
    document.getElementById("f-display_price").value = text;
    markDirty();
    updatePriceCheck();
  });
}

/* Shows how the price will appear publicly and warns about mismatches.
   Never changes what the admin typed. */
function updatePriceCheck() {
  const box = document.getElementById("priceCheck");
  if (!box) return;
  const priceRaw = document.getElementById("f-price").value.trim();
  const price = priceRaw === "" ? null : Number(priceRaw);
  const display = document.getElementById("f-display_price").value.trim();
  const por = document.getElementById("f-is_price_on_request").checked;
  const lt = document.getElementById("f-listing_type").value;
  const auto = window.DGSSRules.formatInr(price, lt);
  let html = "";
  let warn = false;
  if (por) {
    html = "Shown on the website as <strong>Price on Request</strong>." + (price ? " The numeric price is kept for sorting and the budget filter only." : "");
  } else if (display) {
    html = `Shown on the website as <strong>${esc(display)}</strong>.`;
    const mm = window.DGSSRules.priceMismatch(price, display);
    if (mm) {
      warn = true;
      html += ` ⚠ This doesn't match the numeric price (${esc(auto)} vs about ${esc(window.DGSSRules.formatInr(mm.parsed, ""))}). Check which one is right.`;
    }
  } else if (auto) {
    html = `Shown on the website as <strong>${esc(auto)}</strong>.`;
  } else {
    html = "No price entered — the website will show <strong>Price on Request</strong>.";
  }
  box.innerHTML = html;
  box.classList.toggle("is-warning", warn);
  return warn;
}

/* ---------- Internal (staff-only) data ---------- */
function initInternalTab() {
  const tab = document.getElementById("internalTab");
  if (tab) tab.hidden = !adminCan("internalRead");
  ["i-listing_date", "i-expiry_date"].forEach(id => document.getElementById(id).addEventListener("change", updateMandateBadge));
}

async function loadInternalData(propertyId) {
  if (!adminCan("internalRead")) return;
  const { data, error } = await window.supabaseClient.from("property_internal").select("*").eq("property_id", propertyId).maybeSingle();
  if (error) { console.warn("Internal data not loaded:", error.message); return; }
  loadedInternal = data;
  INTERNAL_FIELDS.forEach(f => {
    const el = document.getElementById(`i-${f}`);
    if (el) el.value = data && data[f] != null ? data[f] : "";
  });
  internalDirty = false;
  updateMandateBadge();
}

function updateMandateBadge() {
  const badge = document.getElementById("mandateBadge");
  if (!badge) return;
  const exp = document.getElementById("i-expiry_date").value;
  const today = new Date().toISOString().slice(0, 10);
  if (exp && exp < today) { badge.hidden = false; badge.textContent = `Mandate expired ${formatDate(exp)}`; badge.className = "admin-badge admin-badge-red"; }
  else if (exp && exp <= new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10)) { badge.hidden = false; badge.textContent = `Mandate expires ${formatDate(exp)}`; badge.className = "admin-badge admin-badge-amber"; }
  else badge.hidden = true;
}

async function saveInternalData() {
  if (!internalDirty || !editingPropertyId || !adminCan("contentEditors")) return true;
  const row = { property_id: editingPropertyId };
  INTERNAL_FIELDS.forEach(f => { const v = document.getElementById(`i-${f}`).value.trim(); row[f] = v === "" ? null : v; });
  if (row.listing_date && row.expiry_date && row.expiry_date < row.listing_date) {
    showAdminToast("Mandate expiry can't be before the listing date.", "error");
    activateTab("internal");
    return false;
  }
  const { data, error } = await window.supabaseClient.from("property_internal").upsert(row, { onConflict: "property_id" }).select().single();
  if (error) { showAdminToast("Internal details not saved: " + friendlyError(error), "error"); return false; }
  loadedInternal = data;
  internalDirty = false;
  return true;
}

function fillForm(data) {
  loadedProperty = data;
  setTimeout(() => {
    const lt = document.getElementById("f-listing_type");
    if (lt && lt._syncRules) lt._syncRules();
    updatePriceCheck();
  }, 0);
  TEXT_FIELDS.forEach(field => {
    const el = document.getElementById(`f-${field}`);
    if (el) el.value = data[field] != null ? data[field] : (el.tagName === "SELECT" ? el.options[0].value : "");
  });
  CHECKBOX_FIELDS.forEach(field => {
    const el = document.getElementById(`f-${field}`);
    if (el) el.checked = !!data[field];
  });
  document.getElementById("f-highlights").value = (data.highlights || []).join("\n");
  const amenitySet = new Set(data.amenities || []);
  document.querySelectorAll(".amenity-checkbox").forEach(cb => { cb.checked = amenitySet.has(cb.value); });
  ["f-seo_title", "f-seo_description"].forEach(id => { const el = document.getElementById(id); if (el && el._updateCounter) el._updateCounter(); });
  const slugInput = document.getElementById("f-slug");
  if (slugInput._updatePreview) slugInput._updatePreview();
}

function clearFieldErrors() {
  document.querySelectorAll("#propertyForm .admin-field.invalid").forEach(f => f.classList.remove("invalid"));
}
function clearFieldError(field) {
  const el = document.getElementById(`f-${field}`);
  const wrap = el && el.closest(".admin-field");
  if (wrap) wrap.classList.remove("invalid");
  if (el) el.setAttribute("aria-invalid", "false");
}

function setFieldError(field, message) {
  const el = document.getElementById(`f-${field}`);
  if (!el) return;
  const wrap = el.closest(".admin-field");
  if (wrap) wrap.classList.add("invalid");
  el.setAttribute("aria-invalid", "true");
  const msg = document.getElementById(`f-${field}-error`);
  if (msg) msg.textContent = message;
}

/* Validates without touching what the user typed. Returns a list of
   { field, message } — empty when everything is fine. */
function validateForm() {
  const errors = [];
  Object.entries(REQUIRED_FIELDS).forEach(([field, label]) => {
    const el = document.getElementById(`f-${field}`);
    if (!el || !el.value.trim()) errors.push({ field, message: `${label} is required.` });
  });
  const title = document.getElementById("f-title").value.trim();
  if (title && title.length > 150) errors.push({ field: "title", message: "Keep the title under 150 characters." });

  NUMERIC_FIELDS.forEach(field => {
    const el = document.getElementById(`f-${field}`);
    if (!el || el.value.trim() === "") return;
    const n = Number(el.value.trim());
    if (!Number.isFinite(n)) { errors.push({ field, message: "Enter a number only (no ₹, commas or words)." }); return; }
    if (n < 0 && !["latitude", "longitude"].includes(field)) errors.push({ field, message: "Can't be negative." });
    if (INTEGER_FIELDS.includes(field) && (!Number.isInteger(n) || n > 50)) errors.push({ field, message: "Enter a whole number (0–50)." });
    if (field === "latitude" && (n < -90 || n > 90)) errors.push({ field, message: "Latitude must be between -90 and 90." });
    if (field === "longitude" && (n < -180 || n > 180)) errors.push({ field, message: "Longitude must be between -180 and 180." });
  });

  URL_FIELDS.forEach(field => {
    const el = document.getElementById(`f-${field}`);
    if (!el || !el.value.trim()) return;
    if (!/^https?:\/\/\S+$/i.test(el.value.trim())) errors.push({ field, message: "Enter a full link starting with https://" });
  });

  const canonical = document.getElementById("f-canonical_url").value.trim();
  if (canonical && !canonical.startsWith(SITE_ORIGIN + "/")) {
    errors.push({ field: "canonical_url", message: `Must be a ${SITE_ORIGIN}/ address — or leave blank (recommended).` });
  }

  const slugRaw = document.getElementById("f-slug").value.trim();
  if (slugRaw && !slugify(slugRaw)) errors.push({ field: "slug", message: "Use letters, numbers and hyphens only." });

  const pincode = document.getElementById("f-pincode").value.trim();
  if (pincode && !/^\d{6}$/.test(pincode)) errors.push({ field: "pincode", message: "Pincode should be 6 digits." });

  const statusProblem = window.DGSSRules.listingStatusProblem(
    document.getElementById("f-listing_type").value, document.getElementById("f-status").value);
  if (statusProblem) errors.push({ field: "status", message: statusProblem });

  const displayPrice = document.getElementById("f-display_price").value.trim();
  if (displayPrice.length > 80) errors.push({ field: "display_price", message: "Keep the display price under 80 characters." });

  return errors;
}

function collectFormData() {
  const payload = {};
  TEXT_FIELDS.forEach(field => {
    const el = document.getElementById(`f-${field}`);
    if (!el) return;
    const val = el.value.trim();
    if (NUMERIC_FIELDS.includes(field)) {
      payload[field] = val === "" ? null : Number(val);
    } else {
      payload[field] = val === "" ? null : val;
    }
  });
  CHECKBOX_FIELDS.forEach(field => {
    payload[field] = document.getElementById(`f-${field}`).checked;
  });

  payload.highlights = document.getElementById("f-highlights").value
    .split("\n").map(s => s.trim()).filter(Boolean);
  payload.amenities = Array.from(document.querySelectorAll(".amenity-checkbox:checked")).map(cb => cb.value);

  // Slug: blank = let the database generate a clean unique one from the
  // title + location. On an existing property, blank keeps the current slug.
  if (payload.slug) {
    payload.slug = slugify(payload.slug);
  } else if (loadedProperty) {
    payload.slug = loadedProperty.slug;
  } else {
    payload.slug = "";
  }
  return payload;
}

function slugify(text) {
  return String(text || "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/* mode: "save" keeps the current published state; "publish"/"unpublish"
   change it (admins only — the database also enforces this). */
async function saveProperty(mode) {
  if (isSaving) return false;
  const statusEl = document.getElementById("propertyFormStatus");
  clearFieldErrors();

  const errors = validateForm();
  if (errors.length) {
    errors.forEach(e => setFieldError(e.field, e.message));
    activateTab(FIELD_TAB[errors[0].field] || "basic");
    const first = document.getElementById(`f-${errors[0].field}`);
    if (first) first.focus();
    statusEl.textContent = `Please fix ${errors.length} field${errors.length > 1 ? "s" : ""} before saving.`;
    showAdminToast("Some fields need attention — nothing was lost.", "error");
    return false;
  }

  const payload = collectFormData();
  if (updatePriceCheck() && !window.confirm("The display price and the numeric price don't match. Save anyway?")) {
    activateTab("price");
    return false;
  }
  if (mode === "publish") {
    if (!window.confirm(`Publish "${payload.title}"? It will be visible on the public website.`)) return false;
    payload.is_published = true;
  } else if (mode === "unpublish") {
    if (!window.confirm(`Unpublish "${payload.title}"? Its public page will stop working until it's published again.`)) return false;
    payload.is_published = false;
  } else if (mode === "submit_review") {
    payload.review_status = "under_review";
  } else if (mode === "approve") {
    if (!window.confirm(`Approve "${payload.title}"? It can then be published.`)) return false;
    payload.review_status = "approved";
  } else if (mode === "to_draft") {
    payload.review_status = "draft";
  }

  isSaving = true;
  setActionsBusy(true);
  statusEl.textContent = "Saving…";
  const prevReview = loadedProperty ? loadedProperty.review_status : null;

  let result;
  if (editingPropertyId) {
    result = await window.supabaseClient.from("properties").update(payload).eq("id", editingPropertyId).select().single();
  } else {
    result = await window.supabaseClient.from("properties").insert(payload).select().single();
  }

  isSaving = false;
  setActionsBusy(false);

  if (result.error) {
    console.error("Property save failed:", result.error);
    statusEl.textContent = "Not saved — your changes are still here.";
    showAdminToast("Save failed: " + friendlyDbError(result.error), "error");
    return false;
  }

  const wasNew = !editingPropertyId;
  editingPropertyId = result.data.id;
  fillForm({ ...result.data, property_images: undefined });
  const internalOk = await saveInternalData();
  isDirty = !internalOk;
  window.history.replaceState({}, "", `property-edit.html?id=${encodeURIComponent(editingPropertyId)}`);
  statusEl.textContent = `Saved · ${new Date().toLocaleTimeString()}`;
  updateActionButtons();
  if (internalOk) {
    const reverted = mode === "save" && prevReview === "approved" && loadedProperty.review_status === "under_review";
    showAdminToast(
      mode === "publish" ? "Property published — live on the website within a few seconds." :
      mode === "unpublish" ? "Property unpublished." :
      mode === "submit_review" ? "Submitted for review. An admin will approve and publish it." :
      mode === "approve" ? "Approved. It can now be published." :
      mode === "to_draft" ? "Sent back to draft." :
      wasNew ? "Draft created. You can add images now." :
      reverted ? "Changes saved — sent back to review because it had already been approved." : "Changes saved.",
      "success"
    );
  }
  return true;
}

function friendlyDbError(error) {
  const msg = error.message || "";
  if (error.code === "23505" || /duplicate key/.test(msg)) return "That URL slug is already used by another property.";
  if (/check constraint/.test(msg)) return "One of the values isn't allowed (check category, listing type, status and numbers).";
  return friendlyError(error);
}

function setActionsBusy(busy) {
  document.querySelectorAll(".pe-actions-bar button").forEach(b => { b.disabled = busy || b.dataset.locked === "1"; });
}

/* Shows only the buttons this role can use, in the right state. */
function updateActionButtons() {
  const canEdit = adminCan("contentEditors");
  const canPublish = adminCan("publishers");
  const p = loadedProperty;
  const show = (id, visible) => { const el = document.getElementById(id); if (el) el.style.display = visible ? "" : "none"; };

  const live = p && p.is_published;
  const archived = p && p.is_archived;
  const review = p ? p.review_status : "draft";
  show("saveBtn", canEdit);
  document.getElementById("saveBtn").textContent = !p ? "Save Draft" : "Save Changes";
  // Editors: Draft → Submit for Review. Admins: Approve → Publish.
  show("submitReviewBtn", canEdit && !canPublish && p && !live && !archived && review === "draft");
  show("approveBtn", canPublish && p && !live && !archived && review === "under_review");
  show("returnDraftBtn", canPublish && p && !live && !archived && review !== "draft");
  show("publishBtn", canPublish && !live && !archived);
  show("unpublishBtn", canPublish && live);
  show("archiveBtn", canPublish && !!p);
  document.getElementById("archiveBtn").textContent = archived ? "Unarchive" : "Archive";
  show("duplicateBtn", canEdit && !!p);
  show("previewBtn", !!p);

  const badge = document.getElementById("propertyStateBadge");
  if (badge) {
    const stage = propertyStage(p);
    badge.textContent = stage.label;
    badge.className = "admin-badge " + stage.cls;
  }
  const status = document.getElementById("propertyFormStatus");
  if (status && canEdit && !canPublish && !isDirty) {
    status.textContent = live ? "Live on the website." : review === "under_review" ? "Waiting for an admin to approve." :
      review === "approved" ? "Approved — an admin will publish it." : "Editors can't publish: submit for review when ready.";
  }
}

/* Sales / viewer roles can open a property but not change it. */
function applyRolePermissions() {
  if (adminCan("contentEditors")) return;
  document.querySelectorAll("#propertyForm input, #propertyForm select, #propertyForm textarea").forEach(el => { el.disabled = true; });
  const dz = document.getElementById("imageDropzone");
  if (dz) dz.style.display = "none";
  const note = document.getElementById("propertyFormStatus");
  if (note) note.textContent = "Read-only — your role can view but not edit properties.";
}

async function toggleArchive() {
  if (!loadedProperty) return;
  const archiving = !loadedProperty.is_archived;
  const msg = archiving
    ? `Archive "${loadedProperty.title}"? It will be removed from the website and hidden from the main list.`
    : `Unarchive "${loadedProperty.title}"? It comes back as it was (published or draft).`;
  if (!window.confirm(msg)) return;
  if (isDirty && !window.confirm("You have unsaved changes that will NOT be saved by this action. Continue?")) return;

  const { data, error } = await window.supabaseClient.from("properties")
    .update({ is_archived: archiving }).eq("id", editingPropertyId).select().single();
  if (error) { showAdminToast("Couldn't update: " + friendlyDbError(error), "error"); return; }
  loadedProperty = data;
  updateActionButtons();
  showAdminToast(archiving ? "Property archived." : "Property unarchived.", "success");
}

async function duplicateProperty() {
  if (!loadedProperty) return;
  if (isDirty && !window.confirm("Duplicate the last SAVED version? Your unsaved changes won't be included.")) return;
  const copy = { ...loadedProperty };
  ["id", "created_at", "updated_at", "property_images"].forEach(k => delete copy[k]);
  copy.title = `${copy.title} (Copy)`;
  copy.slug = `${copy.slug}-copy`;
  copy.is_published = false;
  copy.is_archived = false;
  copy.is_featured = false;
  copy.review_status = "draft";        // a copy is a new draft, never pre-approved
  delete copy.seo_keywords;
  const { data, error } = await window.supabaseClient.from("properties").insert(copy).select().single();
  if (error) { showAdminToast("Duplicate failed: " + friendlyDbError(error), "error"); return; }
  isDirty = false;
  showAdminToast("Duplicated as a draft (images aren't copied).", "success");
  window.location.href = `property-edit.html?id=${encodeURIComponent(data.id)}`;
}

/* Published properties open their real public page. Drafts can't be seen
   by the public, so the site's Worker renders a private, no-index
   preview using the signed-in admin's own session (the database decides
   whether this admin may see the draft). */
async function previewProperty() {
  if (!loadedProperty) { showAdminToast("Save the property first, then preview.", "error"); return; }
  if (isDirty) showAdminToast("Preview shows the last SAVED version.", "");

  if (loadedProperty.is_published && !loadedProperty.is_archived) {
    window.open(`/properties/${encodeURIComponent(loadedProperty.slug)}/`, "_blank", "noopener");
    return;
  }

  const win = window.open("", "_blank");
  try {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    const res = await fetch("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ id: loadedProperty.id })
    });
    if (!res.ok) throw new Error(`Preview service returned ${res.status}`);
    const html = await res.text();
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    if (win) win.location.href = url; else window.open(url, "_blank");
  } catch (err) {
    console.error("Preview failed:", err);
    if (win) win.close();
    showAdminToast("Draft preview is only available on the deployed site (it needs the site's Worker).", "error");
  }
}

/* ---------- Images ---------- */
function initImageUpload() {
  const dropzone = document.getElementById("imageDropzone");
  const input = document.getElementById("imageFileInput");

  input.addEventListener("change", () => { handleImageFiles(input.files); input.value = ""; });

  dropzone.addEventListener("dragover", e => { e.preventDefault(); dropzone.classList.add("dragover"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", e => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    handleImageFiles(e.dataTransfer.files);
  });
}

async function handleImageFiles(fileList) {
  if (!adminCan("contentEditors")) return;
  if (!editingPropertyId) {
    // Images attach to a saved property — save a draft first, automatically.
    showAdminToast("Saving a draft first so images have somewhere to go…", "");
    const saved = await saveProperty("save");
    if (!saved) return;
  }

  const files = Array.from(fileList).filter(f => {
    const validType = ["image/jpeg", "image/png", "image/webp", "image/avif"].includes(f.type);
    const validSize = f.size <= 8 * 1024 * 1024;
    if (!validType) showAdminToast(`${f.name}: unsupported file type (use JPG, PNG, WebP or AVIF).`, "error");
    else if (!validSize) showAdminToast(`${f.name}: file too large (max 8MB).`, "error");
    return validType && validSize;
  });
  if (!files.length) return;

  const progressWrap = document.getElementById("uploadProgressWrap");
  const progressFill = document.getElementById("uploadProgressFill");
  const progressLabel = document.getElementById("uploadProgressLabel");
  progressWrap.style.display = "block";

  const defaultAlt = [document.getElementById("f-title").value.trim(), document.getElementById("f-location").value.trim()]
    .filter(Boolean).join(", ");
  let uploaded = 0;
  let failed = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    progressLabel.textContent = `Uploading ${i + 1} of ${files.length}: ${file.name}`;
    progressFill.style.width = `${Math.round((i / files.length) * 100)}%`;

    // Safe path: <propertyId>/<timestamp>-<random>.<ext>. Never uses the
    // original filename, never collides, and the Storage policy only
    // accepts uploads inside an existing property's folder.
    const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" }[file.type];
    const safeName = `${editingPropertyId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const { error: uploadError } = await window.supabaseClient.storage
      .from("property-images").upload(safeName, file, { cacheControl: "31536000", upsert: false, contentType: file.type });

    if (uploadError) {
      failed++;
      console.error("Upload failed:", file.name, uploadError);
      showAdminToast(`${file.name}: upload failed — ${uploadError.message}`, "error");
      continue;
    }


    const isFirstImageEver = currentImages.length === 0;
    const { data: imgRow, error: insertError } = await window.supabaseClient
      .from("property_images")
      .insert({
        property_id: editingPropertyId,
        storage_path: safeName,
        // Public address served by the site's Worker (only works once the
        // property is published — see migration 04).
        public_url: `/media/property-images/${safeName}`,
        alt_text: defaultAlt ? `${defaultAlt} — photo ${currentImages.length + 1}` : "",
        is_featured_image: isFirstImageEver,
        sort_order: currentImages.length
      })
      .select().single();

    if (insertError) {
      failed++;
      // Don't leave an orphaned file behind if the record couldn't be saved.
      const { error: rmError } = await window.supabaseClient.storage.from("property-images").remove([safeName]);
      if (rmError) console.warn("Uploaded file left behind (shows in Media → Storage clean-up):", safeName, rmError);
      showAdminToast(`${file.name}: couldn't be recorded — ${friendlyError(insertError)}`, "error");
      continue;
    }

    uploaded++;
    await attachAdminImageUrls([imgRow]);
    currentImages.push(imgRow);
    renderImageGrid();
  }

  progressFill.style.width = "100%";
  progressLabel.textContent = `${uploaded} uploaded${failed ? `, ${failed} failed` : ""}.`;
  setTimeout(() => { progressWrap.style.display = "none"; progressFill.style.width = "0%"; }, 1500);
  renderImageGrid();
  if (uploaded) showAdminToast(`${uploaded} image${uploaded > 1 ? "s" : ""} uploaded. Add a short description (ALT text) to each.`, "success");
}

function renderImageGrid() {
  const grid = document.getElementById("imageGrid");
  const canEdit = adminCan("contentEditors");
  if (!currentImages.length) {
    grid.innerHTML = `<div class="admin-empty" style="grid-column:1/-1;">No images yet. The public page shows a neutral placeholder until you add some.</div>`;
    return;
  }
  grid.innerHTML = currentImages.map((img, idx) => `
    <div class="admin-image-cell">
      <div class="admin-image-item ${img.is_featured_image ? "featured" : ""}" draggable="${canEdit}" data-image-id="${esc(img.id)}">
        ${img.is_featured_image ? '<span class="admin-image-featured-tag">Featured</span>' : ""}
        <img src="${safeUrl(img.displayUrl || img.public_url)}" alt="${esc(img.alt_text || "")}" loading="lazy">
        ${canEdit ? `<div class="admin-image-actions">
          <button type="button" data-set-featured="${esc(img.id)}" aria-label="Set image ${idx + 1} as featured image" title="Set as featured image">
            <svg viewBox="0 0 24 24" fill="${img.is_featured_image ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          </button>
          <button type="button" data-delete-image="${esc(img.id)}" aria-label="Delete image ${idx + 1}" title="Delete image">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        </div>` : ""}
      </div>
      ${canEdit ? `
        <div class="admin-image-move">
          <button type="button" data-move="${esc(img.id)}" data-dir="-1" ${idx === 0 ? "disabled" : ""} aria-label="Move image ${idx + 1} earlier">←</button>
          <button type="button" data-move="${esc(img.id)}" data-dir="1" ${idx === currentImages.length - 1 ? "disabled" : ""} aria-label="Move image ${idx + 1} later">→</button>
        </div>
        <label class="sr-only" for="alt-${esc(img.id)}">ALT text for image ${idx + 1}</label>
        <input type="text" class="admin-image-alt" id="alt-${esc(img.id)}" data-alt-for="${esc(img.id)}" maxlength="200" placeholder="Describe this photo (ALT text)">
      ` : ""}
    </div>
  `).join("");

  // ALT values set via .value so nothing typed can break the markup.
  grid.querySelectorAll("[data-alt-for]").forEach(input => {
    const img = currentImages.find(i => i.id === input.dataset.altFor);
    input.value = img ? (img.alt_text || "") : "";
    input.addEventListener("change", () => saveAltText(input.dataset.altFor, input.value.trim()));
  });
  grid.querySelectorAll("[data-set-featured]").forEach(btn =>
    btn.addEventListener("click", () => setFeaturedImage(btn.dataset.setFeatured))
  );
  grid.querySelectorAll("[data-delete-image]").forEach(btn =>
    btn.addEventListener("click", () => deleteImage(btn.dataset.deleteImage))
  );
  grid.querySelectorAll("[data-move]").forEach(btn =>
    btn.addEventListener("click", () => moveImage(btn.dataset.move, Number(btn.dataset.dir)))
  );
  if (canEdit) wireImageDragReorder();
}

async function saveAltText(imageId, alt) {
  const { error } = await window.supabaseClient.from("property_images").update({ alt_text: alt || null }).eq("id", imageId);
  if (error) { showAdminToast("Couldn't save ALT text: " + error.message, "error"); return; }
  const img = currentImages.find(i => i.id === imageId);
  if (img) img.alt_text = alt;
  showAdminToast("ALT text saved.", "success");
}

/* One database call switches the featured flag atomically; a unique
   index guarantees there can never be two featured images. */
async function setFeaturedImage(imageId) {
  const previousFeatured = currentImages.find(i => i.is_featured_image);
  if (previousFeatured && previousFeatured.id === imageId) return;
  const { error } = await window.supabaseClient.rpc("set_featured_image", { p_image_id: imageId });
  if (error) { showAdminToast("Couldn't change featured image: " + friendlyError(error), "error"); return; }
  currentImages.forEach(i => { i.is_featured_image = i.id === imageId; });
  renderImageGrid();
  showAdminToast("Featured image updated.", "success");
}

async function reloadImages() {
  const { data, error } = await window.supabaseClient.from("property_images")
    .select("*").eq("property_id", editingPropertyId).order("sort_order", { ascending: true });
  if (error) return;
  currentImages = data || [];
  await attachAdminImageUrls(currentImages);
}

async function deleteImage(imageId) {
  const img = currentImages.find(i => i.id === imageId);
  if (!img) return;
  if (!window.confirm(img.is_featured_image
    ? "Delete the FEATURED image? The next image becomes featured."
    : "Delete this image? This only affects this property.")) return;

  // 1. The record (if this fails nothing is lost). The database then
  //    promotes the next image to featured and queues the file.
  const { error: rowError, count } = await window.supabaseClient.from("property_images").delete({ count: "exact" }).eq("id", imageId);
  if (rowError || count === 0) { showAdminToast("Delete failed: " + (rowError ? friendlyError(rowError) : "not allowed"), "error"); return; }
  // 2. The file. A failure is recorded for retry — never silent.
  const cleanup = img.storage_path ? await removePropertyImageFiles([img.storage_path]) : { failed: 0 };

  await reloadImages();
  await persistImageOrder();
  renderImageGrid();
  if (cleanup.failed) showAdminToast("Image removed from the listing, but its file couldn't be deleted yet — it's queued in Media Library → Storage clean-up.", "error");
  else showAdminToast("Image deleted.", "success");
}

async function moveImage(imageId, dir) {
  const from = currentImages.findIndex(i => i.id === imageId);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= currentImages.length) return;
  const [moved] = currentImages.splice(from, 1);
  currentImages.splice(to, 0, moved);
  renderImageGrid();
  await persistImageOrder();
  const btn = document.querySelector(`[data-move="${CSS.escape(imageId)}"][data-dir="${dir}"]`);
  if (btn && !btn.disabled) btn.focus();
}

async function persistImageOrder() {
  currentImages.forEach((img, idx) => { img.sort_order = idx; });
  const results = await Promise.all(currentImages.map((img, idx) =>
    window.supabaseClient.from("property_images").update({ sort_order: idx }).eq("id", img.id)
  ));
  const failed = results.find(r => r.error);
  if (failed) showAdminToast("Couldn't save the new image order: " + failed.error.message, "error");
}

function wireImageDragReorder() {
  const items = document.querySelectorAll("[data-image-id]");
  items.forEach(item => {
    item.addEventListener("dragstart", () => { draggedImageId = item.dataset.imageId; item.style.opacity = "0.4"; });
    item.addEventListener("dragend", () => { item.style.opacity = "1"; });
    item.addEventListener("dragover", e => e.preventDefault());
    item.addEventListener("drop", async e => {
      e.preventDefault();
      const targetId = item.dataset.imageId;
      if (!draggedImageId || draggedImageId === targetId) return;

      const fromIdx = currentImages.findIndex(i => i.id === draggedImageId);
      const toIdx = currentImages.findIndex(i => i.id === targetId);
      const [moved] = currentImages.splice(fromIdx, 1);
      currentImages.splice(toIdx, 0, moved);
      renderImageGrid();
      await persistImageOrder();
    });
  });
}

document.addEventListener("DOMContentLoaded", loadPropertyEditPage);
