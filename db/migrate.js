'use strict';
const fs = require('fs');
const path = require('path');
const db = require('./pool');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function migrate() {
  if (!db.hasDatabase()) {
    console.log('[db:migrate] No DATABASE_URL set. Skipping migrations.');
    return { applied: [] };
  }

  // Ensure migrations tracking table exists
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(64) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const appliedRes = await db.query('SELECT version FROM schema_migrations ORDER BY version ASC');
  const applied = new Set(appliedRes.rows.map((r) => r.version));

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const newlyApplied = [];

  for (const file of files) {
    if (applied.has(file)) continue;

    console.log(`[db:migrate] Applying migration: ${file}...`);
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

    await db.withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    });

    console.log(`[db:migrate] Applied: ${file}`);
    newlyApplied.push(file);
  }

  if (newlyApplied.length === 0) {
    console.log('[db:migrate] Database schema is up to date.');
  }

  return { applied: newlyApplied };
}

if (require.main === module) {
  migrate()
    .then(() => db.close())
    .catch((err) => {
      console.error('[db:migrate] Error during migration:', err);
      process.exit(1);
    });
}

module.exports = { migrate };
