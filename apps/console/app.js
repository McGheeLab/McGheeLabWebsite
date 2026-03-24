/* ================================================================
   Admin Console — McGheeLab Lab App
   Master control panel for all lab apps.
   Manage permissions, configure integrations, and monitor usage.
   Admin-only access.
   ================================================================ */

(() => {
  const appEl = document.getElementById('app');

  document.addEventListener('DOMContentLoaded', () => {
    McgheeLab.AppBridge.init();
    McgheeLab.AppBridge.onReady((user, profile) => {
      if (!McgheeLab.AppBridge.isAdmin()) {
        appEl.innerHTML = `
          <div class="app-auth-wall">
            <h2>Admin access required</h2>
            <p>This console is restricted to lab administrators.</p>
            <a href="${McgheeLab.AppBridge.isEmbedded() ? '#' : '../../'}#/apps"
               target="${McgheeLab.AppBridge.isEmbedded() ? '_parent' : '_self'}"
               class="app-auth-link">Back to Lab Apps</a>
          </div>`;
        return;
      }
      render(user, profile);
    });
  });

  function render(user, profile) {
    appEl.innerHTML = `
      <div class="app-card">
        <h2>Admin Console</h2>
        <p style="color: var(--muted);">
          Master control panel for all lab apps. Manage permissions, configure integrations, and monitor usage.
        </p>
        <div class="console-sections">
          <div class="console-section">
            <h3>App Management</h3>
            <p>Enable or disable apps, configure settings, and manage app-level permissions for lab members.</p>
          </div>
          <div class="console-section">
            <h3>User Permissions</h3>
            <p>Grant or revoke per-app access. Assign app-specific admin roles separate from site admin.</p>
          </div>
          <div class="console-section">
            <h3>Integrations</h3>
            <p>Configure Google Calendar, email notifications, Slack webhooks, and other third-party connections.</p>
          </div>
          <div class="console-section">
            <h3>Usage &amp; Logs</h3>
            <p>Monitor app usage, view audit logs, and track activity across all lab apps.</p>
          </div>
        </div>
        <div class="app-empty">
          <span class="app-badge app-badge--soon">Under Development</span>
          <p>Admin Console is being built. Logged in as <strong>${user.displayName || user.email}</strong>.</p>
        </div>
      </div>`;
    wire();
  }

  function wire() {
    // Future: app toggles, permission management, integration config, etc.
  }
})();
