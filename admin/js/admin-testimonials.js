let allTestimonials = [];
let draggedTestimonialId = null;

async function loadTestimonialsPage() {
  const session = await requireAdminAuth("staff");
  if (!session) return;
  watchAuthState();
  renderAdminShell();

  document.getElementById("adminContent").appendChild(document.getElementById("testimonialsTemplate").content.cloneNode(true));

  const addBtn = document.getElementById("addTestimonialBtn");
  if (adminCan("contentEditors")) addBtn.addEventListener("click", () => openTestimonialForm(null));
  else addBtn.style.display = "none";
  document.getElementById("testimonialCancelBtn").addEventListener("click", closeTestimonialForm);
  document.getElementById("testimonialForm").addEventListener("submit", saveTestimonial);

  await refreshTestimonials();
}

async function refreshTestimonials() {
  const { data, error } = await window.supabaseClient
    .from("testimonials").select("*").order("sort_order", { ascending: true });
  if (error) { showAdminToast("Couldn't load testimonials: " + error.message, "error"); return; }
  allTestimonials = data || [];
  renderTestimonialsList();
}

function renderTestimonialsList() {
  const wrap = document.getElementById("testimonialsList");
  if (!allTestimonials.length) {
    wrap.innerHTML = `<div class="admin-empty">No testimonials yet. Add your first one above.</div>`;
    return;
  }

  const canEdit = adminCan("contentEditors");
  wrap.innerHTML = allTestimonials.map(t => `
    <div class="admin-card" style="padding:16px 18px;margin-bottom:12px;display:flex;gap:14px;align-items:flex-start;" draggable="${canEdit}" data-testimonial-id="${esc(t.id)}">
      <span style="cursor:grab;color:var(--slate);padding-top:4px;" title="Drag to reorder">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/></svg>
      </span>
      <div style="flex:1;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <strong style="font-size:13.5px;">${esc(t.client_name)}</strong>
          ${t.client_role ? `<span style="font-size:12px;color:var(--slate);">${esc(t.client_role)}${t.location ? " · " + esc(t.location) : ""}</span>` : ""}
          ${t.is_published ? '<span class="admin-badge admin-badge-green">Published</span>' : '<span class="admin-badge admin-badge-slate">Draft</span>'}
        </div>
        <p style="font-size:13px;color:var(--ink);">${esc(t.review)}</p>
      </div>
      ${canEdit ? `<div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;">
        <button type="button" class="admin-btn admin-btn-ghost admin-btn-sm" data-toggle-publish="${esc(t.id)}" data-current="${t.is_published}">${t.is_published ? "Unpublish" : "Publish"}</button>
        <button type="button" class="admin-btn admin-btn-ghost admin-btn-sm" data-edit-testimonial="${esc(t.id)}">Edit</button>
        ${adminCan("publishers") ? `<button type="button" class="admin-btn admin-btn-danger admin-btn-sm" data-delete-testimonial="${esc(t.id)}">Delete</button>` : ""}
      </div>` : ""}
    </div>
  `).join("");

  if (!canEdit) return;
  wrap.querySelectorAll("[data-toggle-publish]").forEach(btn =>
    btn.addEventListener("click", () => togglePublish(btn.dataset.togglePublish, btn.dataset.current !== "true"))
  );
  wrap.querySelectorAll("[data-edit-testimonial]").forEach(btn =>
    btn.addEventListener("click", () => openTestimonialForm(btn.dataset.editTestimonial))
  );
  wrap.querySelectorAll("[data-delete-testimonial]").forEach(btn =>
    btn.addEventListener("click", () => deleteTestimonial(btn.dataset.deleteTestimonial))
  );
  wireTestimonialDrag();
}

function openTestimonialForm(id) {
  const form = document.getElementById("testimonialForm");
  form.reset();
  document.getElementById("t-id").value = id || "";
  document.getElementById("testimonialModalTitle").textContent = id ? "Edit Testimonial" : "Add Testimonial";

  if (id) {
    const t = allTestimonials.find(x => x.id === id);
    if (t) {
      document.getElementById("t-client_name").value = t.client_name || "";
      document.getElementById("t-client_role").value = t.client_role || "";
      document.getElementById("t-location").value = t.location || "";
      document.getElementById("t-review").value = t.review || "";
      document.getElementById("t-rating").value = t.rating || "";
      document.getElementById("t-photo_url").value = t.photo_url || "";
      document.getElementById("t-is_published").checked = !!t.is_published;
    }
  }
  openAdminModal(document.getElementById("testimonialFormOverlay"));
}
function closeTestimonialForm() {
  closeAdminModal(document.getElementById("testimonialFormOverlay"));
}

