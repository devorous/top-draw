# Release Checklist

Quick reference for releasing a new version of Top Draw.

## 🚀 Release Process

### Pre-Release
- [ ] Review recent commits and changelog
- [ ] Decide version bump type: patch, minor, or major
- [ ] Create a git branch (optional, but recommended)

### Bump Version
```bash
npm run release:patch    # for bug fixes (1.0.0 → 1.0.1)
npm run release:minor    # for new features (1.0.0 → 1.1.0)
npm run release:major    # for breaking changes (1.0.0 → 2.0.0)
```

**What it does:**
- ✅ Updates `package.json`
- ✅ Updates `src-tauri/Cargo.toml`
- ✅ Updates `public/version.json`
- ✅ Logs the new version to console

### Update Release Notes (Optional)
Edit `public/version.json`:
```json
{
  "latest": "1.0.1",
  "minRequired": "1.0.1",
  "releaseDate": "2026-04-12",
  "notes": "Bug fixes and performance improvements",
  "downloadUrl": "https://github.com/..."
}
```

### Build
```bash
npm run build              # Standard web build
npm run tauri:build        # Desktop app build
```

### Verify Version Was Injected
Check that HTML has version:
```bash
grep "APP_VERSION" dist/*.html
# Should output: <script>window.APP_VERSION = '1.0.1';</script>
```

### Test Version Check
1. Start dev server: `npm run dev`
2. Open browser console
3. Verify no errors in version check logs
4. To test warning: `window.APP_VERSION = '0.1.0'; location.reload()`

### Commit & Push
```bash
git add -A
git commit -m "chore: release v1.0.1"
git push origin main
```

### Deploy
1. Upload web build (`dist/`) to your server
2. Upload desktop build to GitHub Releases (or your host)
3. Update `downloadUrl` in `public/version.json` if URL changed
4. Push updated version.json

### Verify Server Endpoint
```bash
curl https://your-domain.com/api/version
# Should return:
# {
#   "latest": "1.0.1",
#   "minRequired": "1.0.1",
#   "releaseDate": "...",
#   "notes": "...",
#   "downloadUrl": "..."
# }
```

## 📋 One-Liner Release (for experienced releases)

```bash
npm run release:patch && npm run build && git add -A && git commit -m "chore: release" && git push
```

## 🚨 If You Make a Mistake

### Undo Last Version Bump
```bash
git reset --soft HEAD~1
git checkout -- package.json src-tauri/Cargo.toml public/version.json
```

### Set Exact Version
```bash
npm run release:set -- 1.2.3
```

## ⚠️ Important Notes

- **Always commit version changes** — ensures all machines have same version
- **Update `downloadUrl`** — point to the actual release URL
- **Test `/api/version`** — verify endpoint returns correct JSON
- **Clear browser cache** — after deploying, clients might have old version cached

## 🎯 Common Release Types

```bash
# Bug fix release
npm run release:patch    # 1.0.0 → 1.0.1

# New features (backwards compatible)
npm run release:minor    # 1.0.0 → 1.1.0

# Breaking changes / major features
npm run release:major    # 1.0.0 → 2.0.0

# Pre-release (test version)
npm run release:beta     # 1.0.0 → 1.0.0-beta

# Promote beta to stable
npm run release:promote  # 1.0.0-beta → 1.0.0
```

## 📊 Version Comparison Reference

How versions are compared (auto-enforced):

| Client | Min Required | Result |
|--------|-------------|--------|
| 1.0.0 | 1.0.1 | ❌ Outdated (warning) |
| 1.0.1 | 1.0.1 | ✅ OK |
| 1.0.2 | 1.0.1 | ✅ OK |
| 1.0.0-beta | 1.0.0 | ❌ Outdated (beta < stable) |
| 1.0.0 | 1.0.0-beta | ✅ OK (stable > beta) |

## 🔗 Reference Files

- **Versioning docs:** `VERSIONING.md`
- **Setup guide:** `VERSIONING_SETUP.md`
- **Version script:** `scripts/release/versioning.mjs`
- **Client checker:** `src/VersionChecker.js`
- **Server endpoint:** `server/index.js` (search for `/api/version`)
- **Version file:** `public/version.json`
