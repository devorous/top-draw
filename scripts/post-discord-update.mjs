import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { postReleaseUpdateToDiscord } from '../server/discordBot.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const versionJsonPath = path.join(repoRoot, 'public', 'version.json');

async function main() {
  const versionInfo = JSON.parse(await fs.readFile(versionJsonPath, 'utf8'));
  const posted = await postReleaseUpdateToDiscord(versionInfo);
  if (!posted) process.exitCode = 1;
}

main().catch((error) => {
  console.error('[Discord] Release update failed:', error);
  process.exit(1);
});
