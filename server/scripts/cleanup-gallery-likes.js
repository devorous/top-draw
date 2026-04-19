import { connectDB, getDB } from '../db.js';

async function cleanupDuplicates() {
  await connectDB();
  const db = getDB();

  console.log('Starting gallery_likes cleanup...');

  // Find and remove duplicate entries with null userId for same galleryId
  const galleries = await db.collection('gallery_likes')
    .aggregate([
      { $match: { userId: null } },
      { $group: { _id: '$galleryId', count: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { count: { $gt: 1 } } }
    ])
    .toArray();

  if (galleries.length === 0) {
    console.log('✓ No duplicate null userId entries found.');
  } else {
    console.log(`Found ${galleries.length} galleries with duplicate null userId entries`);
    let totalRemoved = 0;

    for (const gallery of galleries) {
      // Keep the first one, remove the rest
      const toRemove = gallery.ids.slice(1);
      const result = await db.collection('gallery_likes').deleteMany({
        _id: { $in: toRemove }
      });
      totalRemoved += result.deletedCount;
      console.log(`  Removed ${result.deletedCount} duplicate(s) from gallery ${gallery._id}`);
    }

    console.log(`✓ Cleaned up! Removed ${totalRemoved} duplicate entries.`);
  }

  // Find and remove duplicate entries with null deviceId for same galleryId
  const galleriesDevice = await db.collection('gallery_likes')
    .aggregate([
      { $match: { deviceId: null } },
      { $group: { _id: { galleryId: '$galleryId', userId: '$userId' }, count: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { count: { $gt: 1 } } }
    ])
    .toArray();

  if (galleriesDevice.length > 0) {
    console.log(`\nFound ${galleriesDevice.length} galleries with duplicate null deviceId entries`);
    let totalRemovedDevice = 0;

    for (const gallery of galleriesDevice) {
      const toRemove = gallery.ids.slice(1);
      const result = await db.collection('gallery_likes').deleteMany({
        _id: { $in: toRemove }
      });
      totalRemovedDevice += result.deletedCount;
    }

    console.log(`✓ Removed ${totalRemovedDevice} duplicate deviceId entries.`);
  }

  console.log('\n✓ Gallery likes collection is now clean!');
  process.exit(0);
}

cleanupDuplicates().catch(err => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
