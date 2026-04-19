import { connectDB, getDB } from '../db.js';

async function migrateHearts() {
  await connectDB();
  const db = getDB();
  if (!db) {
    console.error('Database not available');
    process.exit(1);
  }

  console.log('Starting hearts migration...');

  // Find all gallery items that are missing likesCount
  const itemsMissingCount = await db.collection('gallery')
    .find({ likesCount: { $exists: false } })
    .toArray();

  if (itemsMissingCount.length === 0) {
    console.log('✓ All items have likesCount field. Nothing to migrate.');
    process.exit(0);
  }

  console.log(`Found ${itemsMissingCount.length} items missing likesCount field`);

  // Migrate each item
  let migrated = 0;
  for (const item of itemsMissingCount) {
    const oldLikesCount = typeof item.likes === 'number' ? item.likes : 0;

    await db.collection('gallery').updateOne(
      { _id: item._id },
      {
        $set: {
          likesCount: oldLikesCount,
          likes: [] // Initialize empty likes array if it's a number
        }
      }
    );

    migrated++;
    if (migrated % 10 === 0) {
      console.log(`  Migrated ${migrated}/${itemsMissingCount.length}...`);
    }
  }

  console.log(`\n✓ Migration complete! Migrated ${migrated} items.`);
  console.log(`  Old like counts have been preserved in likesCount field.`);

  process.exit(0);
}

migrateHearts().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
