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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_suppliers_country ON suppliers(country);
CREATE INDEX IF NOT EXISTS idx_suppliers_payment_mode ON suppliers(payment_mode);
CREATE INDEX IF NOT EXISTS idx_suppliers_supplies ON suppliers(supplies);
`;

export async function initSchema() {
  const statements = SCHEMA.split(';').map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    await db.execute(stmt);
  }
}
