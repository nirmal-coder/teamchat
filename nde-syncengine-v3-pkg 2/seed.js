const Redis = require('ioredis');
const redis = new Redis('redis://127.0.0.1:6379');

async function seed() {
  const convId = process.argv[2] || 'test1';
  const user = process.argv[3] || 'user1';
  
  await redis.sadd(`conv:${convId}:members`, user);
  await redis.sadd(`conv:${convId}:admins`, user);
  
  console.log(`✅ Seeded conversation '${convId}' with member/admin '${user}' in Redis.`);
  process.exit(0);
}

seed().catch(err => {
  console.error('Failed to seed:', err);
  process.exit(1);
});
