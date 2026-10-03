/* ==========================================================================
   DASHBOARD
   All counts come from ONE database call, dashboard_stats(), which runs
   with the signed-in user's permissions (RLS) — lead numbers are only
   returned to roles that may see leads. Every tile links to the matching
   filtered list, so each number can be checked.
   ========================================================================== */
const PROPERTY_TILES = [
  { key: "active", label: "Active (live & available)", href: "properties.html?filter=published", accent: true },
  { key: "draft", label: "Draft", href: "properties.html?filter=drafts" },
  { key: "under_review", label: "Under Review", href: "properties.html?filter=review" },
  { key: "approved", label: "Approved, not yet live", href: "properties.html" },
  { key: "published", label: "Published", href: "properties.html" },
  { key: "under_offer", label: "Under Offer", href: "properties.html" },
  { key: "sold", label: "Sold", href: "properties.html" },
  { key: "rented", label: "Rented", href: "properties.html" },
  { key: "leased", label: "Leased", href: "properties.html" },
  { key: "archived", label: "Archived", href: "properties.html?filter=archived" }
];
const LEAD_STATUS_TILES = ["New", "Contacted", "Follow-up", "Qualified", "Closed", "Not Interested"];
const SOURCE_LABELS = {
  property_enquiry: "Property Enquiry", list_with_us: "List With Us", free_valuation: "Valuation",
  joint_venture: "Joint Venture (JV)", nri_services: "NRI", contact_form: "Contact"
};
const AUDIT_TEXT = {
  property_created: "created a property", property_edited: "edited", property_published: "published",
  property_unpublished: "unpublished", property_archived: "archived", property_unarchived: "unarchived",
  property_deleted: "deleted a property", price_changed: "changed the price of", featured_image_changed: "changed the featured photo of",
  image_added: "added a photo to", image_deleted: "deleted a photo from", property_review_under_review: "submitted for review",
  property_review_approved: "approved", property_review_draft: "sent back to draft", lead_status_changed: "changed a lead's status",
  lead_archived: "archived a lead", lead_restored: "restored a lead", lead_assigned: "assigned a lead", lead_deleted: "deleted a lead",
  settings_changed: "changed site settings", testimonial_created: "added a testimonial", testimonial_changed: "edited a testimonial",
  testimonial_published: "published a testimonial", testimonial_unpublished: "unpublished a testimonial", testimonial_deleted: "deleted a testimonial",
  staff_added: "added staff", staff_role_changed: "changed a staff role", staff_deactivated: "switched off staff access",
  staff_reactivated: "restored staff access", staff_removed: "removed staff", internal_data_changed: "updated internal details of",
  leads_exported: "exported leads"
};

function tile(t, value) {
  return `<a class="admin-stat-card${t.accent ? " accent" : ""}" href="${t.href}">
      <span class="admin-stat-label">${esc(t.label)}</span>
      <span class="admin-stat-value">${esc(value)}</span>
    </a>`;
}

async function loadDashboard() {
  const session = await requireAdminAuth("staff");
  if (!session) return;
  watchAuthState();
  renderAdminShell();
  document.getElementById("adminContent").appendChild(document.getElementById("dashboardTemplate").content.cloneNode(true));

  const quick = document.getElementById("quickActions");
  quick.innerHTML = [
    adminCan("contentEditors") ? '<a href="property-edit.html" class="admin-btn admin-btn-primary">+ Add Property</a>' : "",
    adminCan("leadAccess") ? '<a href="leads.html?assigned=me" class="admin-btn admin-btn-outline">My Leads</a>' : "",
    adminCan("publishers") ? '<a href="properties.html?filter=review" class="admin-btn admin-btn-outline">Review Queue</a>' : ""
  ].join("");

  const { data: stats, error } = await window.supabaseClient.rpc("dashboard_stats");
  if (error || !stats) {
    document.getElementById("propertyStats").innerHTML = `<div class="admin-empty" style="grid-column:1/-1;">Couldn't load the numbers: ${esc(friendlyError(error))}</div>`;
  } else {
    const p = stats.properties || {};
    document.getElementById("propertyStats").innerHTML = PROPERTY_TILES.map(t => tile(t, p[t.key] ?? 0)).join("");
    if (stats.leads) renderLeadStats(stats.leads);
  }

  await Promise.all([loadRecentProperties(), stats && stats.leads ? loadLeadLists() : null, loadRecentActivity()]);
}

function renderLeadStats(l) {
  document.getElementById("leadStatsSection").hidden = false;
  const byStatus = l.by_status || {};
  const tiles = [
    { label: "Open enquiries", href: "leads.html", value: l.open || 0, accent: true },
    ...LEAD_STATUS_TILES.map(s => ({ label: s, href: `leads.html?status=${encodeURIComponent(s)}`, value: byStatus[s] || 0 })),
    { label: "Follow-ups overdue", href: "leads.html?followup=overdue", value: l.follow_ups_overdue || 0 },
    { label: "Assigned to me", href: "leads.html?assigned=me", value: l.mine || 0 }
  ];
  document.getElementById("leadStats").innerHTML = tiles.map(t => tile(t, t.value)).join("");
  const bySource = l.by_source || {};
  const max = Math.max(1, ...Object.values(bySource));
  document.getElementById("leadSources").innerHTML = Object.keys(SOURCE_LABELS).map(k => `
      <li><a href="leads.html?source=${k}"><span>${esc(SOURCE_LABELS[k])}</span><strong>${bySource[k] || 0}</strong></a>
        <span class="admin-bar" style="width:${Math.round(((bySource[k] || 0) / max) * 100)}%"></span></li>`).join("");
}

