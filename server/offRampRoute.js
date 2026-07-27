/**
 * server/offRampRoute.js
 *
 * Prototype off-ramp: USDC/EURC -> local currency payout (Naira, Kenyan
 * Shilling, Cedi). This is explicitly a DEMO for presentation purposes,
 * not a production integration — worth being precise about what's real
 * here and what isn't:
 *
 * - REAL: the exchange rate (live, from a free public FX API) and the
 *   on-chain transfer the frontend performs before calling this route.
 * - SIMULATED: the actual fiat payout. Moving crypto into a real bank
 *   account or mobile money wallet requires a licensed money-transmitter
 *   partner — providers like HoneyCoin, Eversend, or Quidax exist
 *   specifically for this in African markets. Integrating one for real
 *   needs a business account and API credentials this testnet project
 *   doesn't have. This route returns a realistic-shaped mock response
 *   instead of calling any real provider, so the UI can demonstrate the
 *   full flow honestly without pretending money actually moved.
 *
 * Swapping in a real provider later is a contained change: replace the
 * body of the /simulate handler with an actual call to whichever
 * provider's quote/payout API, using the same request/response shape.
 */

import express from "express";

const router = express.Router();

// Free, no-API-key exchange rate endpoint (exchangerate-api.com's open
// access tier) — updates once daily, which is fine for a demo quote.
const FX_BASE_URL = "https://open.er-api.com/v6/latest/USD";

const SUPPORTED_CURRENCIES = {
  NGN: "Nigerian Naira",
  KES: "Kenyan Shilling",
  GHS: "Ghanaian Cedi",
};

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

export default router;
