/* ==========================================================================
   MEDIA LIBRARY
     Property Images  — every listing photo (property_images + private
                        property-images bucket); uploaded per property.
     Branding / Founder / Homepage / General — site images (media_assets +
                        public site-media bucket): logo, founder photo,
                        share images. Upload, alt text, copy URL, delete.
     Storage clean-up — orphaned / missing files (admins).
   Permissions are enforced by Storage + table RLS (migration 05): any
   staff role can browse; editors+ manage property photos; only admins
   upload or delete site media.
   ========================================================================== */
const ASSET_INTRO = {
  branding: "Logos and brand images. Choose the logo in Admin → Branding.",
  founder: "Founder photos. Choose one in Admin → Homepage → Founder Photo.",
  homepage: "Images for the homepage and the default share image (Admin → SEO).",
  general: "Any other image you want to reference by URL (e.g. testimonial photos)."
};
const PAGE = 60;
let propertyImages = [];
let propertyShown = PAGE;
let assets = [];
let activeTab = "property";
let settingsRow = null;

async function loadMediaPage() {
  const session = await requireAdminAuth("staff");
  if (!session) return;
  watchAuthState();
  renderAdminShell();
  document.getElementById("adminContent").appendChild(document.getElementById("mediaTemplate").content.cloneNode(true));

  document.getElementById("cleanupTab").hidden = !adminCan("publishers");
  document.querySelectorAll("[data-media-tab]").forEach(tab => tab.addEventListener("click", () => switchTab(tab.dataset.mediaTab)));
  document.getElementById("mediaSearch").addEventListener("input", () => { propertyShown = PAGE; renderPropertyGrid(); });
  document.getElementById("mediaFeaturedOnly").addEventListener("change", () => { propertyShown = PAGE; renderPropertyGrid(); });
  document.getElementById("assetSearch").addEventListener("input", renderAssetGrid);
  initAssetUpload();

  const { data, error } = await window.supabaseClient
    .from("property_images").select("id, property_id, storage_path, public_url, alt_text, is_featured_image, created_at, properties(title, slug, is_published)")
    .order("created_at", { ascending: false });
  if (error) { showAdminToast("Couldn't load property photos: " + friendlyError(error), "error"); return; }
  propertyImages = data || [];
  await attachAdminImageUrls(propertyImages);
  renderPropertyGrid();
  const tab = new URLSearchParams(window.location.search).get("tab");
  if (tab && document.querySelector(`[data-media-tab="${tab}"]`)) switchTab(tab);
}

