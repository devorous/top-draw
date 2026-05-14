import { isTauriDesktop } from '../platform/desktop.js';

const PRODUCTION_API_BASE_URL = 'https://top-draw.koyeb.app';

function trimTrailingSlash(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isLocalUrl(value) {
  try {
    return isLocalHost(new URL(value, window.location.href).hostname);
  } catch {
    return false;
  }
}

function isPackagedDesktopOrigin() {
  const protocol = window.location.protocol;
  return protocol === 'tauri:' || protocol === 'file:' || protocol === 'asset:';
}

function resolveApiBaseFromWebSocketUrl({ allowLocal = true } = {}) {
  const wsServerUrl = String(import.meta.env.VITE_WS_SERVER_URL || '').trim();
  if (!wsServerUrl) return '';

  try {
    const parsed = new URL(wsServerUrl, window.location.href);
    if (!allowLocal && isLocalHost(parsed.hostname)) return '';
    parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return trimTrailingSlash(parsed.toString());
  } catch (error) {
    console.warn('[ServerEndpoints] Failed to parse VITE_WS_SERVER_URL:', error);
    return '';
  }
}

export function resolveApiBaseUrl() {
  const packagedDesktop = isPackagedDesktopOrigin();
  const configuredApiBase = trimTrailingSlash(import.meta.env.VITE_API_BASE_URL);
  if (configuredApiBase && (!packagedDesktop || !isLocalUrl(configuredApiBase))) {
    return configuredApiBase;
  }

  const fromWs = resolveApiBaseFromWebSocketUrl({ allowLocal: !packagedDesktop });
  if (fromWs) return fromWs;

  const hostname = window.location.hostname;
  if (isTauriDesktop() || packagedDesktop || (!isLocalHost(hostname) && hostname.endsWith('ddraw.ca'))) {
    return PRODUCTION_API_BASE_URL;
  }

  return '';
}

export function resolveApiUrl(path) {
  const apiBase = resolveApiBaseUrl();
  const normalizedPath = String(path || '').startsWith('/') ? path : `/${path}`;
  return `${apiBase}${normalizedPath}`;
}

export function hasExplicitServerEndpoint() {
  return !!trimTrailingSlash(import.meta.env.VITE_API_BASE_URL) ||
    !!String(import.meta.env.VITE_WS_SERVER_URL || '').trim();
}
