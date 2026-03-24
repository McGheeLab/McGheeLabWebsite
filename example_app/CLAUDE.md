# McGheeLab App Development — CLAUDE.md

> Claude Code reads this file automatically. It contains everything needed to build a standalone lab app that integrates with the McGheeLab website.

## What This Is

This is a **standalone lab app** for the McGheeLab website (mcgheelab.github.io). It runs two ways:

1. **Embedded** — loaded in an `<iframe>` inside the main site when a user navigates to `#/apps/{app-id}`
2. **Standalone** — opened directly at `apps/{app-id}/index.html` in a browser

Both modes share the same codebase. The auth bridge handles the difference automatically.

## Project Structure

```
example_app/
├── CLAUDE.md             # THIS FILE — full development context
├── INTEGRATION.md        # How to register this app on the main site
├── index.html            # Entry point (works standalone AND embedded)
├── app.js                # All app logic
├── styles.css            # App-specific styles
├── shared/               # Copied from main site — DO NOT MODIFY
│   ├── auth-bridge.js    # Auth handshake (postMessage + Firebase)
│   └── app-base.css      # Dark theme base styles & components
├── firebase-config.js    # Firebase project config (copied from main site)
├── dev-server.py         # Local dev server (python3 dev-server.py)
└── .vscode/
    ├── settings.json     # Workspace settings
    └── extensions.json   # Recommended extensions
```

## Conventions

- **Vanilla HTML/CSS/JS only** — No frameworks, no build step, no npm
- **Single IIFE in app.js** — All logic wrapped in `(() => { ... })()`
- **camelCase** for JS functions and variables
- **CSS class prefix** — Use a short prefix for your app (e.g., `inv-` for inventory, `equip-` for equipment) to avoid collisions with base styles
- **Mobile-first** — All layouts must be responsive; test at 375px width minimum
- **Dark theme** — Use CSS variables from `app-base.css` (see Design System below)

## Running Locally

```bash
python3 dev-server.py
# Opens http://localhost:8001
```

Or use VSCode Live Server extension (right-click `index.html` → "Open with Live Server").

**Note:** Firebase auth won't work locally unless you're already logged into the main site on the same browser (cookies are shared on localhost). For development, you can bypass auth temporarily — see "Development Tips" below.

## Architecture

### App Lifecycle

```
1. Browser loads index.html
2. Firebase SDK loads (deferred)
3. firebase-config.js initializes McgheeLab.firebase, .auth, .db, .storage
4. auth-bridge.js loads → McgheeLab.AppBridge available
5. app.js loads → DOMContentLoaded fires
6. app.js calls McgheeLab.AppBridge.init()
7. Auth resolves:
   - Embedded: parent sends postMessage with user/profile
   - Standalone: Firebase onAuthStateChanged fires
8. AppBridge.onReady(callback) fires with (user, profile)
9. App renders
```

### Auth Bridge API

```javascript
// Initialize (call once on DOMContentLoaded)
McgheeLab.AppBridge.init();

// Wait for authenticated user (MUST use this — don't render before auth)
McgheeLab.AppBridge.onReady((user, profile) => {
  // user:    { uid, email, displayName }
  // profile: { role, name, category, ... }
  renderApp(user, profile);
});

// Utilities (available after onReady fires)
McgheeLab.AppBridge.isEmbedded()  // true if running inside iframe
McgheeLab.AppBridge.getUser()     // { uid, email, displayName }
McgheeLab.AppBridge.getProfile()  // { role, name, category, ... }
McgheeLab.AppBridge.isAdmin()     // true if profile.role === 'admin'
```

### User Object (from auth)

```javascript
user = {
  uid: "abc123",              // Firebase Auth UID
  email: "jane@arizona.edu",  // Email address
  displayName: "Jane Doe"     // Display name (may be null)
}
```

### Profile Object (from Firestore `users` collection)

```javascript
profile = {
  role: "editor",             // "admin" | "editor" | "contributor" | "guest"
  name: "Jane Doe",           // Full name
  category: "grad",           // "pi" | "postdoc" | "grad" | "undergrad" | "highschool" | "alumni" | "guest"
  email: "jane@arizona.edu",
  bio: "...",
  photo: {
    thumb: "https://...",     // 300px thumbnail
    medium: "https://...",    // 800px
    full: "https://..."       // 1600px
  },
  joinDate: Timestamp,
  // ... other profile fields
}
```

### Role Permissions

| Role         | Description                    | Can Publish | Can Manage |
|-------------|--------------------------------|-------------|------------|
| `admin`     | Full access (PI level)         | Yes         | Yes        |
| `editor`    | Can publish content            | Yes         | No         |
| `contributor` | Can create drafts            | No          | No         |
| `guest`     | Read-only, no app access       | No          | No         |

