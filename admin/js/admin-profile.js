async function loadProfilePage() {
  const session = await requireAdminAuth("staff");
  if (!session) return;
  watchAuthState();
  renderAdminShell();

  document.getElementById("adminContent").appendChild(document.getElementById("profileTemplate").content.cloneNode(true));
  document.getElementById("profileEmail").value = session.user.email || "";
  document.getElementById("profileRole").value = (window.ADMIN_ROLE || "").replace("_", " ");
  if (adminCan("staffManagement")) {
    document.getElementById("profileStaffHint").innerHTML = 'Add or change staff in <a class="admin-link" href="staff.html">Staff Management</a>.';
  }

  document.getElementById("changePasswordForm").addEventListener("submit", async e => {
    e.preventDefault();
    const newPassword = document.getElementById("newPassword").value;
    const confirmPassword = document.getElementById("confirmPassword").value;

    if (newPassword.length < 10) {
      showAdminToast("Password must be at least 10 characters.", "error");
      return;
    }
    if (newPassword !== confirmPassword) {
      showAdminToast("Passwords don't match.", "error");
      return;
    }

    const { error } = await changeAdminPassword(newPassword);
    if (error) {
      showAdminToast("Couldn't update password: " + error, "error");
      return;
    }
    showAdminToast("Password updated.", "success");
    e.target.reset();
  });
}

document.addEventListener("DOMContentLoaded", loadProfilePage);
