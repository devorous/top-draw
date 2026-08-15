// server/scripts/set-gallery-cors.js
import 'dotenv/config';
import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } from '@aws-sdk/client-s3';

function parseArgs(argv) {
  const args = { dryRun: false, origins: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (arg === '--origin') {
      args.origins.push(argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

const { dryRun, origins } = parseArgs(process.argv.slice(2));

const ENDPOINT = process.env.R2_ENDPOINT || '';
const BUCKET = process.env.R2_BUCKET_NAME || 'gallery';
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';

if (!ENDPOINT || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY) {
  console.error('[Gallery CORS] Missing R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY in env.');
  process.exit(1);
}

const allowedOrigins = origins.length > 0
  ? origins
  : ['https://www.ddraw.ca', 'https://ddraw.ca'];

const corsConfig = {
  CORSRules: [
    {
      AllowedOrigins: allowedOrigins,
      AllowedMethods: ['GET', 'HEAD'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['Content-Length', 'Content-Range', 'Content-Type', 'ETag'],
      MaxAgeSeconds: 3600,
    },
  ],
};

const r2 = new S3Client({
  region: 'auto',
  endpoint: ENDPOINT,
  credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
});

console.log(`[Gallery CORS] Bucket: ${BUCKET}`);
console.log(`[Gallery CORS] Allowed origins: ${allowedOrigins.join(', ')}`);

try {
  const current = await r2.send(new GetBucketCorsCommand({ Bucket: BUCKET }));
  console.log('[Gallery CORS] Current rules:', JSON.stringify(current.CORSRules ?? [], null, 2));
} catch (error) {
  if (error.name === 'NoSuchCORSConfiguration') {
    console.log('[Gallery CORS] No existing CORS configuration.');
  } else {
    console.warn('[Gallery CORS] Could not read current CORS config:', error.message);
  }
}

if (dryRun) {
  console.log('[Gallery CORS] Dry run only; not applying.');
  console.log(JSON.stringify(corsConfig, null, 2));
  process.exit(0);
}

await r2.send(new PutBucketCorsCommand({ Bucket: BUCKET, CORSConfiguration: corsConfig }));
console.log('[Gallery CORS] Applied.');
