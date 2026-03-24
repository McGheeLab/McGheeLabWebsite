/* ================================================================
   Equipment Scheduler — McGheeLab Lab App
   Book microscopes, printers, and shared equipment.
   Google Calendar integration for real-time availability.
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
        <h2>Equipment Scheduler</h2>
        <p style="color: var(--muted);">
          Book microscopes, printers, and shared equipment. Syncs with Google Calendar for real-time availability.
        </p>
        <div class="equip-features">
          <div class="equip-feature">
            <h3>Calendar View</h3>
            <p>See equipment availability at a glance with weekly and monthly calendar views.</p>
          </div>
          <div class="equip-feature">
            <h3>Reservations</h3>
            <p>Book time slots for specific instruments. Recurring reservations supported.</p>
          </div>
          <div class="equip-feature">
            <h3>Google Calendar Sync</h3>
            <p>Two-way sync with Google Calendar so bookings appear in your personal calendar.</p>
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
    // Future: Google Calendar API integration, booking UI, etc.
  }
})();
