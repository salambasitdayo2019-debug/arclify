/**
 * server/offRampRoute.js
 *
 * Ramp: local currency (Naira, Kenyan Shilling, Cedi) <-> USDC/EURC on
 * Arc Testnet. Worth being precise about what's real here and what
 * isn't, on each side:
 *
 * WITHDRAW (crypto -> fiat):
 * - REAL: live exchange rate, and the user's own token genuinely leaves
 *   their wallet on-chain (they already own it — no treasury needed).
 * - SIMULATED: the actual bank/mobile money payout. That needs a
 *   licensed money-transmitter partner (HoneyCoin, Eversend, Quidax for
 *   African corridors) this project doesn't have.
 *
 * DEPOSIT (fiat -> crypto):
 * - For NGN: FULLY REAL, end to end. Payment is collected through
 *   Paystack's real checkout (test mode = fake money on a real payment
 *   flow; live mode = real Naira, once the Paystack account is
 *   verified). The backend independently verifies the payment against
 *   Paystack's own API before crediting anything — never trusts the
 *   frontend's word that payment succeeded. Once verified, a small
 *   server-held treasury wallet (same pattern as Swap's signer wallet)
 *   sends real testnet USDC/EURC to the user's address.
 * - For KES/GHS: still the simpler simulated flow (/simulate-deposit) —
 *   Paystack integration here is scoped to NGN only, since that's what
 *   an individual Nigerian account is actually set up for.
 *
 * The treasury wallet needs DEPOSIT_TREASURY_PRIVATE_KEY set and funded
 * with testnet USDC/EURC (faucet.circle.com) — same known-limitation
 * shape as Swap's signer wallet: shared pool, no per-user account, fine
 * for testnet demo purposes. A per-transaction cap (MAX_DEPOSIT_USD)
 * limits how much a single request can drain regardless.
 *
 * Paystack needs PAYSTACK_SECRET_KEY set (test or live, from Paystack's
 * dashboard under Settings -> API Keys & Webhooks).
 */

import express from "express";
import { ethers } from "ethers";

const router = express.Router();

const ARC_RPC_URL = "https://rpc.testnet.arc.network";
const EURC_ADDRESS = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
];
const MAX_DEPOSIT_USD = 50; // per-transaction cap, demo safety net
const PAYSTACK_BASE_URL = "https://api.paystack.co";

// In-memory guard against crediting the same verified Paystack payment
// twice (e.g. a page refresh re-triggering verification). Resets on
// server restart — fine for a prototype's single-instance scope, but a
// real deployment would track this in a database instead.
const creditedReferences = new Set();

// Free, no-API-key exchange rate endpoint (exchangerate-api.com's open
// access tier) — updates once daily, which is fine for a demo quote.
const FX_BASE_URL = "https://open.er-api.com/v6/latest/USD";

const SUPPORTED_CURRENCIES = {
  NGN: "Nigerian Naira",
  KES: "Kenyan Shilling",
  GHS: "Ghanaian Cedi",
};

// Shared by both the old direct credit-deposit path and the new
// Paystack-verified path — sends real testnet tokens from the treasury
// wallet. Recomputes the token amount from a FRESH rate lookup itself
// rather than trusting whatever the caller passes in, since this
// genuinely moves funds either way.
async function creditTreasuryTokens(toAddress, token, localAmount, currency) {
  if (!ethers.isAddress(toAddress)) throw new Error("Invalid address.");
  if (!process.env.DEPOSIT_TREASURY_PRIVATE_KEY) {
    throw new Error("Deposit treasury isn't configured yet. Set DEPOSIT_TREASURY_PRIVATE_KEY on the backend and fund it with testnet USDC/EURC via faucet.circle.com.");
  }

  const rateRes = await fetch(FX_BASE_URL);
  const rateData = await rateRes.json();
  const rate = rateData?.rates?.[currency.toUpperCase()];
  if (rateData.result !== "success" || !rate) {
    throw new Error("Rate lookup failed — couldn't safely price this deposit.");
  }
  const tokenAmount = Number(localAmount) / rate;

  if (tokenAmount > MAX_DEPOSIT_USD) {
    throw new Error(`This demo caps deposits at the equivalent of $${MAX_DEPOSIT_USD}. Try a smaller amount.`);
  }

  const provider = new ethers.JsonRpcProvider(ARC_RPC_URL);
  const treasury = new ethers.Wallet(process.env.DEPOSIT_TREASURY_PRIVATE_KEY, provider);

  let tx;
  if (token.toUpperCase() === "USDC") {
    tx = await treasury.sendTransaction({
      to: toAddress,
      value: ethers.parseUnits(tokenAmount.toFixed(6), 18),
    });
  } else if (token.toUpperCase() === "EURC") {
    const eurc = new ethers.Contract(EURC_ADDRESS, ERC20_ABI, treasury);
    tx = await eurc.transfer(toAddress, ethers.parseUnits(tokenAmount.toFixed(6), 6));
  } else {
    throw new Error("Unsupported token for crediting.");
  }
  await tx.wait();
  return { txHash: tx.hash, tokenAmount };
}

/**
 * GET /api/offramp/rate?currency=NGN
 * Live USD -> local currency rate, straight from a real public FX feed.
 */
