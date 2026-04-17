import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const versionJsonPath = path.join(__dirname, '..', 'public', 'version.json');

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const raw = await readFile(versionJsonPath, 'utf8');
    const payload = JSON.parse(raw);
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json(payload);
  } catch (error) {
    console.error('[API] Version read error:', error);
    return res.status(500).json({ error: 'Failed to read version' });
  }
}
