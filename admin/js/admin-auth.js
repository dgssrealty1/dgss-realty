/* ==========================================================================
   ADMIN AUTH
   ------------------------------------------------------------------------
   Uses Supabase Auth directly — no custom password handling anywhere in
   this codebase. Supabase stores passwords hashed on their end; this
   frontend only ever sends the password once, over HTTPS, to Supabase's
   own login endpoint, and gets back a session token it stores (Supabase's
   client library manages that storage/refresh itself).
   ========================================================================== */

const ADMIN_LOGIN_PAGE = "login.html";

/* Role groups — mirror of the database policies in
   supabase/migrations/20260928_01_admin_roles_rls.sql. These only drive
   what the UI shows; the database enforces the real rules, so hiding a
   button here is a convenience, never the protection itself. */
const ADMIN_ROLE_GROUPS = {
  staff: ["super_admin", "admin", "editor", "sales", "viewer"],
  contentEditors: ["super_admin", "admin", "editor"],
  publishers: ["super_admin", "admin"],
  leadAccess: ["super_admin", "admin", "sales"],
  settings: ["super_admin", "admin"],
  internalRead: ["super_admin", "admin", "editor", "sales"],
  audit: ["super_admin", "admin"],
  staffManagement: ["super_admin"]
};

function adminCan(group) {
  return !!window.ADMIN_ROLE && (ADMIN_ROLE_GROUPS[group] || []).includes(window.ADMIN_ROLE);
}

/* Returns the signed-in user's admin role from public.admin_users, or
   null if they aren't on the staff list (a plain signed-up Supabase user
   is NOT an admin). */
async function fetchAdminRole() {
  const { data, error } = await window.supabaseClient.rpc("current_admin_role");
  if (error) {
    console.error("Could not check admin role:", error.message);
    return null;
  }
  return data || null;
}

/* Call at the top of every protected admin page (dashboard, properties,
   leads, etc). Redirects to the login page if there's no active session,
   or if the session belongs to someone who isn't on the admin staff list.
   Pass a role group (see ADMIN_ROLE_GROUPS) for pages limited to some
   roles. Returns the session if access is allowed. */
async function requireAdminAuth(requiredGroup) {
  if (!window.supabaseClient) {
    // Supabase isn't configured yet — send to login, which will show a
    // clear explanation rather than silently failing.
    window.location.href = ADMIN_LOGIN_PAGE;
    return null;
  }

  const { data: { session } } = await window.supabaseClient.auth.getSession();
  if (!session) {
    window.location.href = ADMIN_LOGIN_PAGE;
    return null;
  }

  const role = await fetchAdminRole();
  if (!role) {
    await window.supabaseClient.auth.signOut();
    window.location.href = `${ADMIN_LOGIN_PAGE}?denied=1`;
    return null;
  }
  window.ADMIN_ROLE = role;

  if (requiredGroup && !adminCan(requiredGroup)) {
    window.ADMIN_ACCESS_DENIED = true;
  }
  return session;
}

/* Renders a plain "no access" panel for pages the current role can't
   use. Returns true when access was denied (caller should stop). */
function renderAccessDeniedIfNeeded() {
  if (!window.ADMIN_ACCESS_DENIED) return false;
  const content = document.getElementById("adminContent");
  if (content) {
    content.innerHTML = "";
    const box = document.createElement("div");
    box.className = "admin-card admin-empty";
    box.style.padding = "40px";
    box.textContent = `Your role (${window.ADMIN_ROLE}) doesn't have access to this page. Ask a super admin if you need it.`;
    content.appendChild(box);
  }
  return true;
}

/* If Supabase's session ever expires or is signed out from another tab,
   bounce back to login immediately rather than leaving a stale admin
   page visible. */
function watchAuthState() {
  if (!window.supabaseClient) return;
  window.supabaseClient.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") {
      window.location.href = ADMIN_LOGIN_PAGE;
    }
  });
}

async function adminLogout() {
  if (window.supabaseClient) {
    await window.supabaseClient.auth.signOut();
  }
  window.location.href = ADMIN_LOGIN_PAGE;
}

