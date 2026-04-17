# Desktop Versioning And Updates

## Goals

- Start the desktop app at `1.0.0-beta`.
- Keep one source of truth for the release version.
- Support predictable `patch`, `minor`, and `major` bumps.
- Ship signed Tauri updater artifacts from local builds instead of hand-uploading installers.
- Let release builds auto-check for updates when the app starts.

## Source Of Truth

`package.json` is the canonical version file for the desktop app.

- The frontend already reads its release metadata from `package.json`.
- `src-tauri/tauri.conf.json` now points its `version` field at `../package.json`, so the Tauri bundle version stays in sync automatically.
- `src-tauri/Cargo.toml` is still updated as part of the release script so Rust package metadata does not drift.

## Versioning Workflow

Use the npm scripts below from the repo root.

- `npm run release:set -- 1.0.0-beta`
- `npm run release:patch`
- `npm run release:minor`
- `npm run release:major`
- `npm run release:prepatch`
- `npm run release:preminor`
- `npm run release:premajor`
- `npm run release:beta`
- `npm run release:promote`

### Practical Rules

- Use `release:beta` while iterating on the same beta line.
- Use `release:prepatch`, `release:preminor`, or `release:premajor` when you want the next semantic bump to stay in beta form.
- Use `release:patch`, `release:minor`, or `release:major` for stable releases after launch.
- Use `release:promote` when you are ready to drop the prerelease suffix, for example `1.0.0-beta.3` to `1.0.0`.

### Example Timeline

1. `1.0.0-beta`
2. `1.0.0-beta.1`
3. `1.0.0-beta.2`
4. `1.0.0`
5. `1.0.1`
6. `1.1.0`
7. `2.0.0`

## Updater Architecture

The app is set up to use Tauri's v2 updater flow.

- `bundle.createUpdaterArtifacts` is enabled so release builds generate updater-friendly assets.
- The desktop capability includes `updater:default` and `process:default`, which allows the frontend to check, install, and relaunch.
- The frontend schedules a startup check through `src/platform/updater.js`.
- The Rust side enables the updater plugin only when build-time updater values are present.

That last point is intentional: local dev builds should not pretend updates are configured. Release builds embed the updater endpoint and public key during the local updater build flow.

## Local Release Flow

The intended flow is:

1. Bump the version locally.
2. Run `npm run tauri:update`.
3. The script runs `tauri build` with updater signing enabled.
4. It copies the generated NSIS installer and signature into `public/desktop-updates/windows-x86_64/`.
5. It generates `public/desktop-updates/latest.json`.
6. If R2 is configured, it uploads the installer, signature, and manifest automatically.
7. Installed desktop clients poll that static JSON and can download the new signed installer.

Generate the signing keypair once with the Tauri CLI, keep the private key in GitHub secrets, and keep the public key as both:

- an environment variable or local key file for build embedding
- a copy in your own secure records in case you need to rebuild the pipeline later

## Local Key Files

The updater keypair has been generated locally for this repo at:

- Private key: `C:\Users\Kyle\.tauri\top-draw.key`
- Public key: `C:\Users\Kyle\.tauri\top-draw.key.pub`

The public key file contains the string that should be copied into the `TAURI_UPDATER_PUBLIC_KEY` GitHub secret.

The private key file contents should be copied into `TAURI_SIGNING_PRIVATE_KEY`.

## Important Security Note

The current key was generated without a password, which is acceptable for local setup but weaker than a password-protected private key.

That means:

- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` can be left empty for the current key.
- You should treat `C:\Users\Kyle\.tauri\top-draw.key` like a production secret.
- If you want stronger protection before the first real public release, regenerate the key with a password and update the GitHub secrets before shipping.

To rotate to a password-protected key later:

```powershell
npm run tauri signer generate -- -w "$env:USERPROFILE\.tauri\top-draw.key" -p "your-strong-password" --force --ci
```

If you rotate the key after users have already installed a signed build, existing installs will not trust updates signed by the new key. Rotate before your first public update channel goes live.

## Endpoint Strategy

The local build flow embeds this updater endpoint into release builds by default:

`https://www.ddraw.ca/desktop-updates/latest.json`

That keeps everything on your own domain. The updater script writes a static manifest with the latest version, release notes, installer URL, and embedded signature.

If you ever want a different host, set `TAURI_UPDATE_BASE_URL` before running the updater build.

By default the upload script uses:

- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`

It publishes under the `desktop-updates/` prefix. You can override that with `TAURI_UPDATE_PREFIX`.

## Website Download Link

The website download page uses a separate Vercel redirect:

- `ddraw.ca/download`
- implemented by `api/download.js`

That route calls the GitHub Releases API, finds the newest non-draft Windows `.exe` asset, and redirects the browser straight to GitHub's hosted installer file.

This means:

- you do not need to upload the `.exe` to Vercel
- the file still downloads from GitHub Releases
- `ddraw.ca/download` stays stable even though the installer filename changes with each version

If no Windows installer is available yet, the route falls back to the GitHub Releases page.

## Required Environment

The code scaffolding is in place, but real auto-updates still depend on:

- generating the Tauri signing keypair
- `TAURI_SIGNING_PRIVATE_KEY` being available when you build
- `TAURI_UPDATER_PUBLIC_KEY` being available, or `C:\Users\Kyle\.tauri\top-draw.key.pub` existing locally

Optional variables:

- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `TAURI_UPDATE_BASE_URL`
- `TAURI_UPDATER_ENDPOINT`

## Recommended First Release

For the first public desktop release, use:

1. `npm run release:set -- 1.0.0-beta`
2. `npm run tauri:update`
3. Deploy the updated site so `desktop-updates/latest.json` is live
4. Install that build on one test machine
5. Repeat with `npm run release:beta` and `npm run tauri:update`
6. Verify the updater installs the new build cleanly
