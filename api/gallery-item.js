import { connectDB } from '../server/db.js';
import { getGalleryPreviewItem } from '../server/galleryPreview.js';

function toClientGalleryItem(item) {
  return {
    id: item._id.toString(),
    url: item.url,
    thumbUrl: item.thumbUrl || item.url,
    author: item.author,
    title: item.title || '',
    tags: Array.isArray(item.tags) ? item.tags : [],
    createdAt: item.createdAt
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = typeof req.query?.id === 'string' ? req.query.id : '';

  try {
    const db = await connectDB();
    const item = await getGalleryPreviewItem(db, id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
    return res.status(200).json(toClientGalleryItem(item));
  } catch (error) {
    console.error('[GalleryItem] Fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch item' });
  }
}
