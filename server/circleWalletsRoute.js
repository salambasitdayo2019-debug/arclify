/**
 * server/circleWalletsRoute.js
 *
 * Phase 1 of Circle User-Controlled Wallets integration: lets someone sign
 * in with an email/PIN identity instead of MetaMask, and creates them a
 * real wallet on Arc Testnet. This is a thin proxy in front of Circle's
 * REST API — CIRCLE_API_KEY stays server-side always, the frontend never
 * sees it. Mirrors Circle's own official quickstart route shape, just
 * ported from Next.js route handlers to Express.
 *
 * Endpoints:
 *   POST /api/circle/create-user      { userId } -> { id, status, ... }
 *   POST /api/circle/user-token       { userId } -> { userToken, encryptionKey }
 *   POST /api/circle/initialize-user  { userToken } -> { challengeId } | 155106 if already set up
 *   GET  /api/circle/wallets          ?userToken=... -> { wallets: [...] }
 *   GET  /api/circle/balance          ?userToken=...&walletId=... -> { tokenBalances: [...] }
 *
 * Phase 2 (not included yet): transaction challenges for Transfer/Swap/NFT
 * actions — those go through Circle's Transactions API + SDK execute(),
 * a different flow from ethers.js signing.
 */

import express from "express";
import crypto from "crypto";

const router = express.Router();

const CIRCLE_BASE_URL = process.env.CIRCLE_BASE_URL || "https://api.circle.com";
const ACCOUNT_TYPE = "SCA";
const PRIMARY_BLOCKCHAIN = "ARC-TESTNET";

function requireApiKey(res) {
  if (!process.env.CIRCLE_API_KEY) {
    res.status(500).json({ error: "Circle Wallets is not configured (missing CIRCLE_API_KEY)." });
    return false;
  }
  return true;
}

router.post("/circle/create-user", async (req, res) => {
  if (!requireApiKey(res)) return;
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "Missing userId." });
  try {
    const response = await fetch(`${CIRCLE_BASE_URL}/v1/w3s/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
      },
      body: JSON.stringify({ userId }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data.data);
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to create user." });
  }
});

router.post("/circle/user-token", async (req, res) => {
  if (!requireApiKey(res)) return;
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "Missing userId." });
  try {
    const response = await fetch(`${CIRCLE_BASE_URL}/v1/w3s/users/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
      },
      body: JSON.stringify({ userId }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data.data); // { userToken, encryptionKey }
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to get user token." });
  }
});

router.post("/circle/initialize-user", async (req, res) => {
  if (!requireApiKey(res)) return;
  const { userToken } = req.body || {};
  if (!userToken) return res.status(400).json({ error: "Missing userToken." });
  try {
    const response = await fetch(`${CIRCLE_BASE_URL}/v1/w3s/user/initialize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
        "X-User-Token": userToken,
      },
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        accountType: ACCOUNT_TYPE,
        blockchains: [PRIMARY_BLOCKCHAIN],
      }),
    });
    const data = await response.json();
    // Pass through as-is even on error — the frontend specifically checks
    // for Circle's code 155106 ("user already initialized") to decide
    // whether to show the PIN challenge or just load the existing wallet.
    res.status(response.status).json(response.ok ? data.data : data);
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to initialize user." });
  }
});

/**
 * POST /api/circle/create-wallet
 *
 * Phase 3 (Bridge for Circle Wallets): provisions a wallet for the SAME
 * Circle user on an ADDITIONAL blockchain beyond Arc — e.g. ETH-SEPOLIA,
 * so they can hold USDC there to bridge in. Same challenge->PIN pattern
 * as every other Circle action in this app; the frontend executes the
 * returned challengeId via the Web SDK, then re-fetches the wallet list
 * to pick up the newly created wallet.
 */
router.post("/circle/create-wallet", async (req, res) => {
  if (!requireApiKey(res)) return;
  const { userToken, blockchain } = req.body || {};
  if (!userToken || !blockchain) {
    return res.status(400).json({ error: "Missing userToken or blockchain." });
  }
  try {
    const response = await fetch(`${CIRCLE_BASE_URL}/v1/w3s/user/wallets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
        "X-User-Token": userToken,
      },
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        accountType: ACCOUNT_TYPE, // match the account type the user was already initialized with
        blockchains: [blockchain],
      }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data.data); // { challengeId }
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to create wallet." });
  }
});

router.get("/circle/wallets", async (req, res) => {
  if (!requireApiKey(res)) return;
  const userToken = req.query.userToken;
  if (!userToken) return res.status(400).json({ error: "Missing userToken." });
  try {
    const response = await fetch(`${CIRCLE_BASE_URL}/v1/w3s/wallets`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
        "X-User-Token": userToken,
      },
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data.data); // { wallets: [...] }
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to list wallets." });
  }
});

