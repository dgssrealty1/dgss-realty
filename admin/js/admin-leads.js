/* ==========================================================================
   LEADS / CRM
   - Server-side pagination (20 / 50 / 100) with every filter applied in
     the database query — the browser only holds the rows on screen.
   - Assignment, priority, follow-ups, budget / requirement / next action.
   - Timeline from lead_activity (written by database triggers; staff can
     only add their own notes / call / WhatsApp / email entries).
   - CSV export of the current filter, recorded in the audit log.
   Who may see / change what is decided by RLS + triggers (migration 05):
   super_admin, admin and sales only; sales can't reassign other people's
   leads; nobody can forge timeline events.
   ========================================================================== */
const LEAD_SOURCE_LABELS = {
  property_enquiry: "Property Enquiry", list_with_us: "List With Us", free_valuation: "Free Valuation",
  joint_venture: "Joint Venture", nri_services: "NRI Services", contact_form: "Contact Form"
};
const LEAD_TYPE_LABELS = { buyer_enquiry: "Buyer", seller_lead: "Seller", joint_venture: "Joint Venture", nri_enquiry: "NRI", general_contact: "General" };
const LEAD_STATUS_COLORS = {
  New: "admin-badge-orange", Contacted: "admin-badge-slate", "Follow-up": "admin-badge-amber",
  Qualified: "admin-badge-green", Closed: "admin-badge-slate", "Not Interested": "admin-badge-red"
};
const PRIORITY_LABELS = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" };
const PRIORITY_COLORS = { urgent: "admin-badge-red", high: "admin-badge-amber", normal: "admin-badge-slate", low: "admin-badge-slate" };
const CLOSED_LEAD_STATUSES = ["Closed", "Not Interested"];
const LIST_COLUMNS = "id, name, phone, whatsapp, email, source, lead_type, status, priority, assigned_to, follow_up_date, created_at, is_archived, property_title_snapshot, property_id, properties(slug, title, is_published, is_archived)";
const EXPORT_LIMIT = 10000;

let leadPage = 1;
let leadPageSize = 20;
let leadTotal = 0;
let pageLeads = [];
let assignees = [];           // [{user_id, label, role}]
let myUserId = null;
let searchTimer = null;
let openLeadId = null;

async function loadLeadsPage() {
  const session = await requireAdminAuth("leadAccess");
  if (!session) return;
  myUserId = session.user.id;
  watchAuthState();
  renderAdminShell();
  if (renderAccessDeniedIfNeeded()) return;

  document.getElementById("adminContent").appendChild(document.getElementById("leadsTemplate").content.cloneNode(true));

  const params = new URLSearchParams(window.location.search);
  const preset = { source: "leadFilterSource", status: "leadFilterStatus", assigned: "leadFilterAssigned", followup: "leadFilterFollowUp", priority: "leadFilterPriority" };
  Object.entries(preset).forEach(([k, id]) => { const v = params.get(k); if (v) document.getElementById(id).value = v; });

  const { data } = await window.supabaseClient.rpc("lead_assignees");
  assignees = data || [];

  ["leadFilterStatus", "leadFilterSource", "leadFilterType", "leadFilterPriority", "leadFilterAssigned", "leadFilterFollowUp", "leadFilterArchived"]
    .forEach(id => document.getElementById(id).addEventListener("change", () => { leadPage = 1; fetchLeads(); }));
  document.getElementById("leadSearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { leadPage = 1; fetchLeads(); }, 350);
  });
  document.getElementById("leadPageSize").addEventListener("change", e => { leadPageSize = Number(e.target.value) || 20; leadPage = 1; fetchLeads(); });
  document.getElementById("exportCsvBtn").addEventListener("click", exportCsv);

  const overlay = document.getElementById("leadDetailOverlay");
  document.getElementById("leadDetailCloseBtn").addEventListener("click", closeLeadDetail);
  overlay.addEventListener("click", e => { if (e.target === overlay) closeLeadDetail(); });

  await fetchLeads();
  const open = params.get("lead");
  if (open && /^[0-9a-f-]{36}$/i.test(open)) openLeadDetail(open);
}

