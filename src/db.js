// ─────────────────────────────────────────────────────────────
// Turso (libSQL) database connection + schema.
// TURSO_DATABASE_URL and TURSO_AUTH_TOKEN come from environment
// variables (set in Render dashboard, NOT hardcoded here).
// ─────────────────────────────────────────────────────────────
import { createClient } from '@libsql/client';

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  throw new Error(
    'Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN environment variables. ' +
    'Set these in your hosting provider (e.g. Render) before starting the server.'
  );
}

export const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// One record per supplier submission. Fields map directly to
// supplier-portal-spec.md Section 6 (10.1) field list.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name TEXT NOT NULL,
  supplies TEXT NOT NULL,              -- comma-separated list, e.g. "Fabric,Print"
  supplies_other TEXT,                 -- only set if "Others" was selected
  country TEXT NOT NULL,
  full_address TEXT NOT NULL,
  mobile TEXT NOT NULL,
  whatsapp TEXT NOT NULL,
  email TEXT NOT NULL,
  sample_delivery_time TEXT NOT NULL,
  payment_mode TEXT NOT NULL,
  lab_dip_time TEXT,                   -- only set if Fabric selected
  lab_dip_charge TEXT,                 -- 'Yes' / 'No', only if Fabric selected
  lab_dip_amount TEXT,                 -- optional, only if lab_dip_charge = 'Yes'
  profile_file_url TEXT,               -- [TODO] not yet wired to storage — see server.js note
  ip_address TEXT,                     -- submitter's IP at time of submission
  user_agent TEXT,                     -- submitter's browser/device string
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_suppliers_country ON suppliers(country);
CREATE INDEX IF NOT EXISTS idx_suppliers_payment_mode ON suppliers(payment_mode);
CREATE INDEX IF NOT EXISTS idx_suppliers_supplies ON suppliers(supplies);
`;

// Columns/constraints added after the table already existed in production.
// CREATE TABLE IF NOT EXISTS above does nothing on an existing table, so
// these need explicit ALTER TABLE / CREATE INDEX statements applied
// separately, each tolerant of "already applied" so a restart doesn't crash.
const MIGRATIONS = [
  { sql: `ALTER TABLE suppliers ADD COLUMN ip_address TEXT`, ignoreIfIncludes: 'duplicate column' },
  { sql: `ALTER TABLE suppliers ADD COLUMN user_agent TEXT`, ignoreIfIncludes: 'duplicate column' },
  // Prevents the same email+mobile combination from being inserted twice.
  // If existing data already has a duplicate pair, this will fail — that's
  // deliberately NOT swallowed below, since silently skipping it would mean
  // duplicate protection silently never turns on. Check server logs if this
  // ever throws, and de-duplicate the existing rows first.
  { sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_email_mobile_unique ON suppliers(email, mobile)`, ignoreIfIncludes: null },
];

export async function initSchema() {
  const statements = SCHEMA.split(';').map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    await db.execute(stmt);
  }

  for (const migration of MIGRATIONS) {
    try {
      await db.execute(migration.sql);
    } catch (err) {
      const msg = String(err.message || '').toLowerCase();
      if (migration.ignoreIfIncludes && msg.includes(migration.ignoreIfIncludes)) {
        continue;
      }
      throw err;
    }
  }
}
