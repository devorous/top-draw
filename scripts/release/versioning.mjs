import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const packageJsonPath = path.join(repoRoot, 'package.json');
const cargoTomlPath = path.join(repoRoot, 'src-tauri', 'Cargo.toml');
const versionJsonPath = path.join(repoRoot, 'public', 'version.json');
const DEFAULT_DOWNLOAD_URL = 'https://www.ddraw.ca/download';

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function parseVersion(version) {
  const match = VERSION_RE.exec(version);
  if (!match) {
    throw new Error(`Unsupported semver value: ${version}`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null
  };
}

function formatVersion({ major, minor, patch, prerelease = null }) {
  const base = `${major}.${minor}.${patch}`;
  return prerelease ? `${base}-${prerelease}` : base;
}

function withStableBump(version, level) {
  const next = parseVersion(version);

  if (level === 'patch') {
    next.patch += 1;
  } else if (level === 'minor') {
    next.minor += 1;
    next.patch = 0;
  } else if (level === 'major') {
    next.major += 1;
    next.minor = 0;
    next.patch = 0;
  } else {
    throw new Error(`Unknown stable bump: ${level}`);
  }

  next.prerelease = null;
  return formatVersion(next);
}

function withPrereleaseBump(version, level) {
  const next = parseVersion(version);

  if (level === 'patch') {
    next.patch += 1;
  } else if (level === 'minor') {
    next.minor += 1;
    next.patch = 0;
  } else if (level === 'major') {
    next.major += 1;
    next.minor = 0;
    next.patch = 0;
  } else {
    throw new Error(`Unknown prerelease bump: ${level}`);
  }

  next.prerelease = 'beta';
  return formatVersion(next);
}

function withNextBeta(version) {
  const current = parseVersion(version);
  current.prerelease = 'beta';
  return formatVersion(current);
}

function promoteToStable(version) {
  const current = parseVersion(version);
  current.prerelease = null;
  return formatVersion(current);
}

function setVersionInPackageJson(nextVersion) {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  packageJson.version = nextVersion;
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function setVersionInCargoToml(nextVersion) {
  const cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
  const nextCargoToml = cargoToml.replace(
    /^version = ".*"$/m,
    `version = "${nextVersion}"`
  );

  fs.writeFileSync(cargoTomlPath, nextCargoToml);
}

function setVersionInVersionJson(nextVersion, { minRequired = nextVersion } = {}) {
  // Read existing version.json to preserve downloadUrl and notes
  let existing = {
    latest: nextVersion,
    minRequired: nextVersion,
    downloadUrl: DEFAULT_DOWNLOAD_URL,
    notes: ''
  };
  try {
    existing = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
  } catch (e) {
    // File doesn't exist or is invalid, use defaults
  }

  const versionJson = {
    latest: nextVersion,
    minRequired,
    releaseDate: new Date().toISOString().split('T')[0],
    notes: existing.notes || '',
    downloadUrl: existing.downloadUrl || DEFAULT_DOWNLOAD_URL
  };

  fs.writeFileSync(versionJsonPath, `${JSON.stringify(versionJson, null, 2)}\n`);
}

function getDefaultMinRequired(previousVersion, nextVersion, releaseKind) {
  if (releaseKind === 'patch') {
    return previousVersion;
  }

  return nextVersion;
}

function setVersion(nextVersion, { releaseKind = 'set' } = {}) {
  parseVersion(nextVersion);
  const minRequired = getDefaultMinRequired(rawVersion, nextVersion, releaseKind);
  setVersionInPackageJson(nextVersion);
  setVersionInCargoToml(nextVersion);
  setVersionInVersionJson(nextVersion, { minRequired });
  console.log(nextVersion);
}

const action = process.argv[2];
const rawVersion = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version;

if (!action) {
  throw new Error('Missing versioning action.');
}

if (action === 'set') {
  const explicitVersion = process.argv[3];
  if (!explicitVersion) {
    throw new Error('Usage: npm run release:set -- <version>');
  }
  setVersion(explicitVersion, { releaseKind: 'set' });
} else if (action === 'patch' || action === 'minor' || action === 'major') {
  setVersion(withStableBump(rawVersion, action), { releaseKind: action });
} else if (action === 'prepatch' || action === 'preminor' || action === 'premajor') {
  const releaseKind = action.replace('pre', '');
  setVersion(withPrereleaseBump(rawVersion, releaseKind), { releaseKind });
} else if (action === 'beta') {
  setVersion(withNextBeta(rawVersion), { releaseKind: 'beta' });
} else if (action === 'promote') {
  setVersion(promoteToStable(rawVersion), { releaseKind: 'promote' });
} else {
  throw new Error(`Unknown versioning action: ${action}`);
}
