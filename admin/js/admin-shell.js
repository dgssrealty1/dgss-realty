/* ==========================================================================
   ADMIN SHELL — renders the sidebar + topbar into every protected admin
   page so the nav only has to be maintained in one place. Each page sets
   window.ADMIN_PAGE_TITLE and window.ADMIN_ACTIVE_NAV before this runs
   (see the small inline script at the top of each admin HTML file).
   ========================================================================== */

const ADMIN_NAV = [
  { key: "dashboard", label: "Dashboard", href: "dashboard.html", icon: "grid", group: "staff" },
  {
    key: "properties", label: "Properties", icon: "home", group: "staff",
    children: [
      { key: "properties-all", label: "All Properties", href: "properties.html" },
      { key: "properties-add", label: "Add Property", href: "property-edit.html", group: "contentEditors" },
      { key: "properties-review", label: "Awaiting Review", href: "properties.html?filter=review" },
      { key: "properties-featured", label: "Featured", href: "properties.html?filter=featured" },
      { key: "properties-drafts", label: "Drafts", href: "properties.html?filter=drafts" },
      { key: "properties-archived", label: "Archived", href: "properties.html?filter=archived" }
    ]
  },
  {
    key: "leads", label: "Leads / Enquiries", icon: "inbox", group: "leadAccess",
    children: [
      { key: "leads-all", label: "All Enquiries", href: "leads.html" },
      { key: "leads-mine", label: "My Leads", href: "leads.html?assigned=me" },
      { key: "leads-followups", label: "Follow-ups Due", href: "leads.html?followup=due" },
      { key: "leads-property", label: "Property Enquiries", href: "leads.html?source=property_enquiry" },
      { key: "leads-list", label: "List With Us", href: "leads.html?source=list_with_us" },
      { key: "leads-valuation", label: "Free Valuation", href: "leads.html?source=free_valuation" },
      { key: "leads-jv", label: "Joint Venture", href: "leads.html?source=joint_venture" },
      { key: "leads-nri", label: "NRI Services", href: "leads.html?source=nri_services" }
    ]
  },
  { key: "testimonials", label: "Testimonials", href: "testimonials.html", icon: "star", group: "staff" },
  { key: "media", label: "Media Library", href: "media.html", icon: "image", group: "staff" },
  { key: "homepage", label: "Homepage", href: "homepage.html", icon: "layout", group: "settings" },
  { key: "contact", label: "Contact Details", href: "contact-settings.html", icon: "phone", group: "settings" },
  { key: "seo", label: "SEO", href: "seo.html", icon: "search", group: "settings" },
  { key: "settings", label: "Branding", href: "settings.html", icon: "settings", group: "settings" },
  { key: "staff", label: "Staff Management", href: "staff.html", icon: "users", group: "staffManagement" },
  { key: "audit", label: "Audit Log", href: "audit.html", icon: "list", group: "audit" },
  { key: "profile", label: "My Profile", href: "profile.html", icon: "user", group: "staff" }
];

const ADMIN_ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-9"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.34 1.79.65 2.65a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.43-1.22a2 2 0 0 1 2.11-.45c.86.31 1.75.53 2.65.65A2 2 0 0 1 22 16.92z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
};

