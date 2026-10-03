/* ==========================================================================
   STAFF MANAGEMENT (super_admin only)
   Every rule here is enforced by the database (migration 05):
     - admin_users RLS: only super_admin may insert/update/delete
     - list_staff() / add_staff_by_email(): super_admin only
     - guard_last_super_admin(): the last ACTIVE super_admin can't be
       removed, demoted or deactivated
   This page is a convenience on top; hiding it changes nothing.
   ========================================================================== */
const ROLE_LABELS = { super_admin: "Super Admin", admin: "Admin", editor: "Editor", sales: "Sales", viewer: "Viewer" };
let staffRows = [];
let myUserId = null;

async function loadStaffPage() {
  const session = await requireAdminAuth("staffManagement");
  if (!session) return;
  myUserId = session.user.id;
  watchAuthState();
  renderAdminShell();
  if (renderAccessDeniedIfNeeded()) return;

  document.getElementById("adminContent").appendChild(document.getElementById("staffTemplate").content.cloneNode(true));
  document.getElementById("addStaffForm").addEventListener("submit", e => { e.preventDefault(); addStaff("invite"); });
  document.getElementById("addExistingBtn").addEventListener("click", () => addStaff("existing"));
  await refreshStaff();
}

async function refreshStaff() {
  const { data, error } = await window.supabaseClient.rpc("list_staff");
  const tbody = document.getElementById("staffTableBody");
  if (error) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="admin-empty">Couldn't load staff: ${esc(friendlyError(error))}</div></td></tr>`;
    return;
  }
  staffRows = data || [];
  const activeSupers = staffRows.filter(r => r.role === "super_admin" && r.is_active).length;
  tbody.innerHTML = staffRows.map(r => {
    const me = r.user_id === myUserId;
    const lastSuper = r.role === "super_admin" && r.is_active && activeSupers <= 1;
    return `
      <tr>
        <td data-label="Person"><strong>${esc(r.display_name || r.email)}</strong>${me ? ' <span class="admin-badge admin-badge-slate">You</span>' : ""}
          <div class="admin-subtext">${esc(r.email)}</div></td>
        <td data-label="Role">
          <label class="sr-only" for="role-${esc(r.user_id)}">Role for ${esc(r.email)}</label>
          <select id="role-${esc(r.user_id)}" data-role-for="${esc(r.user_id)}" ${lastSuper ? 'disabled title="The last active super admin can\'t be demoted"' : ""}>
            ${Object.entries(ROLE_LABELS).map(([v, l]) => `<option value="${v}" ${v === r.role ? "selected" : ""}>${l}</option>`).join("")}
          </select>
        </td>
        <td data-label="Access">${r.is_active ? '<span class="admin-badge admin-badge-green">Active</span>' : '<span class="admin-badge admin-badge-red">Switched off</span>'}</td>
        <td data-label="Last sign-in" class="admin-subtext">${r.last_sign_in_at ? esc(formatDateTime(r.last_sign_in_at)) : "Never"}</td>
        <td data-label="Actions" class="admin-row-actions">
          <button type="button" class="admin-btn admin-btn-outline admin-btn-sm" data-toggle-active="${esc(r.user_id)}" ${lastSuper ? "disabled" : ""}>${r.is_active ? "Switch off access" : "Restore access"}</button>
          <button type="button" class="admin-btn admin-btn-danger admin-btn-sm" data-revoke="${esc(r.user_id)}" ${lastSuper ? "disabled" : ""}>Remove from staff</button>
        </td>
      </tr>`;
  }).join("") || `<tr><td colspan="5"><div class="admin-empty">No staff yet.</div></td></tr>`;

  tbody.querySelectorAll("[data-role-for]").forEach(sel => sel.addEventListener("change", () => changeRole(sel.dataset.roleFor, sel.value, sel)));
  tbody.querySelectorAll("[data-toggle-active]").forEach(b => b.addEventListener("click", () => toggleActive(b.dataset.toggleActive)));
  tbody.querySelectorAll("[data-revoke]").forEach(b => b.addEventListener("click", () => revoke(b.dataset.revoke)));
}

const rowFor = id => staffRows.find(r => r.user_id === id);

