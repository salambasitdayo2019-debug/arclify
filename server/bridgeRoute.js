/**
 * server/bridgeRoute.js
 *
 * Cross-chain USDC movement via Circle's CCTP (Cross-Chain Transfer
 * Protocol), scoped to Ethereum Sepolia -> Arc Testnet for now (the
 * direction Circle's own official quickstart documents end-to-end:
 * https://developers.circle.com/cctp/quickstarts/transfer-usdc-ethereum-to-arc).
 *
 * The actual approve/burn (on Sepolia) and receiveMessage/mint (on Arc)
 * transactions are signed client-side by the user's own connected wallet
 * (MetaMask/WalletConnect) — this backend only proxies Circle's Iris
 * attestation API, since it's the one piece that has to be polled
 * repeatedly and keeping it server-side avoids any CORS surprises in
 * the browser.
 *
 * Not wired up for Circle Wallets (email/PIN) yet — those wallets are
 * currently initialized for the ARC-TESTNET blockchain only, and bridging
 * from Sepolia would need the same Circle user to also hold a wallet on
 * ETH-SEPOLIA. That's a real feature (Circle Wallets support multiple
 * blockchains per user), just a separate follow-up from this one.
 */

import express from "express";

const router = express.Router();

// Circle's testnet attestation service. Production CCTP uses
// https://iris-api.circle.com instead — swap this via env var if this app
// ever bridges real (mainnet) USDC.
const IRIS_BASE_URL = process.env.CCTP_IRIS_BASE_URL || "https://iris-api-sandbox.circle.com";

/**
 * GET /api/bridge/attestation?domain=<sourceDomain>&txHash=<burnTxHash>
 *
 * Polls Circle's Iris API for the signed attestation covering a CCTP burn.
 * Returns Circle's response as-is — the frontend checks
 * `messages[0].status === "complete"` and then uses `messages[0].message`
 * + `messages[0].attestation` as the two arguments to the destination
 * chain's `receiveMessage` call.
 */
router.get("/bridge/attestation", async (req, res) => {
  const { domain, txHash } = req.query;
  if (domain === undefined || domain === "" || !txHash) {
    return res.status(400).json({ error: "Missing domain or txHash." });
  }
  try {
    const response = await fetch(`${IRIS_BASE_URL}/v2/messages/${domain}?transactionHash=${txHash}`);
    const data = await response.json().catch(() => ({}));
    // 404 just means "not attested yet" — the frontend polls again rather
    // than treating this as a hard failure, so pass the status through.
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch attestation." });
  }
});

/**
 * GET /api/bridge/fee?sourceDomain=<n>&destDomain=<n>
 *
 * Proxies Circle's live Fast Transfer fee lookup. Circle explicitly warns
 * against hardcoding this — the fee changes over time, and if the
 * maxFee passed to depositForBurn ends up below whatever Circle is
 * currently charging, the transfer silently downgrades to a Standard
 * Transfer (waiting for full source-chain finality) instead of erroring,
 * which is exactly what happened on the first live test of this feature:
 * a hardcoded maxFee that used to be enough was later "insufficient_fee".
 */
router.get("/bridge/fee", async (req, res) => {
  const { sourceDomain, destDomain } = req.query;
  if (sourceDomain === undefined || destDomain === undefined) {
    return res.status(400).json({ error: "Missing sourceDomain or destDomain." });
  }
  try {
    const response = await fetch(`${IRIS_BASE_URL}/v2/burn/USDC/fees/${sourceDomain}/${destDomain}`);
    const data = await response.json().catch(() => ({}));
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to fetch fee." });
  }
});

export default router;
