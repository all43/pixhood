#!/usr/bin/env node
// TEMP — flush all pixel data from Redis
// Usage: REDIS_URL=... node scripts/flush-redis.js [--dry-run]

const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error('Usage: REDIS_URL=... node scripts/flush-redis.js [--dry-run]');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const client = createClient({ url: REDIS_URL });
  await client.connect();
  console.log('Connected to Redis');

  let total = 0;

  for (const pattern of ['pixel:*', 'subpixels:*']) {
    const keys = [];
    for await (const key of client.scanIterator({ MATCH: pattern, COUNT: 500 })) {
      keys.push(key);
    }
    console.log(`${pattern}: ${keys.length} keys`);
    total += keys.length;
    if (!dryRun && keys.length > 0) {
      await client.del(keys);
      console.log(`  deleted`);
    }
  }

  const geoExists = await client.exists('pixels:geo');
  if (geoExists) {
    console.log('pixels:geo: 1 key');
    total += 1;
    if (!dryRun) {
      await client.del('pixels:geo');
      console.log(`  deleted`);
    }
  }

  if (dryRun) {
    console.log(`\nDry run — would delete ${total} keys total`);
  } else {
    console.log(`\nFlushed ${total} keys total`);
  }

  await client.quit();
}

main().catch(e => { console.error(e); process.exit(1); });