function renderAdminShell() {
  const slot = document.getElementById("adminShellSlot");
  if (!slot) return;

  // Page title + active menu item come from <meta name="dgss-admin-page">
  // (kept out of inline <script> so the Content-Security-Policy can block
  // all inline script).
  const meta = document.querySelector('meta[name="dgss-admin-page"]');
  const activeKey = window.ADMIN_ACTIVE_NAV || (meta && meta.dataset.nav) || "";
  const pageTitle = window.ADMIN_PAGE_TITLE || (meta && meta.content) || "";

  // Hide links the current role can't use (UX only — the database
  // enforces access regardless of what the menu shows).
  const visible = entry => !entry.group || typeof adminCan !== "function" || adminCan(entry.group);
  const navHtml = ADMIN_NAV.filter(visible).map(item => {
    if (item.children) {
      const childrenHtml = item.children.filter(visible).map(c => `
        <a href="${c.href}" class="${c.key === activeKey ? "active" : ""}"${c.key === activeKey ? ' aria-current="page"' : ""}>${c.label}</a>
      `).join("");
      return `
        <div class="admin-nav-item-group">
          <span class="admin-nav-toggle" style="opacity:.9;cursor:default;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ADMIN_ICONS[item.icon]}</svg>
            ${item.label}
          </span>
          <div class="admin-nav-sub">${childrenHtml}</div>
        </div>
      `;
    }
    return `
      <a href="${item.href}" class="${item.key === activeKey ? "active" : ""}"${item.key === activeKey ? ' aria-current="page"' : ""}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ADMIN_ICONS[item.icon]}</svg>
        ${item.label}
      </a>
    `;
  }).join("");

  slot.innerHTML = `
    <div class="admin-shell">
      <aside class="admin-sidebar" id="adminSidebar" aria-label="Admin navigation">
        <div class="admin-brand">
          <span class="brand-wordmark on-dark admin-wordmark"><span class="wm-dgss">DGSS</span><span class="wm-realty">REALTY</span></span>
          <span class="admin-brand-sub">Admin${window.ADMIN_ROLE ? " · " + esc(window.ADMIN_ROLE.replace("_", " ")) : ""}</span>
        </div>
        <nav class="admin-nav">${navHtml}</nav>
        <div class="admin-sidebar-footer">
          <button type="button" class="admin-logout-btn" id="adminLogoutBtn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            Logout
          </button>
        </div>
      </aside>
      <div class="admin-mobile-overlay" id="adminMobileOverlay"></div>
      <div class="admin-main">
        <div class="admin-topbar">
          <div style="display:flex;align-items:center;gap:12px;">
            <button type="button" class="admin-mobile-toggle" id="adminMobileToggle" aria-label="Open menu" aria-expanded="false" aria-controls="adminSidebar">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
            </button>
            <h1>${esc(pageTitle)}</h1>
          </div>
          <div class="admin-topbar-actions" id="adminTopbarActions">
            <a href="https://dgssrealty.com" class="admin-btn admin-btn-outline admin-btn-sm" id="adminVisitSite" target="_blank" rel="noopener noreferrer" aria-label="Visit Site (opens the public website in a new tab)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              Visit Site
            </a>
          </div>
        </div>
        <div class="admin-content" id="adminContent"></div>
      </div>
    </div>
  `;

  const logoutBtn = document.getElementById("adminLogoutBtn");
  if (logoutBtn) logoutBtn.addEventListener("click", adminLogout);

  const mobileToggle = document.getElementById("adminMobileToggle");
  const sidebar = document.getElementById("adminSidebar");
  const overlay = document.getElementById("adminMobileOverlay");
  if (mobileToggle && sidebar && overlay) {
    const open = () => {
      sidebar.classList.add("open");
      overlay.classList.add("open");
      mobileToggle.setAttribute("aria-expanded", "true");
      const first = sidebar.querySelector("a, button");
      if (first) first.focus();
    };
    const close = () => {
      if (!sidebar.classList.contains("open")) return;
      sidebar.classList.remove("open");
      overlay.classList.remove("open");
      mobileToggle.setAttribute("aria-expanded", "false");
      mobileToggle.focus();
    };
    mobileToggle.addEventListener("click", open);
    overlay.addEventListener("click", close);
    document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
    sidebar.querySelectorAll("a").forEach(a => a.addEventListener("click", () => {
      sidebar.classList.remove("open"); overlay.classList.remove("open");
    }));
  }
}

/* Small shared formatting helpers for admin pages. */
function formatDateTime(v) {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function formatDate(v) {
  if (!v) return "";
  const d = new Date(String(v).length === 10 ? v + "T00:00:00" : v);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function showAdminToast(message, type) {
  const existing = document.querySelector(".admin-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = `admin-toast ${type || ""}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, type === "error" ? 6000 : 3200);
}