router.get("/offramp/rate", async (req, res) => {
  const currency = (req.query.currency || "NGN").toUpperCase();
  if (!SUPPORTED_CURRENCIES[currency]) {
    return res.status(400).json({ error: `Unsupported currency. Try one of: ${Object.keys(SUPPORTED_CURRENCIES).join(", ")}` });
  }
  try {
    const response = await fetch(FX_BASE_URL);
    const data = await response.json();
    if (data.result !== "success" || !data.rates?.[currency]) {
      return res.status(502).json({ error: "Rate lookup failed." });
    }
    res.json({
      currency,
      currencyName: SUPPORTED_CURRENCIES[currency],
      rate: data.rates[currency], // units of `currency` per 1 USD
      asOf: data.time_last_update_utc,
      source: "exchangerate-api.com (open access)",
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch exchange rate." });
  }
});

/**
 * POST /api/offramp/simulate
 * body: { amount, token, currency, payoutMethod, accountLabel }
 *
 * Returns a realistic mock payout record — NOT a real transaction with
 * any provider. No money moves here; this exists purely to demonstrate
 * the shape of a real integration (quote -> reference -> status
 * progression) for a presentation/demo context.
 */
router.post("/offramp/simulate", async (req, res) => {
  const { amount, token, currency, payoutMethod, accountLabel } = req.body || {};
  if (!amount || !token || !currency || !payoutMethod) {
    return res.status(400).json({ error: "Missing required fields." });
  }
  const reference = `DEMO-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  res.json({
    reference,
    status: "processing",
    simulated: true,
    amount,
    token,
    currency,
    payoutMethod,
    accountLabel: accountLabel || null,
    note: "Simulated payout — no real funds were moved to any bank or mobile money account. A production build would call a licensed off-ramp provider (e.g. HoneyCoin, Eversend, Quidax) here instead.",
  });
});

/**
 * POST /api/offramp/simulate-deposit
 * body: { localAmount, currency, token, fundingMethod, accountLabel }
 *
 * Confirms the (simulated) fiat side of a deposit — "your Naira/Shilling/
 * Cedi payment was received." Actually collecting a real bank transfer
 * needs the same licensed-partner integration Withdraw's payout side
 * would need, which this project doesn't have. Returns a reference the
 * frontend then uses to request the REAL crediting step below.
 */
router.post("/offramp/simulate-deposit", async (req, res) => {
  const { localAmount, currency, token, fundingMethod, accountLabel } = req.body || {};
  if (!localAmount || !currency || !token || !fundingMethod) {
    return res.status(400).json({ error: "Missing required fields." });
  }
  const reference = `DEMO-DEP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  res.json({
    reference,
    status: "processing",
    simulated: true,
    localAmount,
    currency,
    token,
    fundingMethod,
    accountLabel: accountLabel || null,
    note: "Simulated payment confirmation — no real fiat was collected. A production build would call a licensed on-ramp provider here instead.",
  });
});

/**
 * POST /api/offramp/credit-deposit
 * body: { toAddress, token, localAmount, currency }
 *
 * Direct crediting path — used by the KES/GHS simulated-payment flow
 * (where there's no real payment to verify against). For NGN, prefer
 * the Paystack-verified path below instead.
 */
router.post("/offramp/credit-deposit", async (req, res) => {
  const { toAddress, token, localAmount, currency } = req.body || {};
  if (!toAddress || !token || !localAmount || !currency) {
    return res.status(400).json({ error: "Missing required fields." });
  }
  try {
    const result = await creditTreasuryTokens(toAddress, token, localAmount, currency);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to credit deposit." });
  }
});

/**
 * POST /api/offramp/paystack/initialize
 * body: { email, localAmount }
 *
 * Starts a REAL Paystack transaction (test-mode fake money, or live
 * money once the account is verified — same API either way, Paystack
 * switches behavior based on which secret key is configured). Returns
 * an authorization_url/access_code the frontend uses to open Paystack's
 * real checkout popup.
 */
router.post("/offramp/paystack/initialize", async (req, res) => {
  const { email, localAmount } = req.body || {};
  if (!email || !localAmount) {
    return res.status(400).json({ error: "Missing email or amount." });
  }
  if (!process.env.PAYSTACK_SECRET_KEY) {
    return res.status(503).json({ error: "Paystack isn't configured yet. Set PAYSTACK_SECRET_KEY on the backend." });
  }
  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}/transaction/initialize`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        amount: Math.round(Number(localAmount) * 100), // Paystack expects kobo (NGN's smallest unit)
        currency: "NGN",
      }),
    });
    const data = await response.json();
    if (!data.status) return res.status(400).json({ error: data.message || "Could not start Paystack payment." });
    res.json(data.data); // { authorization_url, access_code, reference }
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to initialize Paystack transaction." });
  }
});

/**
 * GET /api/offramp/paystack/verify?reference=...&toAddress=...&token=...
 *
 * The REAL leg: independently verifies the payment against Paystack's
 * own API (never trusts the frontend's word that checkout succeeded —
 * exactly what Paystack's own docs warn to always do server-side), and
 * only then credits real testnet tokens. Guards against crediting the
 * same reference twice.
 */
router.get("/offramp/paystack/verify", async (req, res) => {
  const { reference, toAddress, token } = req.query;
  if (!reference || !toAddress || !token) {
    return res.status(400).json({ error: "Missing reference, toAddress, or token." });
  }
  if (!process.env.PAYSTACK_SECRET_KEY) {
    return res.status(503).json({ error: "Paystack isn't configured yet. Set PAYSTACK_SECRET_KEY on the backend." });
  }
  if (creditedReferences.has(reference)) {
    return res.status(409).json({ error: "This payment has already been credited." });
  }

  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });
    const data = await response.json();
    if (!data.status || data.data?.status !== "success") {
      return res.status(400).json({ error: "Payment not verified as successful by Paystack." });
    }

    const localAmount = data.data.amount / 100; // kobo -> Naira
    const result = await creditTreasuryTokens(toAddress, token, localAmount, "NGN");
    creditedReferences.add(reference);
    res.json({ ...result, localAmount, verifiedBy: "paystack" });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to verify Paystack payment." });
  }
});

export default router;
