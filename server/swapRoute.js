/**
 * server/swapRoute.js
 *
 * Server-side Circle App Kit Swap integration for Arclify.
 *
 * Swap MUST run server-side: it requires a Kit Key, which must never be
 * exposed to the browser. This file wires the two endpoints the SwapPage
 * in ArcTestnetDApp.jsx calls: POST /api/estimate-swap and POST /api/swap.
 *
 * Env vars required (put these in .env, never commit them):
 *   KIT_KEY              - Circle Console App Kit key
 *   SWAP_SIGNER_PRIVATE_KEY - private key for the server-side signing wallet
 *                             (use a dedicated hot wallet, not your treasury key)
 */

import express from "express";
import { ethers } from "ethers";
import { AppKit } from "@circle-fin/app-kit"; // adjust to actual package name/version you install
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";

const router = express.Router();

const kit = new AppKit({
  // developerFee / other global config can go here if you want to monetize swaps
});

// Only what's needed to read the signer's own public balances — no signing
// capability here, this is a completely separate, read-only provider.
const ARC_RPC_URL = "https://rpc.testnet.arc.network";
const EURC_ADDRESS = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";
const ERC20_BALANCE_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];
const LOW_BALANCE_THRESHOLD = Number(process.env.SWAP_LOW_BALANCE_THRESHOLD || 5);

async function getServerAdapter() {
  return createViemAdapterFromPrivateKey({
    privateKey: process.env.SWAP_SIGNER_PRIVATE_KEY,
  });
}

/**
 * Arc Testnet's public RPC rate-limits aggressively under load. Circle's
 * App Kit (via viem) polls it internally while waiting for a transaction
 * receipt, and that poll can get rate-limited mid-swap even though the
 * swap itself went through on-chain. Retrying the whole call is safe here
 * because kit.swap/waitForSwap are idempotent status checks, not re-sends.
 */
async function withRpcRetry(fn, { retries = 4, baseDelayMs = 1200 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const isRateLimited =
        /request limit reached/i.test(e?.message || "") ||
        /rate limit/i.test(e?.message || "") ||
        e?.code === -32005;
      // Broader net: App Kit/viem can also surface Arc's flakiness as a
      // generic connectivity failure rather than an explicit rate-limit
      // message — e.g. "Network connection failed for Arc Testnet". These
      // read like hard errors but are the same underlying congested-RPC
      // problem seen elsewhere in this project, just phrased differently
      // by whichever layer (viem vs the raw JSON-RPC client) surfaces it.
      const isConnectivityFailure =
        /network connection failed/i.test(e?.message || "") ||
        /timeout/i.test(e?.message || "") ||
        /econnreset|econnrefused|etimedout/i.test(e?.message || e?.code || "");
      if ((!isRateLimited && !isConnectivityFailure) || attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, baseDelayMs * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * POST /api/estimate-swap
 * body: { chain, tokenIn, tokenOut, amountIn, slippageBps, walletAddress }
 */
router.post("/estimate-swap", async (req, res) => {
  const { chain, tokenIn, tokenOut, amountIn, slippageBps } = req.body;
  try {
    const adapter = await getServerAdapter();
    const estimate = await kit.estimateSwap({
      from: { adapter, chain },
      tokenIn,
      tokenOut,
      amountIn,
      slippageBps: slippageBps || 300,
      config: { kitKey: process.env.KIT_KEY },
    });
    res.json(estimate);
  } catch (err) {
    // Thin testnet liquidity is the most common cause of a failed estimate.
    res.status(400).json({ error: err.message || "Estimate failed" });
  }
});

/**
 * POST /api/swap
 * body: { chain, tokenIn, tokenOut, amountIn, slippageBps, walletAddress }
 *
 * Note: this example sends output back to the same server-side wallet
 * (`from.adapter`). If you want the swapped tokens to land in the
 * connected user's own wallet instead, set `to.recipientAddress` to
 * `walletAddress` from the request body.
 */
router.post("/swap", async (req, res) => {
  const { chain, tokenIn, tokenOut, amountIn, slippageBps, walletAddress } = req.body;
  try {
    const adapter = await getServerAdapter();
    const result = await withRpcRetry(() =>
      kit.swap({
        from: { adapter, chain },
        tokenIn,
        tokenOut,
        amountIn,
        slippageBps: slippageBps || 300,
        to: walletAddress ? { recipientAddress: walletAddress } : undefined,
        config: { kitKey: process.env.KIT_KEY },
      })
    );

    // Cross-chain swaps settle asynchronously — poll to a terminal state
    // before reporting back. Same-chain swaps are already terminal here.
    const final = chain !== "Arc_Testnet"
      ? await withRpcRetry(() => kit.waitForSwap({ result, kitKey: process.env.KIT_KEY }))
      : result;

    res.json({
      status: final.status || "DONE",
      estimatedOutput: final.estimatedOutput,
      steps: final.steps,
    });
  } catch (err) {
    const rateLimited = /request limit reached/i.test(err?.message || "");
    res.status(400).json({
      error: rateLimited
        ? "The network was briefly overloaded confirming this swap. Your swap may have still gone through — check your balance or the block explorer before retrying to avoid a duplicate."
        : err.message || "Swap failed",
    });
  }
});

export default router;

/**
 * GET /api/swap/signer-status
 *
 * Reports the swap signer wallet's PUBLIC address and current USDC/EURC
 * balances so the frontend can warn users before they hit a failed swap
 * due to thin liquidity — without ever exposing the private key itself.
 * Deriving the address from the private key is safe (that's the whole
 * point of a public/private keypair); only the key itself is secret.
 */
router.get("/swap/signer-status", async (req, res) => {
  if (!process.env.SWAP_SIGNER_PRIVATE_KEY) {
    return res.status(500).json({ error: "Signer wallet is not configured." });
  }
  try {
    const provider = new ethers.JsonRpcProvider(ARC_RPC_URL);
    const signerAddress = new ethers.Wallet(process.env.SWAP_SIGNER_PRIVATE_KEY).address;
    const eurc = new ethers.Contract(EURC_ADDRESS, ERC20_BALANCE_ABI, provider);

    const nativeBalRaw = await provider.getBalance(signerAddress);
    const eurcBalRaw = await eurc.balanceOf(signerAddress);

    const usdc = Number(ethers.formatUnits(nativeBalRaw, 18)); // native currency uses 18-decimal raw units
    const eurcBal = Number(ethers.formatUnits(eurcBalRaw, 6));

    res.json({
      address: signerAddress,
      usdc,
      eurc: eurcBal,
      lowBalance: usdc < LOW_BALANCE_THRESHOLD || eurcBal < LOW_BALANCE_THRESHOLD,
      threshold: LOW_BALANCE_THRESHOLD,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not check signer balance." });
  }
});
