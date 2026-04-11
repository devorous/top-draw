# Desktop Versioning And Updates

## Goals

- Start the desktop app at `1.0.0-beta`.
- Keep one source of truth for the release version.
- Support predictable `patch`, `minor`, and `major` bumps.
- Ship signed Tauri updater artifacts from CI instead of hand-uploading installers.
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

That last point is intentional: local dev builds should not pretend updates are configured. Release builds embed the updater endpoint and public key during CI.

## CI Release Flow

The release workflow lives at `.github/workflows/tauri-release.yml`.

The intended flow is:

1. Bump the version locally.
2. Commit the release bump.
3. Tag the commit as `vX.Y.Z` or `vX.Y.Z-beta.N`.
4. Push the tag.
5. GitHub Actions builds the Windows Tauri bundle.
6. Tauri Action uploads the installer, signatures, and `latest.json` to the GitHub Release.
7. Installed desktop clients poll `latest.json` and can download the new signed installer.

This is more efficient than building the `.exe` by hand before each push because the binary is generated from the exact tagged source revision that users will install.

## Required GitHub Secrets

Set these in the repository before using the release workflow:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `TAURI_UPDATER_PUBLIC_KEY`

Generate the signing keypair once with the Tauri CLI, keep the private key in GitHub secrets, and keep the public key as both:

- a GitHub secret for CI embedding
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

## Adding The Secrets To GitHub

In GitHub, open the repository and go to:

`Settings -> Secrets and variables -> Actions`

Add these values:

- `TAURI_SIGNING_PRIVATE_KEY`: the full contents of `C:\Users\Kyle\.tauri\top-draw.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: leave blank for the current key, or set the password if you regenerate it with `-p`
- `TAURI_UPDATER_PUBLIC_KEY`: the full contents of `C:\Users\Kyle\.tauri\top-draw.key.pub`

## Endpoint Strategy

The workflow currently embeds this updater endpoint into release builds:

`https://github.com/<owner>/<repo>/releases/latest/download/latest.json`

That is the simplest production option because GitHub Releases hosts both the installer assets and the updater manifest together.

If you later want Vercel involved, use it as a mirror or redirect layer, not as the place where release binaries are manually managed.

## What Still Needs Real Credentials

The code scaffolding is in place, but real auto-updates still depend on:

- installing the upgraded npm and Cargo dependencies
- generating the Tauri signing keypair
- storing the three GitHub secrets
- running one tagged release build to publish the first signed `latest.json`

## Recommended First Release

For the first public desktop release, use:

1. `npm run release:set -- 1.0.0-beta`
2. Commit the version bump
3. Tag it as `v1.0.0-beta`
4. Push the tag
5. Install that build on one test machine
6. Repeat with `npm run release:beta`, tag `v1.0.0-beta.1`, and verify the updater installs it cleanly
