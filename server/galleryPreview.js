import { ObjectId } from 'mongodb';

const DEFAULT_BASE_URL = 'https://www.ddraw.ca';
const FALLBACK_IMAGE = '/images/preview-fallback.png';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getPublicBaseUrl(req) {
  const configured = process.env.PUBLIC_SITE_URL || process.env.VITE_PUBLIC_SITE_URL || DEFAULT_BASE_URL;
  try {
    return new URL(configured).toString().replace(/\/+$/, '');
  } catch {
    const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
    const protocol = req?.headers?.['x-forwarded-proto'] || 'https';
    return host ? `${protocol}://${host}` : DEFAULT_BASE_URL;
  }
}

function absoluteUrl(url, baseUrl) {
  if (!url) return `${baseUrl}${FALLBACK_IMAGE}`;
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return `${baseUrl}${FALLBACK_IMAGE}`;
  }
}

function isNsfw(item) {
  return Array.isArray(item?.tags) && item.tags.includes('nsfw');
}

export function buildGalleryShareUrl(id, req) {
  return `${getPublicBaseUrl(req)}/gallery/${encodeURIComponent(id)}`;
}

export function renderGalleryPreviewHtml(item, req) {
  const baseUrl = getPublicBaseUrl(req);
  const id = item?._id?.toString?.() || '';
  const shareUrl = `${baseUrl}/gallery/${encodeURIComponent(id)}`;
  const titleText = item?.title?.trim()
    ? item.title.trim()
    : `Artwork by ${item?.author || 'DDraw'}`;
  const descriptionText = isNsfw(item)
    ? 'View this gallery image on DDraw.'
    : `Gallery image by ${item?.author || 'a DDraw artist'}.`;
  const imageUrl = absoluteUrl(isNsfw(item) ? null : (item?.thumbUrl || item?.url), baseUrl);
  const escapedTitle = escapeHtml(`${titleText} - DDraw Gallery`);
  const escapedDescription = escapeHtml(descriptionText);
  const escapedImage = escapeHtml(imageUrl);
  const escapedShareUrl = escapeHtml(shareUrl);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapedTitle}</title>
    <meta name="description" content="${escapedDescription}">
    <meta property="og:type" content="article">
    <meta property="og:url" content="${escapedShareUrl}">
    <meta property="og:title" content="${escapedTitle}">
    <meta property="og:description" content="${escapedDescription}">
    <meta property="og:image" content="${escapedImage}">
    <meta property="og:image:secure_url" content="${escapedImage}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:url" content="${escapedShareUrl}">
    <meta name="twitter:title" content="${escapedTitle}">
    <meta name="twitter:description" content="${escapedDescription}">
    <meta name="twitter:image" content="${escapedImage}">
    <link rel="canonical" href="${escapedShareUrl}">
    <script>window.location.replace('/gallery/?id=${encodeURIComponent(id)}');</script>
  </head>
  <body>
    <p><a href="/gallery/?id=${encodeURIComponent(id)}">Open this image in the DDraw gallery</a></p>
  </body>
</html>`;
}

export async function getGalleryPreviewItem(db, id) {
  if (!db || !ObjectId.isValid(id)) return null;
  return db.collection('gallery').findOne(
    { _id: new ObjectId(id) },
    { projection: { url: 1, thumbUrl: 1, author: 1, title: 1, tags: 1, createdAt: 1 } }
  );
}
