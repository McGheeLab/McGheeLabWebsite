/* ================================================================
   Lab Meeting — McGheeLab Lab App
   Schedule presentations, manage agendas, share notes,
   and track action items from weekly lab meetings.
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
        <h2>Lab Meeting</h2>
        <p style="color: var(--muted);">
          Schedule presentations, manage agendas, share notes, and track action items from weekly lab meetings.
        </p>
        <div class="mtg-features">
          <div class="mtg-feature">
            <h3>Schedule</h3>
            <p>Rotating presentation schedule with sign-up. Never miss who's presenting next.</p>
          </div>
          <div class="mtg-feature">
            <h3>Agendas &amp; Notes</h3>
            <p>Collaborative agenda building. Meeting notes saved and searchable.</p>
          </div>
          <div class="mtg-feature">
            <h3>Action Items</h3>
            <p>Assign and track follow-up tasks. Automatic reminders before the next meeting.</p>
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
    // Future: agenda editor, presentation sign-up, notes, etc.
  }
})();