async function changeRole(id, role, select) {
  const r = rowFor(id);
  if (!r || r.role === role) return;
  const self = id === myUserId && r.role === "super_admin" && role !== "super_admin";
  const msg = self
    ? `Change YOUR OWN role to ${ROLE_LABELS[role]}? You will lose access to this page immediately.`
    : `Change ${r.email} from ${ROLE_LABELS[r.role]} to ${ROLE_LABELS[role]}?`;
  if (!window.confirm(msg)) { select.value = r.role; return; }
  const { error } = await window.supabaseClient.from("admin_users").update({ role }).eq("user_id", id).select("user_id").single();
  if (error) { select.value = r.role; showAdminToast("Role not changed: " + friendlyError(error), "error"); return; }
  showAdminToast("Role updated.", "success");
  if (self) { window.location.href = "dashboard.html"; return; }
  refreshStaff();
}

async function toggleActive(id) {
  const r = rowFor(id);
  if (!r) return;
  const next = !r.is_active;
  if (!window.confirm(next ? `Restore admin access for ${r.email}?` : `Switch off admin access for ${r.email}? They keep their login but can't see or change anything until restored.`)) return;
  const { error } = await window.supabaseClient.from("admin_users").update({ is_active: next }).eq("user_id", id).select("user_id").single();
  if (error) { showAdminToast("Not changed: " + friendlyError(error), "error"); return; }
  showAdminToast(next ? "Access restored." : "Access switched off.", "success");
  refreshStaff();
}

async function revoke(id) {
  const r = rowFor(id);
  if (!r) return;
  if (!window.confirm(`Remove ${r.email} from staff? Their login stays in Supabase Auth but has no admin access. You can add them back later.`)) return;
  const { error, count } = await window.supabaseClient.from("admin_users").delete({ count: "exact" }).eq("user_id", id);
  if (error || count === 0) { showAdminToast("Not removed: " + (error ? friendlyError(error) : "not allowed"), "error"); return; }
  showAdminToast("Removed from staff.", "success");
  if (id === myUserId) { window.location.href = "login.html"; return; }
  refreshStaff();
}

async function addStaff(mode) {
  const emailEl = document.getElementById("staffEmail");
  const email = emailEl.value.trim().toLowerCase();
  const role = document.getElementById("staffRole").value;
  const displayName = document.getElementById("staffName").value.trim();
  const status = document.getElementById("addStaffStatus");
  if (!/^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$/i.test(email)) {
    emailEl.focus();
    showAdminToast("Enter a valid email address.", "error");
    return;
  }
  if (role === "super_admin" && !window.confirm(`Give ${email} SUPER ADMIN access (including staff management)?`)) return;

  status.textContent = mode === "invite" ? "Sending invitation…" : "Adding…";
  let result;
  if (mode === "invite") {
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    try {
      const res = await fetch("/api/admin/invite-staff", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ email, role, displayName })
      });
      result = await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }));
    } catch (_) {
      result = { ok: false, error: "offline" };
    }
  } else {
    const { data, error } = await window.supabaseClient.rpc("add_staff_by_email", { p_email: email, p_role: role, p_display_name: displayName || null });
    result = error ? { ok: false, error: friendlyError(error) } : data;
  }
  status.textContent = "";

  const messages = {
    no_account: "No login exists for that email yet. Use “Send invitation”, or create the user in Supabase → Authentication → Users first.",
    invalid_role: "Pick a valid role.",
    invite_not_configured: "Email invitations aren't switched on for this site yet (needs the SUPABASE_SERVICE_ROLE_KEY Worker secret — see supabase/migrations/README.md). Create the user in Supabase → Authentication → Users, then click “Add existing account”.",
    forbidden: "Only a super admin can add staff.",
    invite_failed: "Supabase couldn't send the invitation. Try again, or add the user in Supabase and use “Add existing account”.",
    offline: "Couldn't reach the server. Check your connection."
  };
  if (!result || !result.ok) {
    showAdminToast(messages[result && result.error] || ("Not added: " + ((result && result.error) || "unknown error")), "error");
    return;
  }
  showAdminToast(mode === "invite" && result.invited ? `Invitation sent to ${email}.` : `${email} now has ${ROLE_LABELS[role]} access.`, "success");
  document.getElementById("addStaffForm").reset();
  refreshStaff();
}

document.addEventListener("DOMContentLoaded", loadStaffPage);