router.get("/circle/balance", async (req, res) => {
  if (!requireApiKey(res)) return;
  const { userToken, walletId } = req.query;
  if (!userToken || !walletId) return res.status(400).json({ error: "Missing userToken or walletId." });
  try {
    const response = await fetch(`${CIRCLE_BASE_URL}/v1/w3s/wallets/${walletId}/balances`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
        "X-User-Token": userToken,
      },
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data.data); // { tokenBalances: [...] }
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to load balance." });
  }
});

/**
 * POST /api/circle/transfer-challenge
 *
 * Phase 2a/2b: creates a Circle transaction challenge for sending a token
 * from a Circle-controlled wallet. Returns a challengeId that the frontend
 * then executes via the Web SDK (sdk.execute), which shows the user their
 * PIN prompt to actually authorize the send.
 *
 * Native USDC (no tokenAddress in the request) uses the native-transfer
 * shape: just `blockchain`, no `tokenId`/`tokenAddress`. EURC/cirBTC are
 * real ERC-20 contracts on Arc Testnet, so those pass `tokenAddress` +
 * `blockchain` instead — Circle resolves the token from the contract
 * address on that chain rather than needing Circle's internal tokenId.
 */
router.post("/circle/transfer-challenge", async (req, res) => {
  if (!requireApiKey(res)) return;
  const { userToken, walletId, destinationAddress, amount, tokenAddress } = req.body || {};
  if (!userToken || !walletId || !destinationAddress || !amount) {
    return res.status(400).json({ error: "Missing required fields." });
  }
  try {
    const body = {
      idempotencyKey: crypto.randomUUID(),
      walletId,
      destinationAddress,
      amounts: [String(amount)],
      feeLevel: "MEDIUM",
      blockchain: PRIMARY_BLOCKCHAIN,
    };
    // Only attach tokenAddress for ERC-20 sends (EURC/cirBTC). Native USDC
    // sends must omit it entirely, or Circle tries to resolve it as a token.
    if (tokenAddress) body.tokenAddress = tokenAddress;

    const response = await fetch(`${CIRCLE_BASE_URL}/v1/w3s/user/transactions/transfer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
        "X-User-Token": userToken,
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data.data); // { challengeId }
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to create transfer challenge." });
  }
});

/**
 * POST /api/circle/contract-execution-challenge
 *
 * Phase 2c: creates a Circle "contract execution" transaction challenge —
 * the generic path for calling an arbitrary function on an arbitrary
 * contract (mint / approve / lock / withdraw on the NFT + vault
 * contracts), as opposed to the token-transfer-specific challenge above.
 * Same execute-with-PIN flow on the frontend afterwards.
 *
 * NOTE: this hasn't been exercised against a live Circle account from this
 * environment (no network path to api.circle.com from the sandbox) — the
 * request shape mirrors Circle's documented contractExecution endpoint,
 * but treat the first real call as a live test and check the response
 * body closely if it 4xxs.
 */
router.post("/circle/contract-execution-challenge", async (req, res) => {
  if (!requireApiKey(res)) return;
  const { userToken, walletId, contractAddress, abiFunctionSignature, abiParameters } = req.body || {};
  if (!userToken || !walletId || !contractAddress || !abiFunctionSignature) {
    return res.status(400).json({ error: "Missing required fields." });
  }
  try {
    const response = await fetch(`${CIRCLE_BASE_URL}/v1/w3s/user/transactions/contractExecution`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
        "X-User-Token": userToken,
      },
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        walletId,
        contractAddress,
        abiFunctionSignature,
        abiParameters: abiParameters || [],
        feeLevel: "MEDIUM",
        blockchain: PRIMARY_BLOCKCHAIN,
      }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data.data); // { challengeId }
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to create contract execution challenge." });
  }
});

/**
 * GET /api/circle/transaction
 *
 * Phase 2c support: after a contract-execution challenge is approved via
 * the Web SDK, we only get a local "it succeeded" callback — not the
 * resulting txHash. Circle's own transaction list is how the frontend
 * finds the matching transaction afterwards (filtered + sorted client
 * side by contractAddress/createDate) so it can then read the on-chain
 * receipt directly via a plain RPC call and parse logs (tokenId minted,
 * lockId created, etc.) the same way it already does for MetaMask users.
 */
router.get("/circle/transactions", async (req, res) => {
  if (!requireApiKey(res)) return;
  const userToken = req.query.userToken;
  if (!userToken) return res.status(400).json({ error: "Missing userToken." });
  try {
    const response = await fetch(`${CIRCLE_BASE_URL}/v1/w3s/transactions?pageSize=10`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
        "X-User-Token": userToken,
      },
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data.data); // { transactions: [...] }
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to list transactions." });
  }
});

export default router;
