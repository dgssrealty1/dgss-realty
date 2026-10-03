/* ==========================================================================
   GENERIC SETTINGS FORM
   ------------------------------------------------------------------------
   Branding, Contact Details, SEO and Homepage are different subsets of
   the single `settings` row (id = 1). Every field <id="s-<column>"> is
   loaded, validated and saved here, and every one of them is used by the
   public site (src/cms.js) — tests/static-audit.test.mjs fails if a
   field exists here that the website doesn't read.

   Validation mirrors the database trigger validate_settings() (migration
   05) so mistakes are caught before saving; the database re-checks.
   ========================================================================== */
const SETTINGS_RULES = {
  url: v => /^(https:\/\/[^\s"'<>]+|\/[A-Za-z0-9][^\s"'<>]*)$/.test(v) || "Enter a full https:// link (or a /path on this site, e.g. from the Media Library).",
  phone: v => (/^\+?[0-9 ()\-.]+$/.test(v) && v.replace(/\D/g, "").length >= 8 && v.replace(/\D/g, "").length <= 15) || "Enter a phone number with 8–15 digits, e.g. +91 98400 00000.",
  email: v => /^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$/i.test(v) || "Enter a valid email address."
};

function settingsFieldError(el, message) {
  const wrap = el.closest(".admin-field");
  if (!wrap) return;
  wrap.classList.toggle("invalid", !!message);
  let box = wrap.querySelector(".admin-field-error");
  if (!box) {
    box = document.createElement("span");
    box.className = "admin-field-error";
    box.id = `${el.id}-error`;
    wrap.appendChild(box);
    el.setAttribute("aria-describedby", [el.getAttribute("aria-describedby"), box.id].filter(Boolean).join(" "));
  }
  box.textContent = message || "";
  el.setAttribute("aria-invalid", message ? "true" : "false");
}

function validateSettingsField(el) {
  const v = el.value.trim();
  if (!v) return el.hasAttribute("data-required") ? "This field is required — the public site uses it." : "";
  const max = Number(el.getAttribute("maxlength") || 0);
  if (max && v.length > max) return `Keep this under ${max} characters.`;
  const rule = SETTINGS_RULES[el.dataset.validate];
  if (rule) { const r = rule(v); if (r !== true) return r; }
  return "";
}

/* Image fields: preview + "Choose from Media Library" (site-media). */
function initMediaPickers() {
  document.querySelectorAll("[data-media-picker]").forEach(input => {
    const wrap = input.closest(".admin-field");
    const row = document.createElement("div");
    row.className = "admin-media-field";
    const preview = document.createElement("img");
    preview.className = "admin-media-preview";
    preview.alt = "";
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "admin-btn admin-btn-outline admin-btn-sm";
    pick.textContent = "Choose from Media Library";
    row.append(preview, pick);
    input.insertAdjacentElement("afterend", row);
    const update = () => {
      const v = input.value.trim();
      const ok = v && SETTINGS_RULES.url(v) === true;
      preview.hidden = !ok;
      if (ok) preview.src = v;
    };
    input.addEventListener("input", update);
    input._updatePreview = update;
    pick.addEventListener("click", () => openMediaPicker(input.dataset.mediaPicker.split(","), url => {
      input.value = url;
      update();
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }));
    if (!wrap) return;
  });
}

async function openMediaPicker(categories, onPick) {
  let overlay = document.getElementById("mediaPickerOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "admin-modal-overlay";
    overlay.id = "mediaPickerOverlay";
    overlay.innerHTML = `<div class="admin-modal admin-modal-wide" role="dialog" aria-modal="true" aria-labelledby="mediaPickerTitle">
        <h3 id="mediaPickerTitle">Choose an image</h3>
        <div class="admin-image-grid" id="mediaPickerGrid"></div>
        <div class="admin-modal-actions" style="margin-top:16px;">
          <a class="admin-btn admin-btn-ghost" href="media.html" target="_blank" rel="noopener">Upload in Media Library ↗</a>
          <button type="button" class="admin-btn admin-btn-outline" data-close>Close</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("[data-close]").addEventListener("click", () => closeAdminModal(overlay));
    overlay.addEventListener("click", e => { if (e.target === overlay) closeAdminModal(overlay); });
  }
  const grid = overlay.querySelector("#mediaPickerGrid");
  grid.innerHTML = `<div class="admin-empty" style="grid-column:1/-1;padding:30px;">Loading…</div>`;
  openAdminModal(overlay);
  const { data, error } = await window.supabaseClient.from("media_assets")
    .select("id, category, public_url, title, alt_text").in("category", categories).order("created_at", { ascending: false });
  if (error) { grid.innerHTML = `<div class="admin-empty" style="grid-column:1/-1;">Couldn't load media: ${esc(friendlyError(error))}</div>`; return; }
  if (!data.length) {
    grid.innerHTML = `<div class="admin-empty" style="grid-column:1/-1;padding:30px;">No images in ${esc(categories.join(" / "))} yet. Upload one in the Media Library first.</div>`;
    return;
  }
  grid.innerHTML = data.map(a => `
    <button type="button" class="admin-image-item admin-pick-item" data-url="${esc(a.public_url)}" aria-label="Use ${esc(a.title || a.alt_text || "this image")}">
      <img src="${safeUrl(a.public_url)}" alt="" loading="lazy">
      <span class="admin-pick-label">${esc(a.title || a.category)}</span>
    </button>`).join("");
  grid.querySelectorAll("[data-url]").forEach(btn => btn.addEventListener("click", () => {
    onPick(btn.dataset.url);
    closeAdminModal(overlay);
  }));
}

async function initSettingsForm(fieldNames) {
  const session = await requireAdminAuth("settings");
  if (!session) return;
  watchAuthState();
  renderAdminShell();
  if (renderAccessDeniedIfNeeded()) return;

  const template = document.getElementById("settingsFormTemplate");
  document.getElementById("adminContent").appendChild(template.content.cloneNode(true));
  initMediaPickers();

  const { data, error } = await window.supabaseClient.from("settings").select("*").eq("id", 1).single();
  if (error) {
    showAdminToast("Couldn't load settings: " + friendlyError(error), "error");
  } else if (data) {
    fieldNames.forEach(field => {
      const el = document.getElementById(`s-${field}`);
      if (el && data[field] != null) el.value = data[field];
      if (el && el._updatePreview) el._updatePreview();
    });
  }

  fieldNames.forEach(field => {
    const el = document.getElementById(`s-${field}`);
    if (el) el.addEventListener("blur", () => settingsFieldError(el, validateSettingsField(el)));
  });

  document.getElementById("settingsForm").addEventListener("submit", async e => {
    e.preventDefault();
    const payload = {};
    let firstBad = null;
    fieldNames.forEach(field => {
      const el = document.getElementById(`s-${field}`);
      if (!el) return;
      const problem = validateSettingsField(el);
      settingsFieldError(el, problem);
      if (problem && !firstBad) firstBad = el;
      payload[field] = el.value.trim() || null;
    });
    if (firstBad) {
      firstBad.focus();
      showAdminToast("Please fix the highlighted field(s) — nothing was saved yet.", "error");
      return;
    }

    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = "Saving…";
    const { error: saveError } = await window.supabaseClient.from("settings").update(payload).eq("id", 1);
    btn.disabled = false;
    btn.textContent = "Save Changes";

    if (saveError) {
      // Database messages name the field: "phone: enter a phone number…"
      const m = /^([a-z_]+):\s*(.*)$/.exec(saveError.message || "");
      const el = m && document.getElementById(`s-${m[1]}`);
      if (el) { settingsFieldError(el, m[2]); el.focus(); }
      showAdminToast("Save failed: " + friendlyError(saveError), "error");
      return;
    }
    showAdminToast("Saved. The public website shows the change within a few seconds.", "success");
  });
}

// Pages declare their fields on <body data-settings-fields="a,b,c">.
document.addEventListener("DOMContentLoaded", () => {
  const list = document.body.dataset.settingsFields;
  if (list) initSettingsForm(list.split(",").map(f => f.trim()).filter(Boolean));
});
