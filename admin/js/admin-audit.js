/* AUDIT LOG (super_admin / admin). Read-only: the table has no insert,
   update or delete permissions for any staff role (migration 05). */
const AUDIT_PAGE_SIZE = 50;
const AUDIT_ACTIONS = {
  property: ["property_created", "property_edited", "property_published", "property_unpublished", "property_archived", "property_unarchived",
    "property_deleted", "price_changed", "featured_image_changed", "image_added", "image_deleted", "property_review_under_review",
    "property_review_approved", "property_review_draft", "internal_data_changed"],
  lead: ["lead_status_changed", "lead_assigned", "lead_archived", "lead_restored", "lead_deleted", "leads_exported"],
  settings: ["settings_changed"],
  testimonial: ["testimonial_created", "testimonial_changed", "testimonial_published", "testimonial_unpublished", "testimonial_deleted"],
  staff: ["staff_added", "staff_role_changed", "staff_deactivated", "staff_reactivated", "staff_removed"]
};
let auditPage = 1;
let auditTotal = 0;
let staffMap = {};
const titleCache = {};

async function loadAuditPage() {
  const session = await requireAdminAuth("audit");
  if (!session) return;
  watchAuthState();
  renderAdminShell();
  if (renderAccessDeniedIfNeeded()) return;
  document.getElementById("adminContent").appendChild(document.getElementById("auditTemplate").content.cloneNode(true));

  const { data } = await window.supabaseClient.rpc("staff_labels");
  (data || []).forEach(s => { staffMap[s.user_id] = s.label; });

  const entity = document.getElementById("auditEntity");
  const action = document.getElementById("auditAction");
  const fillActions = () => {
    const list = entity.value ? AUDIT_ACTIONS[entity.value] : Object.values(AUDIT_ACTIONS).flat();
    action.innerHTML = `<option value="">Any action</option>` + list.map(a => `<option value="${a}">${esc(a.replace(/_/g, " "))}</option>`).join("");
  };
  fillActions();
  entity.addEventListener("change", () => { fillActions(); auditPage = 1; fetchAudit(); });
  action.addEventListener("change", () => { auditPage = 1; fetchAudit(); });
  fetchAudit();
}

const fmtVal = v => (v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
function diffHtml(before, after) {
  const keys = [...new Set(Object.keys(before || {}).concat(Object.keys(after || {})))];
  if (!keys.length) return '<span class="admin-subtext">—</span>';
  return keys.map(k => `<div class="admin-diff"><span class="admin-diff-key">${esc(k.replace(/_/g, " "))}</span>
      ${before && k in before ? `<span class="admin-diff-old">${esc(fmtVal(before[k]))}</span> → ` : ""}<span class="admin-diff-new">${esc(fmtVal(after ? after[k] : null))}</span></div>`).join("");
}

async function fetchAudit() {
  const body = document.getElementById("auditBody");
  let q = window.supabaseClient.from("audit_log").select("*", { count: "exact" }).order("created_at", { ascending: false });
  const entity = document.getElementById("auditEntity").value;
  const action = document.getElementById("auditAction").value;
  if (entity) q = q.eq("entity_type", entity);
  if (action) q = q.eq("action", action);
  const from = (auditPage - 1) * AUDIT_PAGE_SIZE;
  const { data, error, count } = await q.range(from, from + AUDIT_PAGE_SIZE - 1);
  if (error) { body.innerHTML = `<tr><td colspan="5"><div class="admin-empty">Couldn't load: ${esc(friendlyError(error))}</div></td></tr>`; return; }
  auditTotal = count || 0;

  // Property names for entries whose summary is empty (image changes).
  const ids = [...new Set(data.filter(a => a.entity_type === "property" && !a.summary && a.entity_id && !titleCache[a.entity_id]).map(a => a.entity_id))];
  if (ids.length) {
    const { data: props } = await window.supabaseClient.from("properties").select("id, title").in("id", ids);
    (props || []).forEach(p => { titleCache[p.id] = p.title; });
  }
  const item = a => {
    if (a.entity_type === "property") {
      const name = a.summary && a.action !== "internal_data_changed" ? a.summary : titleCache[a.entity_id] || "property";
      return a.action === "property_deleted" ? esc(name) : `<a class="admin-link" href="property-edit.html?id=${encodeURIComponent(a.entity_id)}">${esc(name)}</a>${a.action === "internal_data_changed" ? `<div class="admin-subtext">${esc(a.summary || "")}</div>` : ""}`;
    }
    if (a.entity_type === "lead" && a.entity_id) return `<a class="admin-link" href="leads.html?lead=${encodeURIComponent(a.entity_id)}">Open lead</a>`;
    if (a.entity_type === "staff") return esc(staffMap[a.entity_id] || a.summary || "staff member");
    return esc(a.summary || a.entity_type);
  };
  body.innerHTML = data.length ? data.map(a => `<tr>
      <td data-label="When" class="admin-nowrap admin-subtext">${esc(formatDateTime(a.created_at))}</td>
      <td data-label="Who">${esc(a.actor ? staffMap[a.actor] || "Staff" : "System")}${a.actor_role ? `<div class="admin-subtext">${esc(a.actor_role.replace("_", " "))}</div>` : ""}</td>
      <td data-label="What">${esc(a.action.replace(/_/g, " "))}</td>
      <td data-label="Item">${item(a)}</td>
      <td data-label="Change">${diffHtml(a.before, a.after)}</td>
    </tr>`).join("") : `<tr><td colspan="5"><div class="admin-empty">No entries.</div></td></tr>`;

  const pages = Math.max(1, Math.ceil(auditTotal / AUDIT_PAGE_SIZE));
  const nav = document.getElementById("auditPagination");
  nav.innerHTML = pages <= 1 ? "" : `
    <button type="button" class="admin-btn admin-btn-outline admin-btn-sm" data-p="${auditPage - 1}" ${auditPage === 1 ? "disabled" : ""}>← Newer</button>
    <span class="admin-subtext">Page ${auditPage} of ${pages}</span>
    <button type="button" class="admin-btn admin-btn-outline admin-btn-sm" data-p="${auditPage + 1}" ${auditPage === pages ? "disabled" : ""}>Older →</button>`;
  nav.querySelectorAll("[data-p]").forEach(b => b.addEventListener("click", () => { auditPage = Number(b.dataset.p); fetchAudit(); }));
}

document.addEventListener("DOMContentLoaded", loadAuditPage);