**Important:** Guest users are blocked at the main site level — they never reach your app. You only need to handle `admin`, `editor`, and `contributor` roles.

### Category → Default Role Mapping

| Category     | Default Role  |
|-------------|---------------|
| `pi`        | `admin`       |
| `postdoc`   | `editor`      |
| `grad`      | `editor`      |
| `undergrad` | `contributor` |
| `highschool`| `contributor` |
| `alumni`    | `contributor` |
| `guest`     | `guest`       |

## Firebase / Firestore

### Access

Firebase is available globally after init:

```javascript
const db      = McgheeLab.db;       // Firestore instance
const auth    = McgheeLab.auth;     // Firebase Auth
const storage = McgheeLab.storage;  // Firebase Storage
```

### Firebase Project

- **Project ID:** `mcgheelab-f56cc`
- **Auth:** Email/Password enabled
- **Firestore:** Production mode with security rules
- **Storage:** For file uploads (images, documents)

### Existing Firestore Collections

These collections already exist on the main site. You can READ from them but be careful about WRITING — follow the security rules.

| Collection         | Purpose                                | Read Access    | Write Access            |
|-------------------|----------------------------------------|----------------|-------------------------|
| `users`           | User profiles (team page, auth)        | Public         | Own profile or admin    |
| `stories`         | Research stories/blog posts            | Published=public | Author or admin       |
| `newsPosts`       | News feed posts                        | Published=public | Author or admin       |
| `projectPackages` | Research project entries                | Published=public | Author or admin       |
| `invitations`     | Registration invite tokens             | Public         | Admin creates           |
| `research`        | Research topic definitions             | Public         | Admin only              |
| `teamProfiles`    | Legacy team profiles                   | Public         | Admin only              |
| `opportunities`   | Job/position listings                  | Public         | Admin only              |
| `comments`        | Comments on stories/posts              | Public         | Authenticated create    |
| `reactions`       | Likes/reactions                        | Public         | Own reactions only      |
| `cvData`          | CV builder data                        | Own or admin   | Own only                |
| `schedules`       | Schedule definitions                   | Public         | Owner or admin          |
| `participants`    | Schedule participants                  | Public         | Admin or own entry      |
| `classes`         | Course listings                        | Public         | Admin only              |
| `classFiles`      | Class material uploads                 | Public         | Auth create, admin edit |

### Creating New Collections for Your App

If your app needs its own data, create a new collection. Follow this pattern:

```javascript
// Example: inventory app creates an 'inventory' collection
const COLLECTION = 'inventory';

// Read items
async function getItems() {
  const snap = await McgheeLab.db.collection(COLLECTION)
    .orderBy('name', 'asc').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Create item
async function addItem(data) {
  const user = McgheeLab.AppBridge.getUser();
  return McgheeLab.db.collection(COLLECTION).add({
    ...data,
    createdBy: user.uid,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

// Update item
async function updateItem(id, data) {
  return McgheeLab.db.collection(COLLECTION).doc(id).update({
    ...data,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
}

// Delete item
async function deleteItem(id) {
  return McgheeLab.db.collection(COLLECTION).doc(id).delete();
}
```

**You MUST also add Firestore security rules** for any new collection. See `INTEGRATION.md` for the rule template.

### Firebase Storage

```javascript
// Upload a file
async function uploadFile(file, path) {
  const ref = McgheeLab.storage.ref().child(path);
  const snap = await ref.put(file);
  return snap.ref.getDownloadURL();
}

// Example: upload to apps/inventory/images/{uid}/{filename}
const url = await uploadFile(
  fileInput.files[0],
  `apps/inventory/images/${user.uid}/${file.name}`
);
```

## Design System

### CSS Variables (from app-base.css)

```css
--bg:       #0b0e14      /* Page background */
--surface:  #121620      /* Card/panel background */
--surface2: #1a1f2e      /* Nested/secondary surface */
--border:   rgba(255,255,255,.08)
--text:     #eef2f7      /* Primary text */
--muted:    #8a94a6      /* Secondary/hint text */
--accent:   #5baed1      /* Primary accent (links, buttons) */
--accent2:  #4a9dc0      /* Accent hover state */
--danger:   #e91e63      /* Errors, destructive actions */
--success:  #4caf50      /* Success states */
--warning:  #ffc107      /* Warnings, "coming soon" */
--radius:   8px          /* Standard border radius */
--radius-lg:12px         /* Large border radius (cards) */
```

### Available CSS Classes (from app-base.css)

**Layout:**
- `.app-card` — Surface card with border and padding
- `#app` — Main container (max-width 1000px standalone, full-width embedded)