async function saveTestimonial(e) {
  e.preventDefault();
  const id = document.getElementById("t-id").value;
  const name = document.getElementById("t-client_name").value.trim();
  const review = document.getElementById("t-review").value.trim();
  if (!name || !review) { showAdminToast("Client name and review are required.", "error"); return; }
  const ratingRaw = document.getElementById("t-rating").value.trim();
  if (ratingRaw && !/^[1-5]$/.test(ratingRaw)) { showAdminToast("Rating must be a whole number from 1 to 5.", "error"); document.getElementById("t-rating").focus(); return; }
  const photo = document.getElementById("t-photo_url").value.trim();
  if (photo && !/^(https:\/\/[^\s"'<>]+|\/[A-Za-z0-9][^\s"'<>]*)$/.test(photo)) {
    showAdminToast("Photo URL must start with https:// (or be a /media/… link from the Media Library).", "error");
    document.getElementById("t-photo_url").focus();
    return;
  }

  const payload = {
    client_name: name,
    client_role: document.getElementById("t-client_role").value.trim() || null,
    location: document.getElementById("t-location").value.trim() || null,
    review,
    rating: Number(document.getElementById("t-rating").value) || null,
    photo_url: document.getElementById("t-photo_url").value.trim() || null,
    is_published: document.getElementById("t-is_published").checked
  };

  let result;
  if (id) {
    result = await window.supabaseClient.from("testimonials").update(payload).eq("id", id);
  } else {
    payload.sort_order = allTestimonials.length;
    result = await window.supabaseClient.from("testimonials").insert(payload);
  }

  if (result.error) { showAdminToast("Save failed: " + friendlyError(result.error), "error"); return; }
  closeTestimonialForm();
  await refreshTestimonials();
  showAdminToast("Testimonial saved.", "success");
}

async function togglePublish(id, value) {
  const { error } = await window.supabaseClient.from("testimonials").update({ is_published: value }).eq("id", id);
  if (error) { showAdminToast("Update failed: " + friendlyError(error), "error"); return; }
  const t = allTestimonials.find(x => x.id === id);
  if (t) t.is_published = value;
  renderTestimonialsList();
  showAdminToast(value ? "Published." : "Unpublished.", "success");
}

async function deleteTestimonial(id) {
  if (!window.confirm("Delete this testimonial? This can't be undone.")) return;
  const { error } = await window.supabaseClient.from("testimonials").delete().eq("id", id);
  if (error) { showAdminToast("Delete failed: " + friendlyError(error), "error"); return; }
  allTestimonials = allTestimonials.filter(t => t.id !== id);
  renderTestimonialsList();
  showAdminToast("Testimonial deleted.", "success");
}

function wireTestimonialDrag() {
  document.querySelectorAll("[data-testimonial-id]").forEach(card => {
    card.addEventListener("dragstart", () => { draggedTestimonialId = card.dataset.testimonialId; card.style.opacity = "0.4"; });
    card.addEventListener("dragend", () => { card.style.opacity = "1"; });
    card.addEventListener("dragover", e => e.preventDefault());
    card.addEventListener("drop", async e => {
      e.preventDefault();
      const targetId = card.dataset.testimonialId;
      if (!draggedTestimonialId || draggedTestimonialId === targetId) return;
      const fromIdx = allTestimonials.findIndex(t => t.id === draggedTestimonialId);
      const toIdx = allTestimonials.findIndex(t => t.id === targetId);
      const [moved] = allTestimonials.splice(fromIdx, 1);
      allTestimonials.splice(toIdx, 0, moved);
      allTestimonials.forEach((t, idx) => { t.sort_order = idx; });
      renderTestimonialsList();
      await Promise.all(allTestimonials.map((t, idx) =>
        window.supabaseClient.from("testimonials").update({ sort_order: idx }).eq("id", t.id)
      ));
    });
  });
}

document.addEventListener("DOMContentLoaded", loadTestimonialsPage);
