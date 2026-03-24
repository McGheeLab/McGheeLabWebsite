/* ================================================================
   Inventory Tracker — McGheeLab Lab App
   Track lab supplies, reagents, and equipment.
   ================================================================ */

(() => {
  const appEl = document.getElementById('app');

  document.addEventListener('DOMContentLoaded', () => {
    McgheeLab.AppBridge.init();
    McgheeLab.AppBridge.onReady((user, profile) => {
      render(user, profile);
    });
  });

  function render(user, profile) {
    appEl.innerHTML = `
      <div class="app-card">
        <h2>Inventory Tracker</h2>
        <p style="color: var(--muted);">
          Track lab supplies, reagents, and equipment. Log usage, set reorder alerts, and manage vendors.
        </p>
        <div class="inv-features">
          <div class="inv-feature">
            <h3>Supplies</h3>
            <p>Track consumables, reagents, and chemicals with expiration dates and reorder thresholds.</p>
          </div>
          <div class="inv-feature">
            <h3>Equipment</h3>
            <p>Catalog major equipment with maintenance schedules, manuals, and location tracking.</p>
          </div>
          <div class="inv-feature">
            <h3>Orders</h3>
            <p>Manage purchase requests, vendor contacts, and order history.</p>
          </div>
        </div>
        <div class="app-empty">
          <span class="app-badge app-badge--soon">Under Development</span>
          <p>This app is being built. Logged in as <strong>${user.displayName || user.email}</strong>.</p>
        </div>
      </div>`;
    wire();
  }

  function wire() {
    // Future: attach event listeners, load Firestore data, etc.
  }
})();