**Buttons:**
- `.app-btn` — Base button
- `.app-btn--primary` — Accent-colored button
- `.app-btn--secondary` — Subtle bordered button
- `.app-btn--danger` — Red destructive button
- `:disabled` state handled automatically

**Forms:**
- `.app-input` — Text input, textarea, select
- `.app-label` — Uppercase label above inputs

**Status:**
- `.app-badge` — Inline badge
- `.app-badge--admin` — Red admin badge
- `.app-badge--active` — Green active badge
- `.app-badge--soon` — Yellow coming-soon badge

**State:**
- `.app-empty` — Centered empty-state message
- `.app-auth-wall` — Full-page auth required message (handled by bridge)

### HTML Template Pattern

```html
<div class="app-card">
  <h2>Section Title</h2>
  <p style="color: var(--muted);">Description text here.</p>

  <div style="margin: 1rem 0;">
    <label class="app-label">Field Name</label>
    <input class="app-input" type="text" placeholder="Enter value..." />
  </div>

  <div style="display: flex; gap: .5rem;">
    <button class="app-btn app-btn--primary">Save</button>
    <button class="app-btn app-btn--secondary">Cancel</button>
  </div>
</div>
```

## Development Tips

### Bypass Auth for Local Development

For rapid UI development without needing to log in, add this temporary block at the top of your `render()` function:

```javascript
// TODO: REMOVE BEFORE DEPLOYING
const DEV_MODE = window.location.hostname === 'localhost';
if (DEV_MODE && !user) {
  user = { uid: 'dev', email: 'dev@test.com', displayName: 'Dev User' };
  profile = { role: 'admin', name: 'Dev User', category: 'grad' };
}
```

### Communicate with Parent (when embedded)

```javascript
// Resize iframe to fit content (parent listens for this)
function notifyResize() {
  if (McgheeLab.AppBridge.isEmbedded()) {
    window.parent.postMessage({
      type: 'mcgheelab-app-resize',
      height: document.body.scrollHeight
    }, window.location.origin);
  }
}

// Call after any render that changes page height
notifyResize();

// Or observe changes automatically
new ResizeObserver(() => notifyResize()).observe(document.body);
```

### Loading States

```javascript
function showLoading() {
  appEl.innerHTML = '<div class="app-empty"><p>Loading&hellip;</p></div>';
}

function showError(msg) {
  appEl.innerHTML = `<div class="app-empty"><p style="color:var(--danger);">${msg}</p></div>`;
}
```

### Real-time Listeners (Firestore)

```javascript
// Listen for real-time updates instead of one-time reads
function listenToItems(callback) {
  return McgheeLab.db.collection('myApp')
    .orderBy('updatedAt', 'desc')
    .onSnapshot(snap => {
      const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(items);
    }, err => {
      console.error('Listener error:', err);
    });
}

// Usage — unsubscribe returns a function to stop listening
const unsubscribe = listenToItems(items => renderList(items));
// Later: unsubscribe();
```

## File-by-File Guide

### index.html
- **DO change:** `<title>`, `<h1>` text, app name
- **DON'T change:** Firebase SDK script tags, load order, `<main id="app">` structure

### app.js
- **Pattern:** IIFE wrapping all logic
- **Entry point:** `DOMContentLoaded` → `AppBridge.init()` → `onReady(render)`
- **Two main functions:** `render(user, profile)` for HTML, `wire()` for event listeners
- **Keep separate:** Don't inline event handlers in HTML; attach them in `wire()`

### styles.css
- **Prefix your classes** (e.g., `inv-table`, `equip-calendar`) to avoid collision with base styles
- **Use CSS variables** from `:root` — never hardcode colors
- **Responsive:** Add `@media (max-width: 600px)` rules for mobile

### shared/ (DO NOT MODIFY)
These files are copied from the main site. Any changes here will be overwritten when you integrate. If you need changes to the shared layer, make them in the main repo at `apps/shared/`.

### firebase-config.js (DO NOT MODIFY)
Contains the Firebase project credentials. Copied from the main site.

## Checklist Before Integration

- [ ] App renders correctly in standalone mode (open `index.html` directly)
- [ ] Auth works — `AppBridge.onReady` fires with real user data
- [ ] Admin-only features check `McgheeLab.AppBridge.isAdmin()`
- [ ] Mobile layout works at 375px width
- [ ] No hardcoded colors — all using CSS variables
- [ ] CSS classes are prefixed to avoid collisions
- [ ] New Firestore collections have security rules written
- [ ] No `console.log` left in production code (use `console.warn` for errors only)
- [ ] `dev-server.py` removed or excluded from deployment
- [ ] Tested embedded mode (via main site `#/apps/{id}`)
