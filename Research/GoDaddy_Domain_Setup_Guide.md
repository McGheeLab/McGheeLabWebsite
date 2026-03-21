# GoDaddy Domain & Hosting Setup Guide

How to add a new website to your GoDaddy cPanel hosting and deploy via Cyberduck FTP.

---

## 1. Add the Domain in cPanel

1. Log into **GoDaddy** → My Products → your hosting plan → **cPanel**
2. Go to **Domains** → **Create A New Domain**
3. Enter your new domain name (e.g., `newsite.com`)
4. Set the **Document Root** to `/public_html/newsite.com`
5. Save

> **Important:** The main domain (`mcgheelab.com`) uses a `.htaccess` rewrite because cPanel won't let you change its document root. Addon domains let you set the document root directly — always point them to `/public_html/domainname.com`.

## 2. Point DNS to GoDaddy Hosting

If the domain was purchased on GoDaddy, DNS is usually automatic. If not:

1. In your domain registrar's DNS settings, set:
   - **A Record:** `@` → `198.12.245.91` (your server IP)
   - **CNAME:** `www` → `newsite.com`
2. DNS can take up to 48 hours to propagate (usually ~30 minutes)

To find your server IP:
```bash
nslookup mcgheelab.com
```

## 3. Create an FTP Account

1. **cPanel → FTP Accounts** → Create FTP Account
2. Set **Login** to whatever you want (e.g., `admin`)
3. Set **Password**
4. **Critical:** Change the **Directory** field to `/public_html/newsite.com`
   - cPanel auto-fills this with a subdirectory based on the login name — **delete that extra part** before creating
5. Click Create

## 4. Configure Cyberduck

Create a `.duck` bookmark file (or configure in Cyberduck directly):

- **Server:** `mcgheelab.com` (NOT `ftp.mcgheelab.com` — that doesn't resolve)
- **Port:** 21
- **Protocol:** FTP-SSL (say yes when prompted to switch to encrypted)
- **Username:** The full FTP username (e.g., `admin@mcgheelab.com`)
- **Password:** Your FTP password
- **Path:** `/` (Cyberduck will land in the directory you set in step 3)

Example `.duck` file:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Hostname</key>
    <string>mcgheelab.com</string>
    <key>Port</key>
    <string>21</string>
    <key>Protocol</key>
    <string>ftp</string>
    <key>Username</key>
    <string>admin@mcgheelab.com</string>
    <key>Path</key>
    <string>/</string>
  </dict>
</plist>
```

## 5. Upload Site Files

1. Double-click the `.duck` file to open Cyberduck
2. Accept the FTP-SSL prompt
3. Upload your site files: `index.html`, CSS, JS, images, etc.
4. **Don't upload** dev files: `.git/`, `CodeLog/`, `CLAUDE.md`, `node_modules/`, etc.

## 6. Enable HTTPS

1. **cPanel → SSL/TLS Status** (or **AutoSSL**)
2. Run AutoSSL — GoDaddy provides free SSL via cPanel
3. In **cPanel → Domains**, toggle **Force HTTPS Redirect** to **On**

## 7. Verify

- Visit `https://newsite.com` — should load your site
- Visit `https://www.newsite.com` — should also work
- Check browser padlock icon for valid SSL

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| **403 Forbidden** | Files are in the wrong folder, or `index.html` is missing. Check document root in cPanel → Domains |
| **DNS lookup failed** | Use `mcgheelab.com` as FTP server, not `ftp.mcgheelab.com` |
| **FTP connects but empty** | FTP account directory is wrong. Delete and recreate with correct path |
| **Main domain can't change document root** | Use `.htaccess` rewrite in `/public_html/` (see below) |

### .htaccess Rewrite for Main Domain

The main domain's document root is locked to `/public_html/`. To serve files from a subfolder, add to `/public_html/.htaccess`:

```apache
RewriteEngine On
RewriteCond %{HTTP_HOST} ^(www\.)?mcgheelab\.com$ [NC]
RewriteCond %{REQUEST_URI} !^/mcgheelab\.com/
RewriteRule ^(.*)$ /mcgheelab.com/$1 [L]
```

### Current Server Info

- **Server IP:** 198.12.245.91
- **cPanel username:** vp0vrqedamkf
- **FTP server hostname:** mcgheelab.com (port 21)
- **Home directory:** `/home/vp0vrqedamkf/`
- **Web root:** `/public_html/`

### Current Site Structure

```
/public_html/
├── .htaccess              ← rewrites main domain to subfolder
├── mcgheelab.com/         ← McGheeLab website files
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   └── ...
└── autoinvitro.com/       ← Auto In-Vitro website files
    ├── index.html
    └── ...
```
