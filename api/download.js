const GITHUB_RELEASES_URL = 'https://api.github.com/repos/devorous/top-draw/releases?per_page=10';
const RELEASES_PAGE_URL = 'https://github.com/devorous/top-draw/releases';

function pickWindowsInstaller(releases) {
  for (const release of releases) {
    if (release?.draft) continue;

    const asset = release.assets?.find((candidate) =>
      typeof candidate?.browser_download_url === 'string'
      && /\.exe$/i.test(candidate.browser_download_url)
    );

    if (asset) {
      return asset.browser_download_url;
    }
  }

  return null;
}

export default async function handler(_request, response) {
  try {
    const githubResponse = await fetch(GITHUB_RELEASES_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ddraw-download-redirect'
      }
    });

    if (!githubResponse.ok) {
      return response.redirect(302, RELEASES_PAGE_URL);
    }

    const releases = await githubResponse.json();
    const downloadUrl = pickWindowsInstaller(Array.isArray(releases) ? releases : []);

    if (!downloadUrl) {
      return response.redirect(302, RELEASES_PAGE_URL);
    }

    response.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
    return response.redirect(302, downloadUrl);
  } catch {
    return response.redirect(302, RELEASES_PAGE_URL);
  }
}
