import { createPool, runMigrations } from './index.js';

async function main() {
  const dbUrl =
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/lovedones';
  const pool = createPool(dbUrl);
  try {
    await runMigrations(pool);
    console.log('Database ready for seeding.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