/* ---------- query (shared by the table and the CSV export) ---------- */
function currentFilters() {
  const v = id => document.getElementById(id).value;
  return {
    search: document.getElementById("leadSearch").value.trim(),
    status: v("leadFilterStatus"), source: v("leadFilterSource"), type: v("leadFilterType"),
    priority: v("leadFilterPriority"), assigned: v("leadFilterAssigned"), followUp: v("leadFilterFollowUp"),
    archived: v("leadFilterArchived") === "archived"
  };
}
const isoDate = d => d.toISOString().slice(0, 10);

function buildLeadQuery(columns, f, { count = false } = {}) {
  let q = window.supabaseClient.from("leads").select(columns, count ? { count: "exact" } : undefined).eq("is_archived", f.archived);
  if (f.status) q = q.eq("status", f.status);
  if (f.source) q = q.eq("source", f.source);
  if (f.type) q = q.eq("lead_type", f.type);
  if (f.priority) q = q.eq("priority", f.priority);
  if (f.assigned === "me") q = q.eq("assigned_to", myUserId);
  if (f.assigned === "none") q = q.is("assigned_to", null);
  if (f.followUp === "due") q = q.lte("follow_up_date", isoDate(new Date(Date.now() + 7 * 864e5))).not("status", "in", `(${CLOSED_LEAD_STATUSES.map(s => `"${s}"`).join(",")})`);
  if (f.followUp === "overdue") q = q.lt("follow_up_date", isoDate(new Date())).not("status", "in", `(${CLOSED_LEAD_STATUSES.map(s => `"${s}"`).join(",")})`);
  if (f.search) {
    // Characters with meaning in PostgREST filters are removed, so a search
    // can never change the query's structure.
    const term = f.search.replace(/[%,()*\\:"']/g, " ").trim();
    if (term) q = q.or(["name", "phone", "email", "property_title_snapshot"].map(c => `${c}.ilike.%${term}%`).join(","));
  }
  return f.followUp
    ? q.order("follow_up_date", { ascending: true, nullsFirst: false }).order("created_at", { ascending: false })
    : q.order("created_at", { ascending: false });
}

async function fetchLeads() {
  const tbody = document.getElementById("leadsTableBody");
  tbody.innerHTML = `<tr><td colspan="10" class="admin-loading">Loading enquiries…</td></tr>`;
  const from = (leadPage - 1) * leadPageSize;
  const { data, error, count } = await buildLeadQuery(LIST_COLUMNS, currentFilters(), { count: true }).range(from, from + leadPageSize - 1);
  if (error) {
    tbody.innerHTML = `<tr><td colspan="10"><div class="admin-empty">Couldn't load enquiries: ${esc(friendlyError(error))}</div></td></tr>`;
    return;
  }
  pageLeads = data || [];
  leadTotal = count ?? pageLeads.length;
  if (!pageLeads.length && leadPage > 1 && leadTotal > 0) { leadPage = Math.ceil(leadTotal / leadPageSize); return fetchLeads(); }
  renderLeadsTable();
}

const assigneeLabel = id => {
  if (!id) return "";
  if (id === myUserId) return "Me";
  const a = assignees.find(x => x.user_id === id);
  return a ? a.label : "Staff";
};

function followUpCell(l) {
  if (!l.follow_up_date) return '<span class="admin-subtext">—</span>';
  const today = isoDate(new Date());
  const cls = CLOSED_LEAD_STATUSES.includes(l.status) ? "admin-badge-slate" : l.follow_up_date < today ? "admin-badge-red" : l.follow_up_date === today ? "admin-badge-amber" : "admin-badge-slate";
  return `<span class="admin-badge ${cls}">${esc(formatDate(l.follow_up_date))}</span>`;
}

function leadPropertyCell(lead) {
  const p = lead.properties;
  const title = lead.property_title_snapshot || (p && p.title);
  if (!title) return '<span class="admin-subtext">—</span>';
  if (p && p.slug && p.is_published && !p.is_archived) {
    return `<a href="/properties/${encodeURIComponent(p.slug)}/" target="_blank" rel="noopener" class="admin-link">${esc(title)}</a>`;
  }
  return esc(title);
}

function renderLeadsTable() {
  const tbody = document.getElementById("leadsTableBody");
  const filtered = Object.values(currentFilters()).some(v => v && v !== false);
  tbody.innerHTML = pageLeads.length
    ? pageLeads.map(l => `
        <tr>
          <td data-label="Name"><button type="button" class="admin-link-btn admin-strong" data-view-lead="${esc(l.id)}">${esc(l.name || "Unnamed")}</button>
            <div class="admin-subtext">${esc(LEAD_TYPE_LABELS[l.lead_type] || "")}</div></td>
          <td data-label="Contact">${esc(l.phone || "")}${l.email ? `<div class="admin-subtext">${esc(l.email)}</div>` : ""}</td>
          <td data-label="Source">${esc(LEAD_SOURCE_LABELS[l.source] || l.source)}</td>
          <td data-label="Property">${leadPropertyCell(l)}</td>
          <td data-label="Status"><span class="admin-badge ${LEAD_STATUS_COLORS[l.status] || "admin-badge-slate"}">${esc(l.status)}</span></td>
          <td data-label="Priority"><span class="admin-badge ${PRIORITY_COLORS[l.priority] || "admin-badge-slate"}">${esc(PRIORITY_LABELS[l.priority] || "Normal")}</span></td>
          <td data-label="Assigned">${esc(assigneeLabel(l.assigned_to)) || '<span class="admin-subtext">Unassigned</span>'}</td>
          <td data-label="Follow-up">${followUpCell(l)}</td>
          <td data-label="Received" class="admin-subtext admin-nowrap">${esc(formatDate(l.created_at))}</td>
          <td data-label="Actions"><button type="button" class="admin-btn admin-btn-ghost admin-btn-sm" data-view-lead="${esc(l.id)}">Open</button></td>
        </tr>`).join("")
    : `<tr><td colspan="10"><div class="admin-empty">${filtered ? "No enquiries match these filters." : "No enquiries yet. New website enquiries will appear here."}</div></td></tr>`;

  const from = leadTotal ? (leadPage - 1) * leadPageSize + 1 : 0;
  const to = Math.min(leadPage * leadPageSize, leadTotal);
  document.getElementById("leadResultCount").textContent = leadTotal
    ? `Showing ${from}–${to} of ${leadTotal} enquir${leadTotal === 1 ? "y" : "ies"}` : "0 enquiries";
  tbody.querySelectorAll("[data-view-lead]").forEach(btn => btn.addEventListener("click", () => openLeadDetail(btn.dataset.viewLead)));
  renderLeadPagination();
}

function renderLeadPagination() {
  const el = document.getElementById("leadPagination");
  const pages = Math.max(1, Math.ceil(leadTotal / leadPageSize));
  if (pages <= 1) { el.innerHTML = ""; return; }
  const set = new Set([1, pages]);
  for (let i = leadPage - 2; i <= leadPage + 2; i++) if (i >= 1 && i <= pages) set.add(i);
  const nums = [...set].sort((a, b) => a - b);
  let html = `<button type="button" class="admin-btn admin-btn-outline admin-btn-sm" data-page="${leadPage - 1}" ${leadPage === 1 ? "disabled" : ""} aria-label="Previous page">← Previous</button>`;
  let prev = 0;
  nums.forEach(n => {
    if (n - prev > 1) html += `<span class="admin-subtext" aria-hidden="true">…</span>`;
    html += `<button type="button" class="admin-btn ${n === leadPage ? "admin-btn-primary" : "admin-btn-outline"} admin-btn-sm" data-page="${n}" ${n === leadPage ? 'aria-current="page"' : ""} aria-label="Page ${n}">${n}</button>`;
    prev = n;
  });
  html += `<button type="button" class="admin-btn admin-btn-outline admin-btn-sm" data-page="${leadPage + 1}" ${leadPage === pages ? "disabled" : ""} aria-label="Next page">Next →</button>`;
  el.innerHTML = html;
  el.querySelectorAll("[data-page]").forEach(b => b.addEventListener("click", () => {
    const n = Number(b.dataset.page);
    if (n >= 1 && n <= pages) { leadPage = n; fetchLeads(); document.getElementById("adminContent").scrollIntoView({ block: "start" }); }
  }));
}

/* ---------- detail / CRM ---------- */
function closeLeadDetail() {
  openLeadId = null;
  closeAdminModal(document.getElementById("leadDetailOverlay"));
}

const ACTIVITY_TEXT = {
  assigned: d => `Assigned to ${assigneeLabel(d.to) || "staff"}`,
  unassigned: () => "Unassigned",
  status_changed: d => `Status: ${d.from || "—"} → ${d.to}`,
  priority_changed: d => `Priority: ${PRIORITY_LABELS[d.from] || d.from} → ${PRIORITY_LABELS[d.to] || d.to}`,
  details_updated: d => `Updated ${(d.fields || []).map(f => f.replace(/_/g, " ")).join(", ")}`,
  follow_up_scheduled: d => `Follow-up scheduled for ${formatDate(d.date)}`,
  follow_up_cleared: () => "Follow-up removed",
  follow_up_completed: d => `Follow-up done${d.date ? ` (was due ${formatDate(d.date)})` : ""}`,
  note: d => d.text || "",
  call: () => "Called",
  whatsapp: () => "Sent a WhatsApp message",
  email: () => "Opened an email",
  archived: () => "Archived",
  restored: () => "Restored from archive"
};

async function openLeadDetail(id) {
  const [{ data: lead, error }, activity] = await Promise.all([
    window.supabaseClient.from("leads").select("*, properties(slug, title, is_published, is_archived)").eq("id", id).single(),
    window.supabaseClient.from("lead_activity").select("id, actor, kind, detail, created_at").eq("lead_id", id).order("created_at", { ascending: false }).limit(200)
  ]);
  if (error || !lead) { showAdminToast("Couldn't open this enquiry: " + friendlyError(error), "error"); return; }
  openLeadId = id;

  const extraFields = lead.source_details && typeof lead.source_details === "object"
    ? Object.entries(lead.source_details).map(([k, v]) => `<div><strong>${esc(k.replace(/_/g, " "))}:</strong> ${esc(v)}</div>`).join("")
    : "";
  const phoneDigits = (lead.phone || "").replace(/[^\d+]/g, "");
  let waDigits = (lead.whatsapp || lead.phone || "").replace(/\D/g, "");
  if (waDigits.length === 10 && /^[6-9]/.test(waDigits)) waDigits = "91" + waDigits;
  const isAdmin = adminCan("publishers");
  // Sales can claim an unassigned lead or release their own (the
  // database enforces the same rule).
  const assignOptions = isAdmin
    ? assignees
    : assignees.filter(a => a.user_id === myUserId || a.user_id === lead.assigned_to);
  const canChangeAssignee = isAdmin || !lead.assigned_to || lead.assigned_to === myUserId;

  const items = (activity.data || []).map(a => `
      <li class="admin-timeline-item admin-timeline-${esc(a.kind)}">
        <span class="admin-timeline-when">${esc(formatDateTime(a.created_at))}</span>
        <span class="admin-timeline-what">${a.kind === "note" ? `<span class="admin-timeline-note">${esc(ACTIVITY_TEXT.note(a.detail || {}))}</span>` : esc((ACTIVITY_TEXT[a.kind] || (() => a.kind))(a.detail || {}))}</span>
        <span class="admin-timeline-who">${esc(a.actor ? assigneeLabel(a.actor) || "Staff" : "System")}</span>
      </li>`).join("") + `
      <li class="admin-timeline-item"><span class="admin-timeline-when">${esc(formatDateTime(lead.created_at))}</span>
        <span class="admin-timeline-what">Lead created from the ${esc(LEAD_SOURCE_LABELS[lead.source] || lead.source)} form</span><span class="admin-timeline-who">Website</span></li>`;

  document.getElementById("leadDetailBody").innerHTML = `
    <div class="admin-lead-head">
      <div>
        <h3 id="leadDetailTitle">${esc(lead.name || "Unnamed")}</h3>
        <div class="admin-subtext">${esc(LEAD_TYPE_LABELS[lead.lead_type] || "")}${lead.lead_type ? " · " : ""}${esc(LEAD_SOURCE_LABELS[lead.source] || lead.source)} · ${esc(formatDateTime(lead.created_at))}${lead.is_archived ? " · Archived" : ""}</div>
      </div>
      <div class="admin-quick-actions">
        ${phoneDigits ? `<a class="admin-btn admin-btn-primary admin-btn-sm" href="tel:${esc(phoneDigits)}" data-log="call">Call</a>` : ""}
        ${waDigits ? `<a class="admin-btn admin-btn-outline admin-btn-sm" href="https://wa.me/${esc(waDigits)}" target="_blank" rel="noopener" data-log="whatsapp">WhatsApp</a>` : ""}
        ${lead.email ? `<a class="admin-btn admin-btn-outline admin-btn-sm" href="mailto:${esc(lead.email)}" data-log="email">Email</a>` : ""}
      </div>
    </div>

    <div class="admin-lead-grid">
      <div>
        <div class="admin-lead-facts">
          ${lead.phone ? `<div><strong>Phone:</strong> ${esc(lead.phone)}</div>` : ""}
          ${lead.whatsapp ? `<div><strong>WhatsApp:</strong> ${esc(lead.whatsapp)}</div>` : ""}
          ${lead.email ? `<div><strong>Email:</strong> ${esc(lead.email)}</div>` : ""}
          ${lead.property_title_snapshot || lead.properties ? `<div><strong>Property:</strong> ${leadPropertyCell(lead)}</div>` : ""}
        </div>
        ${lead.message ? `<div class="admin-field"><span class="admin-label">Message</span><p class="admin-pre">${esc(lead.message)}</p></div>` : ""}
        ${extraFields ? `<div class="admin-field"><span class="admin-label">Form details</span><div class="admin-lead-facts">${extraFields}</div></div>` : ""}

        <form id="leadCrmForm" novalidate>
          <div class="admin-form-row">
            <div class="admin-field"><label for="leadStatusSelect">Status</label>
              <select id="leadStatusSelect">${Object.keys(LEAD_STATUS_COLORS).map(s => `<option ${s === lead.status ? "selected" : ""}>${esc(s)}</option>`).join("")}</select></div>
            <div class="admin-field"><label for="leadPrioritySelect">Priority</label>
              <select id="leadPrioritySelect">${Object.entries(PRIORITY_LABELS).map(([v, l]) => `<option value="${v}" ${v === lead.priority ? "selected" : ""}>${l}</option>`).join("")}</select></div>
          </div>
          <div class="admin-form-row">
            <div class="admin-field"><label for="leadAssignSelect">Assigned to</label>
              <select id="leadAssignSelect" ${canChangeAssignee ? "" : "disabled"}>
                <option value="">Unassigned</option>
                ${assignOptions.map(a => `<option value="${esc(a.user_id)}" ${a.user_id === lead.assigned_to ? "selected" : ""}>${esc(a.user_id === myUserId ? `Me (${a.label})` : a.label)}</option>`).join("")}
                ${lead.assigned_to && !assignOptions.some(a => a.user_id === lead.assigned_to) ? `<option value="${esc(lead.assigned_to)}" selected>${esc(assigneeLabel(lead.assigned_to))}</option>` : ""}
              </select>
              ${canChangeAssignee ? "" : '<p class="admin-field-hint">Assigned to someone else — only an admin can reassign.</p>'}</div>
            <div class="admin-field"><label for="leadFollowUpInput">Follow-up date</label>
              <input type="date" id="leadFollowUpInput"></div>
          </div>
          <div class="admin-form-row">
            <div class="admin-field"><label for="leadBudgetInput">Budget</label><input type="text" id="leadBudgetInput" maxlength="200" placeholder="e.g. ₹80 L – 1 Cr"></div>
            <div class="admin-field"><label for="leadNextActionInput">Next action</label><input type="text" id="leadNextActionInput" maxlength="500" placeholder="e.g. Share 3 options in Adyar"></div>
          </div>
          <div class="admin-field"><label for="leadRequirementInput">Requirement</label><textarea id="leadRequirementInput" maxlength="2000" rows="2"></textarea></div>
          <div class="admin-field"><label for="leadNotesInput">Pinned internal notes</label><textarea id="leadNotesInput" maxlength="4000" rows="2"></textarea></div>
          <div class="admin-actions-row">
            <button type="submit" class="admin-btn admin-btn-primary admin-btn-sm" id="leadSaveBtn">Save Changes</button>
            ${lead.follow_up_date ? `<button type="button" class="admin-btn admin-btn-outline admin-btn-sm" id="leadFollowUpDoneBtn">Mark follow-up done</button>` : ""}
            <button type="button" class="admin-btn admin-btn-outline admin-btn-sm" id="leadArchiveBtn">${lead.is_archived ? "Restore" : "Archive"}</button>
          </div>
        </form>
      </div>

      <div>
        <form id="leadNoteForm" class="admin-field" novalidate>
          <label for="leadNoteInput">Add a note to the timeline</label>
          <textarea id="leadNoteInput" maxlength="4000" rows="2" placeholder="e.g. Called — wants a site visit on Sunday"></textarea>
          <button type="submit" class="admin-btn admin-btn-outline admin-btn-sm" style="margin-top:8px;">Add note</button>
        </form>
        <h4 class="admin-section-title">Timeline</h4>
        <ol class="admin-timeline">${items}</ol>
      </div>
    </div>`;

  // Values set via .value so nothing typed can break the markup.
  document.getElementById("leadNotesInput").value = lead.internal_notes || "";
  document.getElementById("leadFollowUpInput").value = lead.follow_up_date || "";
  document.getElementById("leadBudgetInput").value = lead.budget || "";
  document.getElementById("leadNextActionInput").value = lead.next_action || "";
  document.getElementById("leadRequirementInput").value = lead.requirement || "";

  document.getElementById("leadCrmForm").addEventListener("submit", e => { e.preventDefault(); saveLeadChanges(lead); });
  document.getElementById("leadArchiveBtn").addEventListener("click", () => setArchived(lead, !lead.is_archived));
  const doneBtn = document.getElementById("leadFollowUpDoneBtn");
  if (doneBtn) doneBtn.addEventListener("click", () => completeFollowUp(lead));
  document.getElementById("leadNoteForm").addEventListener("submit", e => { e.preventDefault(); addNote(lead.id); });
  document.querySelectorAll("#leadDetailBody [data-log]").forEach(a => a.addEventListener("click", () => logContact(lead.id, a.dataset.log)));

  const overlay = document.getElementById("leadDetailOverlay");
  if (!overlay.classList.contains("open")) openAdminModal(overlay, () => { openLeadId = null; });
}

async function saveLeadChanges(lead) {
  const btn = document.getElementById("leadSaveBtn");
  const val = id => document.getElementById(id).value.trim();
  const update = {
    status: val("leadStatusSelect"),
    priority: val("leadPrioritySelect"),
    follow_up_date: val("leadFollowUpInput") || null,
    budget: val("leadBudgetInput") || null,
    next_action: val("leadNextActionInput") || null,
    requirement: val("leadRequirementInput") || null,
    internal_notes: document.getElementById("leadNotesInput").value || null
  };
  const assignEl = document.getElementById("leadAssignSelect");
  if (!assignEl.disabled) update.assigned_to = assignEl.value || null;
  btn.disabled = true;
  btn.textContent = "Saving…";
  const { error } = await window.supabaseClient.from("leads").update(update).eq("id", lead.id).select("id").single();
  btn.disabled = false;
  btn.textContent = "Save Changes";
  if (error) { showAdminToast("Not saved: " + friendlyError(error), "error"); return; }
  showAdminToast("Lead updated.", "success");
  await openLeadDetail(lead.id);
  fetchLeads();
}

async function completeFollowUp(lead) {
  const next = window.prompt("Follow-up done. Schedule the next one? Enter a date (YYYY-MM-DD) or leave blank:", "");
  if (next === null) return;
  if (next && !/^\d{4}-\d{2}-\d{2}$/.test(next.trim())) { showAdminToast("Use the format YYYY-MM-DD.", "error"); return; }
  const { error } = await window.supabaseClient.rpc("complete_lead_follow_up", { p_lead_id: lead.id, p_next: next.trim() || null, p_note: null });
  if (error) { showAdminToast("Not saved: " + friendlyError(error), "error"); return; }
  showAdminToast("Follow-up marked done.", "success");
  await openLeadDetail(lead.id);
  fetchLeads();
}

async function addNote(leadId) {
  const input = document.getElementById("leadNoteInput");
  const text = input.value.trim();
  if (!text) { input.focus(); return; }
  const { error } = await window.supabaseClient.from("lead_activity").insert({ lead_id: leadId, actor: myUserId, kind: "note", detail: { text } });
  if (error) { showAdminToast("Note not saved: " + friendlyError(error), "error"); return; }
  showAdminToast("Note added.", "success");
  openLeadDetail(leadId);
}

function logContact(leadId, kind) {
  // Fire-and-forget: the link itself opens the phone / WhatsApp / mail app.
  window.supabaseClient.from("lead_activity").insert({ lead_id: leadId, actor: myUserId, kind, detail: {} })
    .then(({ error }) => { if (error) console.warn("Activity not logged:", error.message); });
}

async function setArchived(lead, archived) {
  if (archived && !window.confirm("Archive this enquiry? It moves to the Archived view and can be restored.")) return;
  const { error } = await window.supabaseClient.from("leads").update({ is_archived: archived }).eq("id", lead.id).select("id").single();
  if (error) { showAdminToast((archived ? "Archive" : "Restore") + " failed: " + friendlyError(error), "error"); return; }
  closeLeadDetail();
  fetchLeads();
  showAdminToast(archived ? "Lead archived." : "Lead restored.", "success");
}

/* ---------- CSV export ---------- */
/* Cells that start with = + - @ (or tab/CR) are prefixed with ' so a
   spreadsheet never runs them as formulas (CSV injection). */
function csvCell(v) {
  let s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

async function exportCsv() {
  const btn = document.getElementById("exportCsvBtn");
  const f = currentFilters();
  btn.disabled = true;
  btn.textContent = "Exporting…";
  const cols = "created_at, name, phone, whatsapp, email, source, lead_type, status, priority, assigned_to, follow_up_date, budget, requirement, next_action, property_title_snapshot, message, source_details, internal_notes";
  const rows = [];
  let error = null;
  for (let from = 0; from < EXPORT_LIMIT; from += 1000) {
    const res = await buildLeadQuery(cols, f).range(from, from + 999);
    if (res.error) { error = res.error; break; }
    rows.push(...res.data);
    if (res.data.length < 1000) break;
  }
  btn.disabled = false;
  btn.textContent = "Export CSV";
  if (error) { showAdminToast("Export failed: " + friendlyError(error), "error"); return; }
  if (!rows.length) { showAdminToast("Nothing to export with these filters.", "error"); return; }

  const header = ["Received", "Name", "Phone", "WhatsApp", "Email", "Source", "Type", "Status", "Priority", "Assigned To", "Follow-up", "Budget", "Requirement", "Next Action", "Property", "Message", "Form Details", "Internal Notes"];
  const lines = [header.map(csvCell).join(",")].concat(rows.map(r => [
    r.created_at, r.name, r.phone, r.whatsapp, r.email, LEAD_SOURCE_LABELS[r.source] || r.source, LEAD_TYPE_LABELS[r.lead_type] || r.lead_type,
    r.status, PRIORITY_LABELS[r.priority] || r.priority, assigneeLabel(r.assigned_to), r.follow_up_date, r.budget, r.requirement,
    r.next_action, r.property_title_snapshot, r.message,
    r.source_details && typeof r.source_details === "object" ? Object.entries(r.source_details).map(([k, v]) => `${k}: ${v}`).join("; ") : "",
    r.internal_notes
  ].map(csvCell).join(",")));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `dgss-leads-${isoDate(new Date())}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);

  const { search, ...rest } = f;
  await window.supabaseClient.rpc("log_lead_export", { p_count: rows.length, p_filters: { ...rest, search: search ? "(text search)" : "" } });
  showAdminToast(`Exported ${rows.length} enquir${rows.length === 1 ? "y" : "ies"}${rows.length >= EXPORT_LIMIT ? " (limit reached — narrow the filters)" : ""}.`, "success");
}

document.addEventListener("DOMContentLoaded", loadLeadsPage);
