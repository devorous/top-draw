# Versioning System

This document describes Top Draw's versioning system, which ensures outdated clients can't connect to the server while still allowing offline drawing with a warning.

## Overview

The system has three main components:

1. **Version Tracking** — Semantic versioning in `package.json`, `Cargo.toml`, and `public/version.json`
2. **Server Endpoint** — `/api/version` returns the latest and minimum required versions
3. **Client-Side Checking** — Detects outdated clients and shows a warning modal

## Quick Start

When you're ready to release a new version:

```bash
npm run release:patch   # 1.0.0 → 1.0.1 (bug fixes)
npm run release:minor   # 1.0.0 → 1.1.0 (new features)
npm run release:major   # 1.0.0 → 2.0.0 (breaking changes)
```

Or set an exact version:

```bash
npm run release:set -- 1.2.3
npm run release:set -- 2.0.0-beta
```

## What Gets Updated

Each versioning command automatically updates:

- ✅ `package.json` — Used by Node.js and as the source of truth
- ✅ `src-tauri/Cargo.toml` — Tauri desktop app version
- ✅ `public/version.json` — Served to clients for version checks
- ✅ `window.APP_VERSION` — Injected at build time by Vite

## How Client Version Checking Works

### 1. Client Fetches Version Info

When the app loads (`src/main.js`), it calls `initializeVersionCheck()` which:

```javascript
// Fetch /api/version from the server
const response = await fetch('/api/version');
const serverVersion = await response.json();
// {
//   "latest": "1.0.1",
//   "minRequired": "1.0.1",
//   "releaseDate": "2026-04-12",
//   "notes": "Bug fixes",
//   "downloadUrl": "https://github.com/..."
// }
```

### 2. Version Comparison

The client compares its own version (`window.APP_VERSION`) against the server's `minRequired`:

- ✅ If client version ≥ minRequired → continue normally
- ⚠️ If client version < minRequired → show warning modal

### 3. Warning Modal

When a client is outdated, a modal appears with:

- Client version
- Latest version available
- Minimum required version
- "Download Latest" button → opens your download URL
- "Continue Offline" button → allows offline drawing without connection

## Managing Version Requirements

### Setting a Grace Period

Patch releases keep a grace period automatically. By default:

- `npm run release:patch` updates `latest` but preserves the previous `minRequired`
- `npm run release:minor` and `npm run release:major` update both `latest` and `minRequired`

If you want to support older clients temporarily beyond that default:

Edit `public/version.json` manually to set different `minRequired`:

```json
{
  "latest": "1.0.5",
  "minRequired": "1.0.3",
  "releaseDate": "2026-04-12",
  "notes": "Latest version with backwards compat",
  "downloadUrl": "https://github.com/..."
}
```

Then clients on versions 1.0.3+ can connect, but 1.0.2 and below see the warning.

Example default behavior:

- `1.1.1` -> `npm run release:patch` -> `latest: 1.1.2`, `minRequired: 1.1.1`
- `1.1.1` -> `npm run release:minor` -> `latest: 1.2.0`, `minRequired: 1.2.0`
- `1.1.1` -> `npm run release:major` -> `latest: 2.0.0`, `minRequired: 2.0.0`

### Custom Release Notes

Add release notes to `public/version.json`:

```json
{
  "latest": "1.0.5",
  "minRequired": "1.0.5",
  "releaseDate": "2026-04-12",
  "notes": "Critical: Fixed canvas corruption bug. All users must upgrade.",
  "downloadUrl": "https://github.com/..."
}
```

Notes appear in the warning modal.

## Deployment Workflow

Your typical release process:

```bash
# 1. Bump version (updates package.json, Cargo.toml, version.json)
npm run release:patch

# 2. Commit version changes
git add -A
git commit -m "chore: bump to 1.0.1"

# 3. Build your app
npm run build                    # or your build command
npm run tauri:build             # for desktop release

# 4. Upload your binaries to GitHub Releases (or your server)
# (Manual or via script)

# 5. Update version.json with download link (if URL changed)
# Edit public/version.json and set downloadUrl

git add public/version.json
git commit -m "chore: update download URL for 1.0.1"
git push
```

