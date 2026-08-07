// ─────────────────────────────────────────────────────────────
// Turso (libSQL) database connection + schema.
// Uses '@libsql/client/web' — the HTTP-based build meant for edge/
// serverless runtimes like Cloudflare Workers (the plain '@libsql/client'
// import pulls in native bindings that don't exist in Workers).
// TURSO_DATABASE_URL and TURSO_AUTH_TOKEN come from Worker secrets
// (c.env), not process.env — Workers has no persistent process, so a
// fresh client is created per-request from whatever env was passed in.
// ─────────────────────────────────────────────────────────────
import { createClient } from '@libsql/client/web';

export function getDb(env) {
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) {
    throw new Error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN secret.');
  }
  return createClient({
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  });
}

// One record per supplier submission. Fields map directly to
// supplier-portal-spec.md Section 6 (10.1) field list.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name TEXT NOT NULL,
  supplies TEXT NOT NULL,
  supplies_other TEXT,
  country TEXT NOT NULL,
  full_address TEXT NOT NULL,
  mobile TEXT NOT NULL,
  whatsapp TEXT NOT NULL,
  email TEXT NOT NULL,
  sample_delivery_time TEXT NOT NULL,
  payment_mode TEXT NOT NULL,
  lab_dip_time TEXT,
  lab_dip_charge TEXT,
  lab_dip_amount TEXT,
  profile_file_name TEXT,
  profile_file_data TEXT,
  ip_address TEXT,
  user_agent TEXT,
  browser_name TEXT,
  os_name TEXT,
  device_type TEXT,
  referrer TEXT,
  accept_language TEXT,
  ip_country TEXT,
  ip_city TEXT,
  ip_isp TEXT,
  ip_is_proxy_or_vpn INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_suppliers_country ON suppliers(country);
CREATE INDEX IF NOT EXISTS idx_suppliers_payment_mode ON suppliers(payment_mode);
CREATE INDEX IF NOT EXISTS idx_suppliers_supplies ON suppliers(supplies);
`;

const MIGRATIONS = [
  { sql: `ALTER TABLE suppliers ADD COLUMN ip_address TEXT`, ignoreIfIncludes: 'duplicate column' },
  { sql: `ALTER TABLE suppliers ADD COLUMN user_agent TEXT`, ignoreIfIncludes: 'duplicate column' },
  { sql: `ALTER TABLE suppliers ADD COLUMN profile_file_name TEXT`, ignoreIfIncludes: 'duplicate column' },
  { sql: `ALTER TABLE suppliers ADD COLUMN profile_file_data TEXT`, ignoreIfIncludes: 'duplicate column' },
  { sql: `ALTER TABLE suppliers ADD COLUMN browser_name TEXT`, ignoreIfIncludes: 'duplicate column' },
  { sql: `ALTER TABLE suppliers ADD COLUMN os_name TEXT`, ignoreIfIncludes: 'duplicate column' },
  { sql: `ALTER TABLE suppliers ADD COLUMN device_type TEXT`, ignoreIfIncludes: 'duplicate column' },
  { sql: `ALTER TABLE suppliers ADD COLUMN referrer TEXT`, ignoreIfIncludes: 'duplicate column' },
  { sql: `ALTER TABLE suppliers ADD COLUMN accept_language TEXT`, ignoreIfIncludes: 'duplicate column' },
  { sql: `ALTER TABLE suppliers ADD COLUMN ip_country TEXT`, ignoreIfIncludes: 'duplicate column' },
  { sql: `ALTER TABLE suppliers ADD COLUMN ip_city TEXT`, ignoreIfIncludes: 'duplicate column' },
  { sql: `ALTER TABLE suppliers ADD COLUMN ip_isp TEXT`, ignoreIfIncludes: 'duplicate column' },
  { sql: `ALTER TABLE suppliers ADD COLUMN ip_is_proxy_or_vpn INTEGER`, ignoreIfIncludes: 'duplicate column' },
  { sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_email_mobile_unique ON suppliers(email, mobile)`, ignoreIfIncludes: null },
];

// Workers cold-start on every request that hits a fresh isolate, so
// running the full schema/migrations check on every request would be
// wasteful. This flag makes it run at most once per isolate lifetime
// (module-level state survives across requests handled by the same
// warm isolate, resets on a fresh one — which is fine, since all the
// statements below are idempotent).
let schemaReady = false;

export async function initSchema(db) {
  if (schemaReady) return;
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
  schemaReady = true;
}
