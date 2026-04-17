const DEFAULT_PUBLIC_BASE_URL = 'https://www.ddraw.ca';
const UPDATE_PREFIX = 'desktop-updates';

function normalizeBaseUrl(request) {
  const envBase = process.env.TAURI_UPDATE_BASE_URL?.trim()
    || process.env.TAURI_UPDATER_BASE_URL?.trim()
    || process.env.DESKTOP_UPDATES_PUBLIC_URL?.trim()
    || DEFAULT_PUBLIC_BASE_URL;

  try {
    return new URL(envBase).toString().replace(/\/+$/, '');
  } catch {
    const host = request?.headers?.host;
    const protocol = request?.headers?.['x-forwarded-proto'] || 'https';
    if (host) {
      return `${protocol}://${host}`.replace(/\/+$/, '');
    }
    return DEFAULT_PUBLIC_BASE_URL;
  }
}

export default async function handler(request, response) {
  const baseUrl = normalizeBaseUrl(request);
  const manifestUrl = `${baseUrl}/${UPDATE_PREFIX}/latest.json`;

  try {
    const manifestResponse = await fetch(manifestUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'ddraw-download-redirect'
      }
    });

    if (!manifestResponse.ok) {
      return response.redirect(302, manifestUrl);
    }

    const manifest = await manifestResponse.json();
    const downloadUrl = manifest?.platforms?.['windows-x86_64']?.url;
    if (typeof downloadUrl !== 'string' || !downloadUrl.trim()) {
      return response.redirect(302, manifestUrl);
    }

    response.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
    return response.redirect(302, downloadUrl);
  } catch {
    return response.redirect(302, manifestUrl);
  }
}
