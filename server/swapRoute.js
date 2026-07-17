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
import { AppKit } from "@circle-fin/app-kit"; // adjust to actual package name/version you install
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";

const router = express.Router();

const kit = new AppKit({
  // developerFee / other global config can go here if you want to monetize swaps
});

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
      if (!isRateLimited || attempt === retries) throw e;
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
