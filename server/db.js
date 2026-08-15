/**
 * server/db.js
 *
 * A single shared Postgres connection pool (Neon's free tier), plus a
 * one-time schema setup call made at server startup. Everything here is
 * intentionally minimal — two tables, no ORM — since Agent Payroll's
 * data shape (vaults containing contractors) doesn't need more than
 * that.
 *
 * `pool` is `null` when DATABASE_URL isn't set, so routes that depend on
 * it can fail soft (a clear error message) instead of crashing the whole
 * backend — same pattern already used for GEMINI_API_KEY and
 * GOOGLE_SHEETS_WEBHOOK_URL elsewhere in this server.
 */

import pg from "pg";

const { Pool } = pg;

export const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      // Neon's connection string already carries `sslmode=require`, but
      // pg needs this set explicitly too — without it, some environments
      // reject Neon's certificate chain and every query fails outright.
      ssl: { rejectUnauthorized: false },
    })
  : null;

export async function ensureSchema() {
  if (!pool) {
    console.warn(
      "Warning: DATABASE_URL is not set. Agent Payroll's vaults/contractors will fail soft " +
      "(a clear error message) until it's set — the rest of the app is unaffected."
    );
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payroll_vaults (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_address TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payroll_contractors (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      vault_id UUID NOT NULL REFERENCES payroll_vaults(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payroll_vaults_owner ON payroll_vaults(owner_address);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payroll_contractors_vault ON payroll_contractors(vault_id);`);
  console.log("[db] Payroll schema ready (Neon Postgres).");
}