/* ---------- Login page wiring ---------- */
function initAdminLoginForm() {
  const form = document.getElementById("adminLoginForm");
  if (!form) return;

  const errorBox = document.getElementById("adminLoginError");
  const submitBtn = form.querySelector('button[type="submit"]');
  const passwordInput = document.getElementById("adminPassword");
  const toggleBtn = document.getElementById("adminPasswordToggle");

  if (!window.supabaseClient) {
    errorBox.textContent = "Supabase isn't configured yet. See supabase/SETUP.md to finish one-time setup before logging in.";
    errorBox.classList.add("show");
    submitBtn.disabled = true;
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get("denied")) {
    errorBox.textContent = "That account isn't on the admin staff list (or its access was turned off). Ask a super admin.";
    errorBox.classList.add("show");
  }
  if (params.get("reset") === "done") {
    const ok = document.getElementById("adminLoginNotice");
    if (ok) { ok.textContent = "Password updated. Log in with your new password."; ok.classList.add("show"); }
  }
  initForgotPassword();

  if (toggleBtn && passwordInput) {
    toggleBtn.addEventListener("click", () => {
      const isPassword = passwordInput.type === "password";
      passwordInput.type = isPassword ? "text" : "password";
      toggleBtn.setAttribute("aria-label", isPassword ? "Hide password" : "Show password");
    });
  }

  form.addEventListener("submit", async e => {
    e.preventDefault();
    errorBox.classList.remove("show");

    const email = document.getElementById("adminEmail").value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      errorBox.textContent = "Enter both your email and password.";
      errorBox.classList.add("show");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Signing in…";

    const { error } = await window.supabaseClient.auth.signInWithPassword({ email, password });

    if (error) {
      errorBox.textContent = "Incorrect email or password.";
      errorBox.classList.add("show");
      submitBtn.disabled = false;
      submitBtn.textContent = "Log In";
      return;
    }

    // Signing in only proves who you are — check you're actually staff
    // before going any further.
    const role = await fetchAdminRole();
    if (!role) {
      await window.supabaseClient.auth.signOut();
      errorBox.textContent = "That account isn't on the admin staff list. Ask a super admin to give you access.";
      errorBox.classList.add("show");
      submitBtn.disabled = false;
      submitBtn.textContent = "Log In";
      return;
    }

    window.location.href = "dashboard.html";
  });
}

/* ---------- Forgot password (Supabase Auth e-mail reset) ----------
   Supabase sends the reset link; the link opens reset-password.html,
   where the new password is set with auth.updateUser(). No password is
   ever stored or handled by this site's own code. The message shown is
   the same whether or not the e-mail exists (no account enumeration). */
function initForgotPassword() {
  const link = document.getElementById("forgotPasswordLink");
  const loginForm = document.getElementById("adminLoginForm");
  const resetForm = document.getElementById("forgotPasswordForm");
  const back = document.getElementById("backToLoginLink");
  const notice = document.getElementById("adminLoginNotice");
  const errorBox = document.getElementById("adminLoginError");
  if (!link || !loginForm || !resetForm) return;

  const show = forgot => {
    loginForm.hidden = forgot;
    resetForm.hidden = !forgot;
    link.hidden = forgot;
    errorBox.classList.remove("show");
    if (notice) notice.classList.remove("show");
    const focusEl = document.getElementById(forgot ? "resetEmail" : "adminEmail");
    if (focusEl) focusEl.focus();
  };
  link.addEventListener("click", e => { e.preventDefault(); show(true); });
  if (back) back.addEventListener("click", e => { e.preventDefault(); show(false); });

  resetForm.addEventListener("submit", async e => {
    e.preventDefault();
    const email = document.getElementById("resetEmail").value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) {
      errorBox.textContent = "Enter the email address you log in with.";
      errorBox.classList.add("show");
      return;
    }
    if (!window.supabaseClient) return;
    const btn = resetForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = "Sending…";
    const redirectTo = `${window.location.origin}/admin/reset-password.html`;
    const { error } = await window.supabaseClient.auth.resetPasswordForEmail(email, { redirectTo });
    btn.disabled = false;
    btn.textContent = "Send reset link";
    if (error && /rate|too many/i.test(error.message || "")) {
      errorBox.textContent = "Too many attempts. Please wait a few minutes and try again.";
      errorBox.classList.add("show");
      return;
    }
    if (error) console.warn("Password reset request:", error.message);
    if (notice) {
      notice.textContent = "If that email belongs to a staff account, a password reset link is on its way. Check your inbox (and spam folder).";
      notice.classList.add("show");
    }
    resetForm.reset();
  });
}

