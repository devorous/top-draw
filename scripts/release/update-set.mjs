import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function usage() {
  console.log('Usage: npm run update:set <version>');
  console.log('Example: npm run update:set 1.9.1-beta');
  console.log('If your npm version does not forward arguments, use: npm run update:set -- <version>');
}

function getNpmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runNpmScript(name, args = []) {
  return new Promise((resolve, reject) => {
    const command = getNpmCommand();
    const commandArgs = ['run', name];
    if (args.length > 0) {
      commandArgs.push('--', ...args);
    }

    console.log(`\n[Update] npm run ${name}${args.length ? ` -- ${args.join(' ')}` : ''}`);
    const child = spawn(command, commandArgs, {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: false
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`npm run ${name} exited with code ${code}`));
    });

    child.on('error', reject);
  });
}

async function main() {
  const version = process.argv[2];
  if (!version || version === '--help' || version === '-h') {
    usage();
    process.exit(version ? 0 : 1);
  }

  if (!VERSION_RE.test(version)) {
    throw new Error(`Invalid version "${version}". Expected something like 1.9.1 or 1.9.1-beta.`);
  }

  await runNpmScript('release:set', [version]);
  await runNpmScript('tauri:update');
  await runNpmScript('discord:update');
  console.log(`\n[Update] Finished release update for ${version}.`);
}

main().catch((error) => {
  console.error('[Update] Failed:', error.message || error);
  process.exit(1);
});
