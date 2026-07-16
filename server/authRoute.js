/**
 * server/authRoute.js
 *
 * Signature-based ("Sign-In With Ethereum" style) login.
 *
 * Flow:
 *   1. GET  /api/auth/nonce?address=0x...   -> one-time message to sign
 *   2. wallet signs the message client-side (no gas, no tx)
 *   3. POST /api/auth/verify { address, signature } -> JWT session token
 *   4. GET  /api/auth/session (Authorization: Bearer <token>) -> validate
 *
 * Nonces are kept in memory, which is fine for a single Render instance on
 * testnet. If this ever runs multi-instance or needs to survive restarts,
 * move `nonces` to Redis or a database table instead.
 */

import { Router } from "express";
import jwt from "jsonwebtoken";
import { ethers } from "ethers";
import crypto from "crypto";

const router = Router();

const nonces = new Map(); // lowercased address -> { message, expiresAt }
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const JWT_EXPIRES_IN = "24h";
const APP_DOMAIN = process.env.APP_DOMAIN || "arclify-ab66-eight.vercel.app";
const JWT_SECRET = process.env.JWT_SECRET;

function buildMessage(address, nonce) {
  return [
    `${APP_DOMAIN} wants you to sign in with your Ethereum account:`,
    address,
    "",
    "Sign in to Arclify. This request will not trigger a blockchain transaction or cost any gas fees.",
    "",
    `URI: https://${APP_DOMAIN}`,
    "Version: 1",
    "Chain ID: 5042002",
    `Nonce: ${nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
}

router.get("/auth/nonce", (req, res) => {
  const raw = String(req.query.address || "");
  if (!ethers.isAddress(raw)) {
    return res.status(400).json({ error: "A valid address query param is required." });
  }
  const checksummed = ethers.getAddress(raw);
  const key = checksummed.toLowerCase();
  const nonce = crypto.randomBytes(16).toString("hex");
  const message = buildMessage(checksummed, nonce);
  nonces.set(key, { message, expiresAt: Date.now() + NONCE_TTL_MS });
  res.json({ message });
});

router.post("/auth/verify", (req, res) => {
  if (!JWT_SECRET) {
    return res.status(500).json({ error: "Server auth is not configured (missing JWT_SECRET)." });
  }
  try {
    const { address, signature } = req.body || {};
    if (!address || !ethers.isAddress(address) || !signature) {
      return res.status(400).json({ error: "address and signature are required." });
    }
    const key = address.toLowerCase();
    const entry = nonces.get(key);
    if (!entry || entry.expiresAt < Date.now()) {
      nonces.delete(key);
      return res.status(400).json({ error: "Sign-in request expired. Please try again." });
    }

    const recovered = ethers.verifyMessage(entry.message, signature);
    if (recovered.toLowerCase() !== key) {
      return res.status(401).json({ error: "Signature does not match the given address." });
    }
    nonces.delete(key); // one-time use

    const checksummed = ethers.getAddress(address);
    const token = jwt.sign({ address: checksummed }, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN,
    });
    res.json({ token, address: checksummed });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Verification failed." });
  }
});

router.get("/auth/session", (req, res) => {
  if (!JWT_SECRET) {
    return res.status(500).json({ error: "Server auth is not configured (missing JWT_SECRET)." });
  }
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No session token provided." });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    res.json({ address: payload.address });
  } catch {
    res.status(401).json({ error: "Invalid or expired session." });
  }
});

export default router;