/* reset-password.html: Supabase signs the user in from the e-mail link
   (recovery or invite); they choose a new password, then log in again. */
function initResetPasswordPage() {
  const form = document.getElementById("resetPasswordForm");
  if (!form) return;
  const errorBox = document.getElementById("adminLoginError");
  const intro = document.getElementById("resetIntro");
  const fail = msg => { errorBox.textContent = msg; errorBox.classList.add("show"); };
  if (!window.supabaseClient) { fail("Supabase isn't configured."); form.hidden = true; return; }
  if (new URLSearchParams(window.location.search).get("invite") && intro) {
    intro.textContent = "Welcome! Choose a password for your new staff account.";
  }

  let ready = false;
  const enable = () => { ready = true; form.hidden = false; const w = document.getElementById("resetWaiting"); if (w) w.hidden = true; };
  window.supabaseClient.auth.onAuthStateChange((event, session) => {
    if ((event === "PASSWORD_RECOVERY" || event === "SIGNED_IN" || event === "INITIAL_SESSION") && session) enable();
  });
  window.supabaseClient.auth.getSession().then(({ data }) => { if (data && data.session) enable(); });
  setTimeout(() => {
    if (!ready) {
      const w = document.getElementById("resetWaiting");
      if (w) w.hidden = true;
      fail("This reset link is invalid or has expired. Go back to the login page and request a new one.");
    }
  }, 6000);

  form.addEventListener("submit", async e => {
    e.preventDefault();
    errorBox.classList.remove("show");
    const pw = document.getElementById("newPassword").value;
    const confirmPw = document.getElementById("confirmPassword").value;
    if (pw.length < 10) return fail("Use at least 10 characters.");
    if (pw !== confirmPw) return fail("The two passwords don't match.");
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    const { error } = await window.supabaseClient.auth.updateUser({ password: pw });
    btn.disabled = false;
    if (error) return fail("Couldn't update the password: " + error.message);
    await window.supabaseClient.auth.signOut();
    window.location.href = `${ADMIN_LOGIN_PAGE}?reset=done`;
  });
}

/* ---------- Change password (used on the Profile page) ---------- */
async function changeAdminPassword(newPassword) {
  if (!window.supabaseClient) return { error: "Supabase not configured." };
  const { error } = await window.supabaseClient.auth.updateUser({ password: newPassword });
  return { error: error ? error.message : null };
}

/* ---------- HTML escaping ----------
   Everything that comes out of the database (and especially anything a
   public visitor typed into a form — lead names, messages, emails) must
   go through esc() before being placed inside an innerHTML template.
   Without it, a lead named <img src=x onerror=...> runs script inside
   the logged-in admin's session. */
function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* Only allow http(s) URLs into src/href attributes (blocks javascript:). */
function safeUrl(value) {
  const s = String(value || "").trim();
  return /^https?:\/\//i.test(s) || s.startsWith("/") ? esc(s) : "";
}

/* Friendly text for database errors (RLS, triggers, constraints). The
   database message is shown when it was written for people (our
   triggers raise plain-English messages). */
function friendlyError(error) {
  if (!error) return "";
  const msg = error.message || String(error);
  if (error.code === "23505" || /duplicate key/i.test(msg)) return "That value is already used by another record.";
  if (/row-level security|permission denied/i.test(msg)) return "Your role isn't allowed to do that.";
  if (error.code === "42501" || error.code === "23514" || error.code === "P0002") return msg;
  if (/check constraint/i.test(msg)) return "One of the values isn't allowed.";
  return msg;
}

