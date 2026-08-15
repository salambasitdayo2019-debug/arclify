/**
 * server/payrollRoute.js
 *
 * Real backend storage for Agent Payroll's vaults and contractors,
 * replacing what used to live in the browser's localStorage. Ownership
 * is keyed by wallet address rather than a login system — Arclify
 * already knows which wallet is talking to it, so every request just
 * carries `owner` (the connected wallet's address) and every query is
 * scoped to rows where owner_address matches. Addresses are lowercased
 * on both write and read so checksum-casing differences (0xAbC... vs
 * 0xabc...) can never split one person's data across two rows.
 *
 * This intentionally does NOT verify a signature proving the caller
 * actually controls `owner` — anyone who knows a wallet address could
 * technically read/write vaults for it. That's an acceptable trade-off
 * for a testnet payroll demo (nothing here is real money's ledger of
 * record, just an address book), but would need real request signing
 * before this pattern belonged in front of anything higher-stakes.
 */

import express from "express";
import { pool } from "./db.js";

const router = express.Router();

function requireDb(res) {
  if (!pool) {
    res.status(503).json({ error: "Database isn't set up on this deployment yet — ask the developer to add DATABASE_URL." });
    return false;
  }
  return true;
}

function normalizeOwner(raw) {
  return (raw || "").toLowerCase().trim();
}

// GET /api/payroll/vaults?owner=0x...
router.get("/payroll/vaults", async (req, res) => {
  if (!requireDb(res)) return;
  const owner = normalizeOwner(req.query.owner);
  if (!owner) return res.status(400).json({ error: "Missing owner." });
  try {
    const { rows: vaults } = await pool.query(
      `SELECT id, name, created_at FROM payroll_vaults WHERE owner_address = $1 ORDER BY created_at ASC`,
      [owner]
    );
    const ids = vaults.map((v) => v.id);
    const { rows: counts } = ids.length
      ? await pool.query(
          `SELECT vault_id, COUNT(*)::int AS count FROM payroll_contractors WHERE vault_id = ANY($1::uuid[]) GROUP BY vault_id`,
          [ids]
        )
      : { rows: [] };
    const countMap = Object.fromEntries(counts.map((c) => [c.vault_id, c.count]));
    res.json({
      vaults: vaults.map((v) => ({ id: v.id, name: v.name, contractorCount: countMap[v.id] || 0 })),
    });
  } catch (err) {
    console.error("[payroll] list vaults failed:", err.message);
    res.status(500).json({ error: "Couldn't load vaults right now." });
  }
});

// POST /api/payroll/vaults  { owner, name }
router.post("/payroll/vaults", async (req, res) => {
  if (!requireDb(res)) return;
  const owner = normalizeOwner(req.body.owner);
  const name = (req.body.name || "").trim();
  if (!owner || !name) return res.status(400).json({ error: "Missing owner or name." });
  try {
    const { rows } = await pool.query(
      `INSERT INTO payroll_vaults (owner_address, name) VALUES ($1, $2) RETURNING id, name`,
      [owner, name]
    );
    res.json({ vault: { id: rows[0].id, name: rows[0].name, contractorCount: 0 } });
  } catch (err) {
    console.error("[payroll] create vault failed:", err.message);
    res.status(500).json({ error: "Couldn't create the vault right now." });
  }
});

// GET /api/payroll/vaults/:vaultId/contractors?owner=0x...
router.get("/payroll/vaults/:vaultId/contractors", async (req, res) => {
  if (!requireDb(res)) return;
  const owner = normalizeOwner(req.query.owner);
  const { vaultId } = req.params;
  try {
    const { rows: owned } = await pool.query(
      `SELECT id FROM payroll_vaults WHERE id = $1 AND owner_address = $2`,
      [vaultId, owner]
    );
    if (owned.length === 0) return res.status(404).json({ error: "Vault not found." });
    const { rows } = await pool.query(
      `SELECT id, name, address FROM payroll_contractors WHERE vault_id = $1 ORDER BY created_at ASC`,
      [vaultId]
    );
    res.json({ contractors: rows });
  } catch (err) {
    console.error("[payroll] list contractors failed:", err.message);
    res.status(500).json({ error: "Couldn't load contractors right now." });
  }
});

// POST /api/payroll/vaults/:vaultId/contractors  { owner, name, address }
router.post("/payroll/vaults/:vaultId/contractors", async (req, res) => {
  if (!requireDb(res)) return;
  const owner = normalizeOwner(req.body.owner);
  const name = (req.body.name || "").trim();
  const address = (req.body.address || "").trim();
  const { vaultId } = req.params;
  if (!owner || !name || !address) return res.status(400).json({ error: "Missing name or address." });
  try {
    const { rows: owned } = await pool.query(
      `SELECT id FROM payroll_vaults WHERE id = $1 AND owner_address = $2`,
      [vaultId, owner]
    );
    if (owned.length === 0) return res.status(404).json({ error: "Vault not found." });
    const { rows } = await pool.query(
      `INSERT INTO payroll_contractors (vault_id, name, address) VALUES ($1, $2, $3) RETURNING id, name, address`,
      [vaultId, name, address]
    );
    res.json({ contractor: rows[0] });
  } catch (err) {
    console.error("[payroll] add contractor failed:", err.message);
    res.status(500).json({ error: "Couldn't add that contractor right now." });
  }
});

export default router;