function switchTab(name) {
  activeTab = name;
  document.querySelectorAll("[data-media-tab]").forEach(t => {
    const on = t.dataset.mediaTab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  const isAsset = ["branding", "founder", "homepage", "general"].includes(name);
  document.querySelector('[data-media-panel="property"]').hidden = name !== "property";
  document.querySelector('[data-media-panel="assets"]').hidden = !isAsset;
  document.querySelector('[data-media-panel="cleanup"]').hidden = name !== "cleanup";
  if (isAsset) {
    document.getElementById("assetIntro").textContent = ASSET_INTRO[name];
    document.getElementById("assetDropzone").hidden = !adminCan("settings");
    loadAssets();
  }
  if (name === "cleanup") loadCleanupReport();
}

async function copyText(text, label) {
  const absolute = text.startsWith("/") ? window.location.origin + text : text;
  try { await navigator.clipboard.writeText(absolute); showAdminToast(`${label || "URL"} copied.`, "success"); }
  catch (_) { window.prompt("Copy this URL:", absolute); }
}

/* ---------- property photos ---------- */
function renderPropertyGrid() {
  const search = document.getElementById("mediaSearch").value.trim().toLowerCase();
  const featuredOnly = document.getElementById("mediaFeaturedOnly").checked;
  let list = propertyImages;
  if (featuredOnly) list = list.filter(i => i.is_featured_image);
  if (search) list = list.filter(i => (i.storage_path || "").toLowerCase().includes(search) || (i.properties && (i.properties.title || "").toLowerCase().includes(search)) || (i.alt_text || "").toLowerCase().includes(search));

  const grid = document.getElementById("mediaGrid");
  const canDelete = adminCan("contentEditors");
  grid.innerHTML = list.length ? list.slice(0, propertyShown).map(img => `
      <figure class="admin-media-card">
        <div class="admin-image-item ${img.is_featured_image ? "featured" : ""}">
          ${img.is_featured_image ? '<span class="admin-image-featured-tag">Featured</span>' : ""}
          <img src="${safeUrl(img.displayUrl || img.public_url)}" alt="${esc(img.alt_text || "")}" loading="lazy">
        </div>
        <figcaption>
          <a class="admin-link admin-ellipsis" href="property-edit.html?id=${encodeURIComponent(img.property_id)}">${esc(img.properties ? img.properties.title : "Unknown property")}</a>
          <div class="admin-subtext admin-ellipsis" title="${esc(img.storage_path || img.public_url)}">${esc(img.storage_path || "site image")}${img.alt_text ? "" : " · no ALT text"}</div>
          <div class="admin-media-actions">
            <button type="button" class="admin-btn admin-btn-ghost admin-btn-sm" data-copy="${esc(img.public_url)}">Copy URL</button>
            ${canDelete ? `<button type="button" class="admin-btn admin-btn-danger admin-btn-sm" data-delete-media="${esc(img.id)}">Delete</button>` : ""}
          </div>
        </figcaption>
      </figure>`).join("")
    : `<div class="admin-empty" style="grid-column:1/-1;">No photos match.</div>`;
  grid.querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", () => copyText(b.dataset.copy)));
  grid.querySelectorAll("[data-delete-media]").forEach(b => b.addEventListener("click", () => deletePropertyImage(b.dataset.deleteMedia)));
  const more = document.getElementById("mediaMore");
  more.innerHTML = list.length > propertyShown ? `<button type="button" class="admin-btn admin-btn-outline admin-btn-sm">Show more (${list.length - propertyShown})</button>` : "";
  const btn = more.querySelector("button");
  if (btn) btn.addEventListener("click", () => { propertyShown += PAGE; renderPropertyGrid(); });
}

async function deletePropertyImage(id) {
  const img = propertyImages.find(i => i.id === id);
  if (!img) return;
  const name = img.properties ? img.properties.title : "a property";
  if (!window.confirm(img.is_featured_image
    ? `This is the FEATURED photo of "${name}". Delete it? The property's next photo becomes featured automatically.`
    : `Delete this photo from "${name}"? This can't be undone.`)) return;
  const { error, count } = await window.supabaseClient.from("property_images").delete({ count: "exact" }).eq("id", id);
  if (error || count === 0) { showAdminToast("Delete failed: " + (error ? friendlyError(error) : "not allowed"), "error"); return; }
  const cleanup = img.storage_path ? await removePropertyImageFiles([img.storage_path]) : { failed: 0 };
  // The database may have promoted another photo to featured — refresh.
  const { data } = await window.supabaseClient.from("property_images").select("id, is_featured_image").eq("property_id", img.property_id);
  propertyImages = propertyImages.filter(i => i.id !== id);
  (data || []).forEach(r => { const x = propertyImages.find(i => i.id === r.id); if (x) x.is_featured_image = r.is_featured_image; });
  renderPropertyGrid();
  showAdminToast(cleanup.failed ? "Photo removed, but its file couldn't be deleted yet — see Storage clean-up." : "Photo deleted.", cleanup.failed ? "error" : "success");
}

/* ---------- site media (branding / founder / homepage / general) ---------- */
const sitePreview = path => window.supabaseClient.storage.from("site-media").getPublicUrl(path).data.publicUrl;

async function loadAssets() {
  const grid = document.getElementById("assetGrid");
  grid.innerHTML = `<div class="admin-empty" style="grid-column:1/-1;padding:30px;">Loading…</div>`;
  const [res, settings] = await Promise.all([
    window.supabaseClient.from("media_assets").select("*").eq("category", activeTab).order("created_at", { ascending: false }),
    window.supabaseClient.from("settings").select("logo_url, founder_photo_url, default_og_image_url").eq("id", 1).single()
  ]);
  if (res.error) { grid.innerHTML = `<div class="admin-empty" style="grid-column:1/-1;">Couldn't load: ${esc(friendlyError(res.error))}</div>`; return; }
  assets = res.data || [];
  settingsRow = settings.data || {};
  renderAssetGrid();
}

function usedBy(asset) {
  const uses = [];
  if (!settingsRow) return uses;
  if (settingsRow.logo_url === asset.public_url) uses.push("site logo");
  if (settingsRow.founder_photo_url === asset.public_url) uses.push("founder photo");
  if (settingsRow.default_og_image_url === asset.public_url) uses.push("default share image");
  return uses;
}

function renderAssetGrid() {
  const search = document.getElementById("assetSearch").value.trim().toLowerCase();
  const list = search ? assets.filter(a => (a.title || "").toLowerCase().includes(search) || (a.alt_text || "").toLowerCase().includes(search)) : assets;
  const canEdit = adminCan("settings");
  const grid = document.getElementById("assetGrid");
  grid.innerHTML = list.length ? list.map(a => {
    const uses = usedBy(a);
    return `<figure class="admin-media-card">
        <div class="admin-image-item"><img src="${safeUrl(sitePreview(a.storage_path))}" alt="${esc(a.alt_text || "")}" loading="lazy"></div>
        <figcaption>
          ${canEdit ? `<label class="sr-only" for="title-${esc(a.id)}">Title</label><input class="admin-image-alt" id="title-${esc(a.id)}" data-title-for="${esc(a.id)}" maxlength="120" placeholder="Title">
          <label class="sr-only" for="alt-${esc(a.id)}">ALT text</label><input class="admin-image-alt" id="alt-${esc(a.id)}" data-alt-for="${esc(a.id)}" maxlength="200" placeholder="ALT text (describe the image)">`
            : `<div class="admin-strong admin-ellipsis">${esc(a.title || "Untitled")}</div>`}
          <div class="admin-subtext admin-ellipsis" title="${esc(a.storage_path)}">${esc(a.storage_path)} · ${a.size_bytes ? Math.round(a.size_bytes / 1024) + " KB" : ""}</div>
          ${uses.length ? `<div class="admin-badge admin-badge-green" style="margin-top:4px;">In use: ${esc(uses.join(", "))}</div>` : ""}
          <div class="admin-media-actions">
            <button type="button" class="admin-btn admin-btn-ghost admin-btn-sm" data-copy="${esc(a.public_url)}">Copy URL</button>
            ${canEdit ? `<button type="button" class="admin-btn admin-btn-danger admin-btn-sm" data-delete-asset="${esc(a.id)}">Delete</button>` : ""}
          </div>
        </figcaption>
      </figure>`;
  }).join("") : `<div class="admin-empty" style="grid-column:1/-1;">No images here yet.</div>`;

  grid.querySelectorAll("[data-title-for]").forEach(input => {
    const a = assets.find(x => x.id === input.dataset.titleFor);
    input.value = (a && a.title) || "";
    input.addEventListener("change", () => updateAsset(input.dataset.titleFor, { title: input.value.trim() || null }));
  });
  grid.querySelectorAll("[data-alt-for]").forEach(input => {
    const a = assets.find(x => x.id === input.dataset.altFor);
    input.value = (a && a.alt_text) || "";
    input.addEventListener("change", () => updateAsset(input.dataset.altFor, { alt_text: input.value.trim() || null }));
  });
  grid.querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", () => copyText(b.dataset.copy)));
  grid.querySelectorAll("[data-delete-asset]").forEach(b => b.addEventListener("click", () => deleteAsset(b.dataset.deleteAsset)));
}

async function updateAsset(id, patch) {
  const { error } = await window.supabaseClient.from("media_assets").update(patch).eq("id", id).select("id").single();
  if (error) { showAdminToast("Not saved: " + friendlyError(error), "error"); return; }
  const a = assets.find(x => x.id === id);
  if (a) Object.assign(a, patch);
  showAdminToast("Saved.", "success");
}

async function deleteAsset(id) {
  const a = assets.find(x => x.id === id);
  if (!a) return;
  const uses = usedBy(a);
  if (!window.confirm(uses.length
    ? `This image is the ${uses.join(" and ")}. Deleting it will make the site fall back to its default. Delete anyway?`
    : "Delete this image? This can't be undone.")) return;
  const { error: fileError } = await window.supabaseClient.storage.from("site-media").remove([a.storage_path]);
  if (fileError) { showAdminToast("Couldn't delete the file: " + friendlyError(fileError), "error"); return; }
  const { error } = await window.supabaseClient.from("media_assets").delete().eq("id", id);
  if (error) { showAdminToast("File deleted but the record wasn't: " + friendlyError(error), "error"); return; }
  assets = assets.filter(x => x.id !== id);
  renderAssetGrid();
  showAdminToast("Image deleted.", "success");
}

function initAssetUpload() {
  const dz = document.getElementById("assetDropzone");
  const input = document.getElementById("assetFileInput");
  input.addEventListener("change", () => { uploadAssets(input.files); input.value = ""; });
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("dragover"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
  dz.addEventListener("drop", e => { e.preventDefault(); dz.classList.remove("dragover"); uploadAssets(e.dataTransfer.files); });
}

async function uploadAssets(fileList) {
  if (!adminCan("settings")) return;
  const category = activeTab;
  const types = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" };
  let ok = 0;
  for (const file of Array.from(fileList)) {
    if (!types[file.type]) { showAdminToast(`${file.name}: use JPG, PNG, WebP or AVIF.`, "error"); continue; }
    if (file.size > 5 * 1024 * 1024) { showAdminToast(`${file.name}: larger than 5MB.`, "error"); continue; }
    // Safe, unique name; the original file name is kept only as the title.
    const path = `${category}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${types[file.type]}`;
    const { error: upErr } = await window.supabaseClient.storage.from("site-media").upload(path, file, { contentType: file.type, cacheControl: "31536000", upsert: false });
    if (upErr) { showAdminToast(`${file.name}: upload failed — ${friendlyError(upErr)}`, "error"); continue; }
    const title = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").slice(0, 120);
    const { error: rowErr } = await window.supabaseClient.from("media_assets").insert({
      category, storage_path: path, public_url: `/media/site-media/${path}`, title, mime_type: file.type, size_bytes: file.size
    });
    if (rowErr) {
      await window.supabaseClient.storage.from("site-media").remove([path]);
      showAdminToast(`${file.name}: couldn't be recorded — ${friendlyError(rowErr)}`, "error");
      continue;
    }
    ok++;
  }
  if (ok) showAdminToast(`${ok} image${ok > 1 ? "s" : ""} uploaded. Add ALT text so everyone can understand them.`, "success");
  loadAssets();
}

/* ---------- storage clean-up (admins) ---------- */
async function loadCleanupReport() {
  const box = document.getElementById("cleanupReport");
  box.innerHTML = `<p class="admin-subtext">Checking storage…</p>`;
  const { data, error } = await window.supabaseClient.rpc("storage_orphan_report");
  if (error) { box.innerHTML = `<div class="admin-empty">Couldn't run the check: ${esc(friendlyError(error))}</div>`; return; }
  const queued = data.queued || [];
  const unref = data.unreferenced_files || [];
  const missing = data.missing_files || [];
  const legacy = data.legacy_paths || [];
  const list = items => `<ul class="admin-path-list">${items.slice(0, 200).map(i => `<li>${i}</li>`).join("")}${items.length > 200 ? `<li>…and ${items.length - 200} more</li>` : ""}</ul>`;
  box.innerHTML = `
    <div class="admin-card admin-pad" style="margin-bottom:14px;">
      <h3 class="admin-card-title">Files waiting to be deleted (${queued.length})</h3>
      <p class="admin-subtext">Photos already removed from a listing whose file deletion failed.</p>
      ${queued.length ? list(queued.map(q => `${esc(q.path)} <span class="admin-subtext">— ${q.attempts} attempt(s)${q.last_error ? ": " + esc(q.last_error) : ""}</span>`)) + `<button type="button" class="admin-btn admin-btn-primary admin-btn-sm" id="retryQueued">Delete these files now</button>` : '<p class="admin-subtext">None. ✓</p>'}
    </div>
    <div class="admin-card admin-pad" style="margin-bottom:14px;">
      <h3 class="admin-card-title">Files not used by any listing (${unref.length})</h3>
      <p class="admin-subtext">Older than one hour (uploads in progress are ignored).</p>
      ${unref.length ? list(unref.map(esc)) + `<button type="button" class="admin-btn admin-btn-danger admin-btn-sm" id="deleteUnref">Delete unused files</button>` : '<p class="admin-subtext">None. ✓</p>'}
    </div>
    <div class="admin-card admin-pad" style="margin-bottom:14px;">
      <h3 class="admin-card-title">Listing photos whose file is missing (${missing.length})</h3>
      ${missing.length ? list(missing.map(m => `<a class="admin-link" href="property-edit.html?id=${encodeURIComponent(m.property_id)}">${esc(m.path)}</a>`)) + '<p class="admin-subtext">Open the property and delete or re-upload these photos.</p>' : '<p class="admin-subtext">None. ✓</p>'}
    </div>
    <div class="admin-card admin-pad">
      <h3 class="admin-card-title">Older photo file names (${legacy.length})</h3>
      ${legacy.length ? list(legacy.map(l => esc(l.path))) + '<p class="admin-subtext">These still display correctly (the website encodes unusual characters safely). No action needed.</p>' : '<p class="admin-subtext">None. ✓</p>'}
    </div>`;
  const retry = document.getElementById("retryQueued");
  if (retry) retry.addEventListener("click", async () => {
    retry.disabled = true;
    const r = await removePropertyImageFiles(queued.map(q => q.path));
    showAdminToast(r.failed ? "Storage refused the deletion again — try later." : `${queued.length} file(s) deleted.`, r.failed ? "error" : "success");
    loadCleanupReport();
  });
  const del = document.getElementById("deleteUnref");
  if (del) del.addEventListener("click", async () => {
    if (!window.confirm(`Permanently delete ${unref.length} unused photo file(s)? No listing uses them.`)) return;
    del.disabled = true;
    const { error: rmErr } = await window.supabaseClient.storage.from("property-images").remove(unref);
    showAdminToast(rmErr ? "Couldn't delete: " + friendlyError(rmErr) : `${unref.length} file(s) deleted.`, rmErr ? "error" : "success");
    loadCleanupReport();
  });
}

document.addEventListener("DOMContentLoaded", loadMediaPage);