/* Modal helpers: ESC closes, focus moves into the dialog and back. */
function openAdminModal(overlay, onClose) {
  if (!overlay) return;
  overlay._lastFocus = document.activeElement;
  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");
  const focusable = overlay.querySelector("input:not([type=hidden]), select, textarea, button");
  if (focusable) focusable.focus();
  overlay._onKey = e => {
    if (e.key === "Escape") { closeAdminModal(overlay); if (onClose) onClose(); }
    if (e.key === "Tab") {
      const f = Array.from(overlay.querySelectorAll('a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])')).filter(el => el.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { f[f.length - 1].focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { f[0].focus(); e.preventDefault(); }
    }
  };
  overlay.addEventListener("keydown", overlay._onKey);
}
function closeAdminModal(overlay) {
  if (!overlay || !overlay.classList.contains("open")) return;
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden", "true");
  if (overlay._onKey) overlay.removeEventListener("keydown", overlay._onKey);
  if (overlay._lastFocus && document.body.contains(overlay._lastFocus)) overlay._lastFocus.focus();
}

// Login / reset pages: wire the forms once every deferred script has run.
document.addEventListener("DOMContentLoaded", () => {
  if (document.getElementById("adminLoginForm")) initAdminLoginForm();
  if (document.getElementById("resetPasswordForm")) initResetPasswordPage();
});

/* ---------- Property image display URLs (admin only) ----------
   The property-images bucket is private (migration 04), so uploaded
   photos — especially drafts — can't be shown with their stored URL.
   Staff get short-lived signed URLs instead (Storage RLS lets any staff
   role read). Seeded photos that live on the website itself (no
   storage_path) keep their normal URL. Adds `displayUrl` to each image. */
async function attachAdminImageUrls(images) {
  const list = (images || []).filter(Boolean);
  const withPath = list.filter(i => i.storage_path);
  list.forEach(i => { if (!i.storage_path) i.displayUrl = i.public_url; });
  for (let n = 0; n < withPath.length; n += 100) {
    const chunk = withPath.slice(n, n + 100);
    const { data, error } = await window.supabaseClient.storage
      .from("property-images").createSignedUrls(chunk.map(i => i.storage_path), 3600);
    if (error) { console.warn("Could not create signed image URLs:", error.message); continue; }
    const byPath = {};
    (data || []).forEach(d => { if (d && d.signedUrl) byPath[d.path] = d.signedUrl; });
    chunk.forEach(i => { i.displayUrl = byPath[i.storage_path] || ""; });
  }
  return list;
}

/* ---------- Image file clean-up ----------
   Deleting an image RECORD queues its file in storage_cleanup_queue
   (database trigger). This removes the file and resolves the queue
   entry; if Storage refuses, the failure is recorded so an admin can
   retry from Media Library → Storage clean-up. Nothing fails silently. */
async function removePropertyImageFiles(paths) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return { removed: 0, failed: 0 };
  const { error } = await window.supabaseClient.storage.from("property-images").remove(list);
  if (error) {
    await Promise.all(list.map(p => window.supabaseClient.rpc("report_storage_cleanup_failure", { p_path: p, p_error: error.message || "remove failed" })));
    console.warn("Image file clean-up failed (queued for retry):", error);
    return { removed: 0, failed: list.length };
  }
  const { data } = await window.supabaseClient.rpc("resolve_storage_cleanup", { p_paths: list });
  return { removed: list.length, failed: 0, resolved: data || 0 };
}

/* Workflow stage shown in lists and badges. Publication, review and
   market status live in separate columns; this is just their summary. */
function propertyStage(p) {
  if (!p) return { label: "New", cls: "admin-badge-slate" };
  if (p.is_archived) return { label: "Archived", cls: "admin-badge-red" };
  if (p.is_published) {
    if (["Sold", "Rented", "Leased"].includes(p.status)) return { label: `Published · ${p.status}`, cls: "admin-badge-slate" };
    if (p.status === "Under Offer") return { label: "Published · Under Offer", cls: "admin-badge-amber" };
    return { label: "Published", cls: "admin-badge-green" };
  }
  if (p.review_status === "approved") return { label: "Approved", cls: "admin-badge-orange" };
  if (p.review_status === "under_review") return { label: "Under Review", cls: "admin-badge-amber" };
  return { label: "Draft", cls: "admin-badge-slate" };
}
