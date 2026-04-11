import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const packageJsonPath = path.join(repoRoot, 'package.json');
const cargoTomlPath = path.join(repoRoot, 'src-tauri', 'Cargo.toml');

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

  next.prerelease = 'beta.0';
  return formatVersion(next);
}

function withNextBeta(version) {
  const current = parseVersion(version);
  if (!current.prerelease) {
    current.prerelease = 'beta.0';
    return formatVersion(current);
  }

  if (current.prerelease === 'beta') {
    current.prerelease = 'beta.0';
    return formatVersion(current);
  }

  const betaMatch = /^beta(?:\.(\d+))?$/.exec(current.prerelease);
  if (!betaMatch) {
    current.prerelease = 'beta.0';
    return formatVersion(current);
  }

  const currentIndex = betaMatch[1] ? Number(betaMatch[1]) : 0;
  current.prerelease = `beta.${currentIndex + 1}`;
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

function setVersion(nextVersion) {
  parseVersion(nextVersion);
  setVersionInPackageJson(nextVersion);
  setVersionInCargoToml(nextVersion);
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
  setVersion(explicitVersion);
} else if (action === 'patch' || action === 'minor' || action === 'major') {
  setVersion(withStableBump(rawVersion, action));
} else if (action === 'prepatch' || action === 'preminor' || action === 'premajor') {
  setVersion(withPrereleaseBump(rawVersion, action.replace('pre', '')));
} else if (action === 'beta') {
  setVersion(withNextBeta(rawVersion));
} else if (action === 'promote') {
  setVersion(promoteToStable(rawVersion));
} else {
  throw new Error(`Unknown versioning action: ${action}`);
}