async function loadRecentProperties() {
  const { data, error } = await window.supabaseClient.from("properties")
    .select("id, title, location, status, is_published, is_archived, review_status, updated_at")
    .order("updated_at", { ascending: false }).limit(6);
  const box = document.getElementById("recentProperties");
  if (error) { box.innerHTML = `<p class="admin-subtext">Couldn't load recent properties.</p>`; return; }
  box.innerHTML = data.length ? data.map(p => {
    const st = propertyStage(p);
    return `<div class="admin-list-row">
        <div><div class="admin-strong">${esc(p.title)}</div><div class="admin-subtext">${esc(p.location || "")} · ${esc(formatDate(p.updated_at))}</div></div>
        <span class="admin-badge ${st.cls}">${esc(st.label)}</span>
        <a href="property-edit.html?id=${encodeURIComponent(p.id)}" class="admin-btn admin-btn-ghost admin-btn-sm">${adminCan("contentEditors") ? "Edit" : "View"}</a>
      </div>`;
  }).join("") : `<p class="admin-subtext">No properties yet.</p>`;
}

async function loadLeadLists() {
  document.getElementById("recentLeadsCard").hidden = false;
  const soon = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const [recent, due] = await Promise.all([
    window.supabaseClient.from("leads").select("id, name, source, status, property_title_snapshot, created_at")
      .eq("is_archived", false).order("created_at", { ascending: false }).limit(6),
    window.supabaseClient.from("leads").select("id, name, status, follow_up_date, next_action")
      .eq("is_archived", false).lte("follow_up_date", soon).not("status", "in", '("Closed","Not Interested")')
      .order("follow_up_date", { ascending: true }).limit(8)
  ]);
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById("recentLeads").innerHTML = recent.error ? `<p class="admin-subtext">Couldn't load enquiries.</p>`
    : recent.data.length ? recent.data.map(l => `<div class="admin-list-row">
        <div><a class="admin-strong admin-link" href="leads.html?lead=${encodeURIComponent(l.id)}">${esc(l.name || "Unnamed")}</a>
          <div class="admin-subtext">${esc(SOURCE_LABELS[l.source] || l.source)}${l.property_title_snapshot ? " · " + esc(l.property_title_snapshot) : ""} · ${esc(formatDate(l.created_at))}</div></div>
        <span class="admin-badge admin-badge-orange">${esc(l.status)}</span></div>`).join("")
    : `<p class="admin-subtext">No enquiries yet.</p>`;
  document.getElementById("pendingFollowUps").innerHTML = due.error ? `<p class="admin-subtext">Couldn't load follow-ups.</p>`
    : due.data.length ? due.data.map(l => `<div class="admin-list-row">
        <div><a class="admin-strong admin-link" href="leads.html?lead=${encodeURIComponent(l.id)}">${esc(l.name || "Unnamed")}</a>
          <div class="admin-subtext">${esc(l.next_action || l.status)}</div></div>
        <span class="admin-badge ${l.follow_up_date < today ? "admin-badge-red" : "admin-badge-amber"}">${esc(formatDate(l.follow_up_date))}</span></div>`).join("")
    : `<p class="admin-subtext">Nothing due. 🎉</p>`;
}

async function loadRecentActivity() {
  const card = document.getElementById("recentActivityCard");
  const list = document.getElementById("recentActivity");
  if (adminCan("audit")) {
    const [{ data, error }, labels] = await Promise.all([
      window.supabaseClient.from("audit_log").select("created_at, actor, actor_role, action, entity_type, summary").order("created_at", { ascending: false }).limit(10),
      window.supabaseClient.rpc("staff_labels")
    ]);
    if (error) return;
    const who = id => ((labels.data || []).find(x => x.user_id === id) || {}).label || (id ? "Staff" : "System");
    card.hidden = false;
    document.getElementById("auditLink").hidden = false;
    list.innerHTML = data.length ? data.map(a => `<li class="admin-timeline-item">
        <span class="admin-timeline-when">${esc(formatDateTime(a.created_at))}</span>
        <span class="admin-timeline-what"><strong>${esc(who(a.actor))}</strong> ${esc(AUDIT_TEXT[a.action] || a.action.replace(/_/g, " "))}${a.summary && a.entity_type !== "settings" ? " " + esc(a.summary) : ""}</span>
      </li>`).join("") : `<li class="admin-subtext">No activity recorded yet.</li>`;
  } else if (adminCan("leadAccess")) {
    const { data, error } = await window.supabaseClient.from("lead_activity").select("created_at, kind, lead_id, detail").order("created_at", { ascending: false }).limit(10);
    if (error || !data.length) return;
    card.hidden = false;
    list.innerHTML = data.map(a => `<li class="admin-timeline-item">
        <span class="admin-timeline-when">${esc(formatDateTime(a.created_at))}</span>
        <span class="admin-timeline-what"><a class="admin-link" href="leads.html?lead=${encodeURIComponent(a.lead_id)}">Lead</a> — ${esc(a.kind.replace(/_/g, " "))}</span>
      </li>`).join("");
  }
}

document.addEventListener("DOMContentLoaded", loadDashboard);
