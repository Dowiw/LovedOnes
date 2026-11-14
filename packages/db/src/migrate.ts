import { createPool, runMigrations } from './index.js';

async function main() {
  const dbUrl =
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/lovedones';
  const pool = createPool(dbUrl);
  try {
    await runMigrations(pool);
    console.log('PostGIS database migrations applied successfully.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
