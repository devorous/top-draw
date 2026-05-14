const DEFAULT_API_BASE_URL = 'https://top-draw.koyeb.app';

function getApiBaseUrl() {
  const raw = process.env.API_BASE_URL
    || process.env.VITE_API_BASE_URL
    || process.env.DDRAW_API_BASE_URL
    || DEFAULT_API_BASE_URL;

  try {
    return new URL(raw).toString().replace(/\/+$/, '');
  } catch {
    return DEFAULT_API_BASE_URL;
  }
}

function getPublicBaseUrl(req) {
  const raw = process.env.PUBLIC_APP_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || '';
  if (raw) {
    try {
      const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
      return url.toString().replace(/\/+$/, '');
    } catch {
      // Fall through to request headers.
    }
  }

  const host = req.headers?.host || 'www.ddraw.ca';
  const proto = req.headers?.['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`.replace(/\/+$/, '');
}

function redirectToGo(res, req, params) {
  const url = new URL('/go/', getPublicBaseUrl(req));
  url.searchParams.set('discordAuth', params.success ? 'success' : 'error');
  if (params.mode) url.searchParams.set('mode', params.mode);
  if (params.error) url.searchParams.set('error', params.error);
  return res.redirect(302, url.toString());
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const code = typeof req.query?.code === 'string' ? req.query.code : '';
  const state = typeof req.query?.state === 'string' ? req.query.state : '';
  if (!code || !state) {
    return redirectToGo(res, req, {
      success: false,
      error: 'Missing Discord authorization data',
    });
  }

  const callbackUrl = new URL('/api/auth/discord/callback', getApiBaseUrl());
  callbackUrl.searchParams.set('code', code);
  callbackUrl.searchParams.set('state', state);

  try {
    const upstream = await fetch(callbackUrl.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'User-Agent': 'ddraw-discord-callback-proxy',
      },
    });

    const location = upstream.headers.get('location');
    if (location) {
      return res.redirect(upstream.status >= 300 && upstream.status < 400 ? upstream.status : 302, location);
    }

    return redirectToGo(res, req, {
      success: false,
      error: upstream.ok ? 'Discord login did not return a redirect' : 'Discord login failed',
    });
  } catch (error) {
    console.error('[DiscordCallback] Proxy error:', error);
    return redirectToGo(res, req, {
      success: false,
      error: 'Discord login failed',
    });
  }
}
