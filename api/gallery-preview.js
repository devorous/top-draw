import { connectDB } from '../server/db.js';
import { getGalleryPreviewItem, renderGalleryPreviewHtml } from '../server/galleryPreview.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).send('Method not allowed');
  }

  const id = typeof req.query?.id === 'string' ? req.query.id : '';

  try {
    const db = await connectDB();
    const item = await getGalleryPreviewItem(db, id);
    if (!item) return res.status(404).send('Gallery image not found');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
    return res.status(200).send(renderGalleryPreviewHtml(item, req));
  } catch (error) {
    console.error('[GalleryPreview] Render error:', error);
    return res.status(500).send('Failed to render gallery preview');
  }
}
