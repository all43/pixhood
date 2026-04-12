const { createClient } = require('redis');

const client = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });

client.on('error', err => console.error('Redis error:', err));

async function connect() {
  await client.connect();
  console.log('Redis connected');
}

const HASH_KEY = 'pixels';

async function savePixel(pixel) {
  await client.hSet(HASH_KEY, pixel.id, JSON.stringify(pixel));
}

async function getAllPixels() {
  const raw = await client.hGetAll(HASH_KEY);
  return Object.values(raw).map(v => JSON.parse(v));
}

module.exports = { connect, savePixel, getAllPixels };
