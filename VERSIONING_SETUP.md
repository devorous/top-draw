# Versioning System Setup Summary

Your version management system is now ready to use! Here's what was implemented.

## ✅ What's Been Set Up

### 1. **Automatic Version Bumping**
   - Enhanced `scripts/release/versioning.mjs` to update:
     - `package.json`
     - `src-tauri/Cargo.toml`
     - `public/version.json`
   - All in one command: `npm run release:patch/minor/major`

### 2. **Version Distribution**
   - `public/version.json` — centrally managed version file
   - Server endpoint `/api/version` — clients fetch version requirements
   - Vite plugin — injects `window.APP_VERSION` at build time

### 3. **Client-Side Version Checking**
   - New module: `src/VersionChecker.js`
   - Automatically runs on app startup (in `src/main.js`)
   - Compares client version against server's minimum required version
   - Shows warning modal if outdated (allows offline drawing)

### 4. **Server Version Endpoint**
   - Added `/api/version` GET endpoint in `server/index.js`
   - Returns JSON with:
     ```json
     {
       "latest": "1.0.0-beta",
       "minRequired": "1.0.0-beta",
       "releaseDate": "2026-04-12",
       "notes": "Release notes here",
       "downloadUrl": "https://github.com/..."
     }
     ```

## 🚀 Your Release Workflow

### Step 1: Bump Version
```bash
npm run release:patch   # or minor/major
```
This updates all three files automatically.

### Step 2: Update Download URL (if needed)
Edit `public/version.json` and update the `downloadUrl` field to point to your latest release.

### Step 3: Build & Deploy
```bash
npm run build
# Your custom build/deploy process
```

### Step 4: Commit Version Changes
```bash
git add -A
git commit -m "chore: release v1.0.1"
git push
```

## 📋 Key Features

### ✨ Outdated Client Detection
- Clients with versions older than `minRequired` see a warning modal
- Modal shows: current version, latest available, minimum required
- "Download Latest" button links to `downloadUrl`
- "Continue Offline" button allows offline drawing without connection

### 🎯 No GitHub Actions Required
- Versioning is manual and local (just run `npm run release:*`)
- You control when versions are bumped
- You build and upload your own binaries
- Easy to integrate with manual release process

### 📱 Works Across Platforms
- Web clients check version on load
- Tauri desktop app has version from `Cargo.toml`
- Offline mode still works (with warning)

### 🔄 Supports Prerelease Versions
```bash
npm run release:beta       # 1.0.0-beta
npm run release:prepatch   # 1.0.1-beta
npm run release:promote    # Remove -beta suffix
```

## 📝 Customization

### Custom Release Notes
Edit `public/version.json`:
```json
{
  "latest": "1.0.1",
  "minRequired": "1.0.1",
  "notes": "Critical security update - all users must upgrade",
  "downloadUrl": "https://..."
}
```

### Grace Period for Old Clients
Allow older clients to connect temporarily by setting `minRequired` lower:
```json
{
  "latest": "1.0.5",
  "minRequired": "1.0.3",
  "notes": "Latest version. 1.0.3+ can connect."
}
```

### Update Download URL
The versioning script preserves the existing `downloadUrl` when bumping versions, so:
1. Edit `public/version.json` to update the URL
2. Next `npm run release:*` preserves your new URL

## 📁 Files Modified/Created

**New Files:**
- `src/VersionChecker.js` — Version checking logic
- `public/version.json` — Version tracking file
- `VERSIONING.md` — Complete documentation

**Modified Files:**
- `scripts/release/versioning.mjs` — Now updates version.json
- `vite.config.js` — Added version injection plugin
- `src/main.js` — Calls version checker on startup
- `server/index.js` — Added `/api/version` endpoint

## 🧪 Testing

### Test in Development
```bash
npm run dev
# App loads with current version
# Version check runs automatically
# Check browser console for logs
```

### Manually Trigger Outdated Warning
In browser console:
```javascript
window.APP_VERSION = '0.1.0';
window.location.reload();
```

## ❓ Need Help?

See `VERSIONING.md` for:
- Detailed architecture
- Version comparison logic
- Troubleshooting
- FAQ
- Advanced customization

## 🎯 What's Next?

1. **Update your GitHub release URL** in `public/version.json`
2. **Test a release:** Run `npm run release:patch` to see it work
3. **Build and verify:** Run `npm run build` and check `dist/*.html` for `window.APP_VERSION = '1.0.1'`
4. **Deploy:** Push to your server and test `/api/version` endpoint

That's it! You now have a zero-friction versioning system that doesn't require GitHub Actions.