## Version Injection at Build Time

Vite automatically injects `window.APP_VERSION` from `package.json` during the build. This happens in `vite.config.js`:

```javascript
// Every HTML file gets:
<script>window.APP_VERSION = '1.0.1';</script>
```

The client reads this in `VersionChecker.js`:

```javascript
const clientVersion = window.APP_VERSION;  // '1.0.1'
```

## Files Involved

| File | Purpose |
|------|---------|
| `package.json` | Source of truth for version |
| `src-tauri/Cargo.toml` | Tauri app version |
| `public/version.json` | Served to clients via `/api/version` |
| `src/VersionChecker.js` | Client-side version checking logic |
| `src/main.js` | Calls `initializeVersionCheck()` on load |
| `vite.config.js` | Injects `window.APP_VERSION` |
| `server/index.js` | `/api/version` endpoint |
| `scripts/release/versioning.mjs` | Automatic version bumping |

## Advanced: Customizing Download URL

The download link is managed in `public/version.json`. Each time you bump a version, the versioning script preserves the existing `downloadUrl` unless you manually change it.

To update the download URL for a release:

```bash
# 1. Edit public/version.json
# 2. Change downloadUrl to your new release URL
# 3. Commit and push

# Next time you bump, the new URL is preserved
npm run release:patch
```

## Testing Version Checking

### In Dev Mode

The version check works in dev (`npm run dev`):

1. Open the app in your browser
2. Your client has version from `package.json` injected
3. It fetches from `/api/version` (proxied to localhost:8000)
4. If outdated, modal appears

### Force Test Outdated Warning

Edit `window.APP_VERSION` in browser console:

```javascript
window.APP_VERSION = '0.1.0';
// Then reload the page
window.location.reload();
```

### Disable Version Check Temporarily

In `src/VersionChecker.js`, at the start of `initializeVersionCheck()`:

```javascript
export async function initializeVersionCheck() {
  // return; // Uncomment to disable for testing
  
  if (!navigator.onLine) { ... }
}
```

## Prerelease Versions

The system supports prerelease versions:

```bash
npm run release:beta       # 1.0.0 → 1.0.0-beta
npm run release:prepatch   # 1.0.0 → 1.0.1-beta
npm run release:preminor   # 1.0.0 → 1.1.0-beta
npm run release:premajor   # 1.0.0 → 2.0.0-beta
npm run release:promote    # 1.0.0-beta → 1.0.0
```

Version comparison handles prerelease correctly:
- `1.0.0-beta` < `1.0.0` (stable)
- `1.0.0-beta` < `1.0.1-beta`

## FAQ

**Q: What if my server is offline?**
A: The version check silently fails (`try/catch`). Clients can still draw offline.

**Q: Can I enforce an immediate update?**
A: Yes. Set `minRequired` to the current version in `public/version.json`. Only the latest version can connect (warning modal shows but no offline option).

**Q: Do patch releases force everyone to update?**
A: Not by default. `npm run release:patch` keeps the previous `minRequired` as a grace period. Minor and major releases move `minRequired` to the new version automatically.

**Q: Do I need GitHub Actions anymore?**
A: No. Versioning is manual (run `npm run release:*` locally). You build and upload binaries yourself, then update the version files.

**Q: How do I update multiple machines?**
A: Since version files are in the repo:
1. Bump version locally
2. Commit and push
3. All machines pulling the latest code have correct versions

**Q: What if I want different `minRequired` per platform?**
A: Currently, there's one `minRequired` for all platforms. If needed, you could extend `version.json` with platform-specific fields and have the client check accordingly.

## Troubleshooting

**Version not updating in built app?**
- Run `npm run build` (rebuilds with current `window.APP_VERSION`)
- Clear browser cache or hard-refresh (Ctrl+Shift+R)

**Version check not running?**
- Check browser console for errors
- Verify `/api/version` endpoint returns valid JSON
- Ensure `window.APP_VERSION` exists (check `<script>` tag in HTML)

**Client sees outdated warning but shouldn't?**
- Verify client's `window.APP_VERSION` matches package.json
- Check that `/api/version` is returning the correct `minRequired`
- Ensure version comparison logic handles prerelease versions correctly
