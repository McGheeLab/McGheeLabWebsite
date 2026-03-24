# Integrating Your App into the McGheeLab Site

This guide covers every step to take your finished app from this standalone dev environment into the live McGheeLab website.

## Prerequisites

- Your app works in standalone mode (`python3 dev-server.py`)
- You've tested at mobile widths (375px)
- All CSS classes are prefixed (no collisions with `app-base.css`)
- Firestore security rules are written for any new collections

---

## Step 1: Choose an App ID

Pick a short, lowercase slug. This becomes:
- The directory name: `apps/{id}/`
- The URL route: `#/apps/{id}`
- The registry key in `lab-apps.js`

Examples: `inventory`, `equipment`, `meetings`, `console`

---

## Step 2: Copy Files to Main Repo

From the main McGheeLab repo root:

```bash
# Create the app directory
mkdir -p apps/{id}

# Copy your three app files (NOT shared/, NOT firebase-config.js)
cp /path/to/your/dev/index.html  apps/{id}/index.html
cp /path/to/your/dev/app.js      apps/{id}/app.js
cp /path/to/your/dev/styles.css  apps/{id}/styles.css
```

**Do NOT copy:**
- `shared/` — already exists at `apps/shared/` in the main repo
- `firebase-config.js` — already exists at repo root
- `dev-server.py` — development only
- `.vscode/` — development only
- `CLAUDE.md` / `INTEGRATION.md` — development only

---

## Step 3: Fix Import Paths

Your dev environment uses flat paths. The main repo uses nested paths. Update your `index.html`:

```html
<!-- DEV paths (what you have now) -->
<link rel="stylesheet" href="shared/app-base.css" />
<script defer src="firebase-config.js"></script>
<script defer src="shared/auth-bridge.js"></script>

<!-- PRODUCTION paths (what they need to be) -->
<link rel="stylesheet" href="../shared/app-base.css" />
<script defer src="../../firebase-config.js"></script>
<script defer src="../shared/auth-bridge.js"></script>
```

Also update the "Back" link in the header:

```html
<!-- DEV -->
<a href="../../#/apps" class="app-header-back">

<!-- PRODUCTION (same — this one already works) -->
<a href="../../#/apps" class="app-header-back">
```

---

## Step 4: Register in lab-apps.js

Open `lab-apps.js` in the main repo and add your app to the `LAB_APPS` array:

```javascript
{
  id: 'your-id',
  name: 'Your App Name',
  description: 'One-line description of what it does.',
  path: 'apps/your-id/index.html',
  icon: `<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <!-- Your SVG icon paths here -->
  </svg>`,
  status: 'active',          // 'active' or 'coming-soon'
  adminOnly: false            // true if only admins should see this app
}
```

Set `status: 'active'` so the card shows "Active" instead of "Coming Soon".

---

## Step 5: Add Firestore Security Rules

If your app uses new Firestore collections, add rules to `firestore.rules` in the main repo:

```
// {App Name} — {brief description}
match /{collection}/{docId} {
  allow read: if request.auth != null;
  allow create: if request.auth != null;
  allow update: if request.auth != null
                && (request.auth.uid == resource.data.createdBy || isAdmin());
  allow delete: if isAdmin();
}
```

Common patterns:

**Members read/write, admin manages:**
```
match /myAppItems/{itemId} {
  allow read: if request.auth != null;
  allow create: if request.auth != null;
  allow update: if request.auth != null
                && (request.auth.uid == resource.data.createdBy || isAdmin());
  allow delete: if request.auth != null
                && (request.auth.uid == resource.data.createdBy || isAdmin());
}
```

**Admin-only collection:**
```
match /myAppConfig/{configId} {
  allow read: if request.auth != null;
  allow write: if isAdmin();
}
```

Deploy updated rules:
```bash
firebase deploy --only firestore:rules
```

---

## Step 6: Test Embedded Mode

1. Start the main site locally: `python3 -m http.server 8000` from the repo root
2. Log in with a test account
3. Navigate to `#/apps` — your app card should appear
4. Click it — your app should load in the iframe at `#/apps/{id}`
5. Verify:
   - Auth bridge fires (you see your username, not "Sign in required")
   - Layout fits within the iframe (no double scrollbars)
   - Mobile layout works

---

## Step 7: Update Documentation

In the main repo, update:

1. **`CodeLog/Updates/CHANGELOG.md`** — Add entry under current version
2. **`CodeLog/Architecture/ARCHITECTURE.md`** — Add your app under the `apps/` section
3. **`CodeLog/ClaudesPlan/`** — If this was a planned feature, update the plan doc

---

## Troubleshooting

### "Sign in required" in embedded mode
- The parent site must send auth within 5 seconds
- Check browser console for `[AppBridge]` messages
- Ensure `iframe sandbox` includes `allow-same-origin allow-scripts`

### Styles look wrong embedded
- Your app gets `body.app-embedded` class automatically
- Check that your styles don't assume standalone padding/margins
- Use `body.app-embedded .my-class { ... }` overrides if needed

### Firestore permission denied
- Check `firestore.rules` — your new collection may not have rules yet
- Auth must be established before Firestore calls — always use `AppBridge.onReady`
- In embedded mode, the bridge passes profile data but does NOT sign into Firebase
  with a token (no Cloud Functions). Direct Firestore calls require standalone mode
  or adding Cloud Functions for custom token generation.

### iframe doesn't resize
- Call `notifyResize()` after every render that changes height
- Or set up a ResizeObserver:
  ```javascript
  new ResizeObserver(() => notifyResize()).observe(document.body);
  ```
