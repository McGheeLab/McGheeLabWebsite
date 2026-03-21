# Firebase Setup Guide for McGheeLab User System

Step-by-step instructions to configure Firebase for the user system (authentication, story editor, profiles, admin panel).

---

## Prerequisites

- A Google account (your University of Arizona Google account works)
- The McGheeLab website files with the V2.0 user system code
- A browser (Chrome recommended for Firebase Console)

---

## 1. Create a Firebase Project (or use existing)

If you already have a Firebase project for McGheeLab (e.g., from the poster site), skip to **Step 2**.

1. Go to **https://console.firebase.google.com**
2. Click **"Create a project"** (or "Add project")
3. Enter project name: `mcgheelab` (or whatever you prefer)
4. **Google Analytics** — you can disable this (not needed for the user system). Toggle it off and click **Create project**
5. Wait for the project to be created, then click **Continue**

You should now be on the Firebase project dashboard.

---

## 2. Register a Web App

Firebase needs to know your site is a web app so it can give you the right credentials.

1. On the project dashboard, click the **web icon** `</>` (it's in the center of the page, or under "Add an app")
2. Enter app nickname: `McGheeLab Website`
3. **Do NOT check** "Also set up Firebase Hosting" (you're hosting on GoDaddy)
4. Click **Register app**
5. You'll see a code block with your Firebase config. It looks like this:

```javascript
const firebaseConfig = {
  apiKey: "AIzaSyAnkKivjCcjAS8_Lp-R2JSIG4wSDSJBFI0",
  authDomain: "mcgheelab-f56cc.firebaseapp.com",
  projectId: "mcgheelab-f56cc",
  storageBucket: "mcgheelab-f56cc.firebasestorage.app",
  messagingSenderId: "665438582202",
  appId: "1:665438582202:web:57416863d588bcdeff9983",
  measurementId: "G-D8LLB00X9V"
};
```

6. **Copy these values** — you'll paste them into `firebase-config.js` in Step 7
7. Click **Continue to console**

---

## 3. Enable Email/Password Authentication

This lets users log in with an email address and password.

1. In the left sidebar, expand **Security** and click **Authentication**
2. Click **Get started** (if this is your first time opening it)
3. Click the **Sign-in method** tab at the top
4. Click **Email/Password** in the providers list
5. Toggle the **first switch** to **Enable** (the one labeled "Email/Password")
6. Leave the second switch ("Email link / passwordless sign-in") **disabled**
7. Click **Save**

You should now see "Email/Password" listed as Enabled in the providers table.

> **Note:** Firebase may show a caution banner recommending "Sign in with Google." This is safe to ignore for now. Email/Password works fine for the invitation-based system. Google Sign-in can be added later as an enhancement if desired (all lab members have @arizona.edu Google accounts, which would simplify login).

---

## 4. Create the Firestore Database

Firestore is where user profiles, stories, and invitation tokens are stored.

1. In the left sidebar, click **Database and Storage - > Firestore**
2. Click **Create database**
3. Choose a location:
   - Select **nam5 (United States)** or the region closest to Tucson
   - **This cannot be changed later**, so pick carefully
4. Select **"Start in production mode"**
   - This locks everything down by default; you'll add your own rules next
5. Click **Create**
6. Wait for provisioning (takes ~30 seconds)

You should now see an empty Firestore database with a "Start collection" button.

---

## 5. Deploy Firestore Security Rules

The security rules control who can read/write what data. The rules file is already in your repo at `firestore.rules`.

1. In Firestore, click the **Rules** tab (top of the page)
2. **Delete** the existing default rules in the editor
3. Open `firestore.rules` from your repo and **copy the entire contents**
4. **Paste** into the Firebase Console rules editor
5. Click **Publish**

The rules should now show something starting with:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isAdmin() { ...
```

> **Important:** If you see "Your security rules are not secure" warnings, that's expected — the invitation collection allows public reads by design (so registration links work).

---

## 6. Create Firestore Indexes

Some queries in the user system need composite indexes. Firestore will auto-prompt you to create these when they're first needed, but you can create them now to avoid errors:

1. In Firestore, click the **Indexes** tab
2. Click **Create index** (under the **Manual** tab)
3. Create these indexes:

**Index 1 — Stories by user:**
| Field | Order |
|-------|-------|
| Collection: `stories` | |
| `authorUid` | Ascending |
| `updatedAt` | Descending |

**Index 2 — Published stories:**
| Field | Order |
|-------|-------|
| Collection: `stories` | |
| `status` | Ascending |
| `publishedAt` | Descending |

**Index 3 — Pending stories:**
| Field | Order |
|-------|-------|
| Collection: `stories` | |
| `status` | Ascending |
| `updatedAt` | Descending |

4. Click **Create** for each one. Indexes take 1–5 minutes to build.

> **Shortcut:** If you skip this step, Firestore will show an error in the browser console with a direct link to create the missing index. Just click that link.

---

## 7. Set Up Firebase Storage

Storage is where uploaded images (profile photos, story images) are saved.

1. In the left sidebar, click **Storage**
2. Click **Get started**
3. Select **"Start in production mode"**
4. Choose the same location as your Firestore database (it may auto-select)
5. Click **Done**

Now deploy the storage security rules:

1. Click the **Rules** tab in Storage
2. **Delete** the existing default rules
3. Open `storage.rules` from your repo and **copy the entire contents**
4. **Paste** into the Firebase Console rules editor
5. Click **Publish**

---

## 8. Update firebase-config.js with Your Credentials

Now paste the credentials you copied in Step 2 into your code.

1. Open `firebase-config.js` in your editor
2. Replace the placeholder values with your real Firebase config:

```javascript
const firebaseConfig = {
  apiKey: "AIzaSyAnkKivjCcjAS8_Lp-R2JSIG4wSDSJBFI0",
  authDomain: "mcgheelab-f56cc.firebaseapp.com",
  projectId: "mcgheelab-f56cc",
  storageBucket: "mcgheelab-f56cc.firebasestorage.app",
  messagingSenderId: "665438582202",
  appId: "1:665438582202:web:57416863d588bcdeff9983",
  measurementId: "G-D8LLB00X9V"
};
```

3. Save the file

> **Security note:** The API key in client-side Firebase config is NOT a secret. It's safe to commit to your repo. Access control is enforced by Firestore/Storage rules, not the API key. Anyone can see this key in your page source — that's normal and by design.

---

## 9. Bootstrap Your Admin Account

Since registration requires an invitation, and invitations can only be created by admins, you need to manually create the first admin account.

### Step 9a: Create the Auth User

1. In Firebase Console, go to **Authentication → Users** tab
2. Click **Add user**
3. Enter:
   - **Email:** your email (e.g., `mcghee@arizona.edu`)
   - **Password:** a strong password
4. Click **Add user**
5. You'll see the user appear in the table. **Copy the User UID** (the long string in the "User UID" column, e.g., `a1B2c3D4e5F6g7H8i9J0`)

### Step 9b: Create the Admin Profile in Firestore

1. Go to **Firestore Database → Data** tab
2. Click **"Start collection"**
3. Collection ID: `users`
4. Click **Next**
5. Document ID: **paste the User UID you just copied** (this must match exactly)
6. Add these fields (click **"Add field"** for each):

| Field name | Type | Value |
|-----------|------|-------|
| `name` | string | `Your Name` (e.g., `Alex McGhee`) |
| `email` | string | `your-email@arizona.edu` |
| `role` | string | `admin` |
| `category` | string | `postdoc` (or whatever fits) |
| `bio` | string | (your bio, or leave empty) |
| `createdAt` | timestamp | (click the calendar icon → select today) |

7. Click **Save**

> **Why manually?** This is a one-time bootstrap. After this, you can log into the site and use the Admin panel to invite everyone else — no more manual Firestore edits needed.

---

## 10. Test the Setup Locally

1. Start a local server:
```bash
cd /Users/alexmcghee/Documents/GitHub/mcgheelab.github.io
python3 -m http.server 8000
```

2. Open **http://localhost:8000** in your browser

3. Open the browser's **Developer Console** (Cmd+Option+J on Mac)
   - You should NOT see the "Firebase not configured" warning anymore
   - If you see Firebase errors, double-check your config values

4. Click **Login** in the nav
5. Enter the email and password you created in Step 9a
6. You should be redirected to the **Dashboard**
   - Your name and profile should appear
   - "My Stories" section should be visible

7. Click your name or go to **Admin** in the nav
   - You should see the Admin panel with Users, Invitations, and Pending Stories tabs
   - Your account should appear in the Users table with role "Admin"

---

## 11. Invite Your First Student

1. Go to **Admin → Invitations** tab
2. Fill in:
   - **Email:** student's email (optional — leave blank to allow any email)
   - **Role:** Contributor (stories need your approval) or Editor (auto-publish)
   - **Category:** Graduate, Undergraduate, etc.
   - **Expires:** 30 days
3. Click **Generate Link**
4. Click **Copy** to copy the invitation link
5. Send the link to the student (email, Slack, etc.)

The student opens the link, fills in their name and password, and they're registered. They can then edit their profile and create stories from their Dashboard.

---

## 12. Migrate Existing Content to Firestore

This copies your current research topics, projects, and team members from `content.json` into Firestore so everything lives in one place.

1. Make sure you're logged in on the site as admin
2. Open the browser console (Cmd+Option+J)
3. Run:
```javascript
McgheeLab.migrateContent()
```
4. Watch the console for progress:
```
Starting content migration...
  Research: Microscope Enabled 3D-Bioprinting
  Research: Microfluidic Systems
  Research: Traction Force Microscopy
  Project: Open Microfluidic Syringe Pump
  Project: Auto In-Vitro platform
  Team: Alia Starman (grad)
  Team: Gabriel Declerq (grad)
  ...
Migration complete! 18 documents created.
```

> **Run this only once.** Running it again will create duplicate entries.

---

## 13. Deploy to GoDaddy

Upload the new and modified files to your GoDaddy server via Cyberduck:

**New files to upload:**
- `firebase-config.js`
- `user-system.js`
- `user-styles.css`
- `migrate-content.js`

**Updated files to re-upload:**
- `index.html`
- `app.js`

**Do NOT upload** (these are dev/documentation only):
- `firestore.rules`
- `storage.rules`
- `CodeLog/`
- `CLAUDE.md`
- `Research/`
- `.git/`

After uploading, visit **https://mcgheelab.com** and test login.

---

## 14. Add Authorized Domains (Required for Production)

Firebase Auth blocks sign-in from domains it doesn't recognize. You need to whitelist your domain.

1. In Firebase Console, go to **Authentication → Settings**
2. Click the **Authorized domains** tab
3. Click **Add domain**
4. Add: `mcgheelab.com`
5. Also add: `www.mcgheelab.com`
6. `localhost` is already authorized by default (for local testing)

> **If you skip this step**, login will fail on the live site with an "auth/unauthorized-domain" error.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| **"Firebase not configured"** in console | Check that `firebase-config.js` has real values, not `YOUR_API_KEY` placeholders |
| **"auth/unauthorized-domain"** | Add your domain in Authentication → Settings → Authorized domains (Step 14) |
| **"Missing or insufficient permissions"** | Firestore rules not deployed, or the user's role doesn't have access. Check Step 5 |
| **"The query requires an index"** with a link | Click the link — Firebase will create the index automatically. Wait 1–2 minutes |
| **Login works but Dashboard is blank** | The user document in Firestore may not exist or the UID doesn't match. Check Step 9b |
| **Images fail to upload** | Storage rules not deployed (Step 7), or the bucket doesn't exist |
| **Invitation link doesn't work** | Check the token ID in the URL matches a document in the `invitations` collection |
| **"Cannot read property of undefined"** | Firebase SDK may not have loaded. Check that the CDN script tags are present and not blocked by an ad blocker |
| **Everything was working, now it's broken** | Open the browser console. Most Firebase errors include a descriptive error code (e.g., `auth/user-not-found`, `permission-denied`) |

---

## Firebase Console Quick Links

After setup, bookmark these pages for quick access:

- **Authentication users:** `https://console.firebase.google.com/project/YOUR_PROJECT_ID/authentication/users`
- **Firestore data:** `https://console.firebase.google.com/project/YOUR_PROJECT_ID/firestore`
- **Firestore rules:** `https://console.firebase.google.com/project/YOUR_PROJECT_ID/firestore/rules`
- **Storage files:** `https://console.firebase.google.com/project/YOUR_PROJECT_ID/storage`
- **Storage rules:** `https://console.firebase.google.com/project/YOUR_PROJECT_ID/storage/rules`

Replace `YOUR_PROJECT_ID` with your actual project ID (e.g., `mcgheelab-12345`).

---

## Understanding the Privilege System

| Role | What they can do |
|------|-----------------|
| **Admin** | Everything — manage users, change roles, generate invitations, approve/reject stories, edit any content |
| **Editor** | Edit own profile, create stories that publish immediately (no approval needed) |
| **Contributor** | Edit own profile, create stories that go to "Pending" status — admin must approve before they appear on the public site |

You set each user's role in the **Admin → Users** tab. New users default to whatever role was set on their invitation.

---

## Cost & Limits (Firebase Free Tier — "Spark Plan")

The free tier is more than enough for a research lab:

| Resource | Free Limit | Your Likely Usage |
|----------|-----------|-------------------|
| Auth users | Unlimited | ~20 lab members |
| Firestore reads | 50,000/day | ~500/day |
| Firestore writes | 20,000/day | ~50/day |
| Firestore storage | 1 GB | < 100 MB |
| Cloud Storage | 5 GB | ~1 GB (images) |
| Storage bandwidth | 1 GB/day | < 100 MB/day |

You will likely never exceed these limits. Firebase will email you if you approach them.
