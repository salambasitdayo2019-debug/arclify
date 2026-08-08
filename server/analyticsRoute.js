/**
 * server/analyticsRoute.js
 *
 * Logs each successful login to a Google Sheet, since Arclify has no
 * database — every other piece of state in this app either lives
 * on-chain or in the user's own browser localStorage, but "who's
 * signing in" needs to be visible to the app's owner specifically, not
 * the person using it.
 *
 * Uses a Google Apps Script Web App as a free, zero-infrastructure
 * webhook target — a spreadsheet the developer can just open and read,
 * rather than standing up a real database for one small feature. See
 * the setup instructions accompanying this file for how to create it.
 *
 * If GOOGLE_SHEETS_WEBHOOK_URL isn't set, this silently no-ops rather
 * than failing login itself — seeing who logged in is a nice-to-have
 * for the app owner, not something that should ever block a user from
 * actually signing in.
 */

import express from "express";

const router = express.Router();

router.post("/analytics/log-login", async (req, res) => {
  const { address, walletType } = req.body || {};
  console.log(`[analytics] /log-login hit — address=${address} walletType=${walletType}`);

  if (!address || !walletType) {
    console.log("[analytics] rejected — missing address or walletType");
    return res.status(400).json({ error: "Missing address or walletType." });
  }

  // No webhook configured yet — don't error, just skip logging.
  if (!process.env.GOOGLE_SHEETS_WEBHOOK_URL) {
    console.log("[analytics] GOOGLE_SHEETS_WEBHOOK_URL is not set — skipping.");
    return res.json({ logged: false });
  }

  try {
    const webhookRes = await fetch(process.env.GOOGLE_SHEETS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address,
        walletType, // "injected" | "walletconnect" | "circle"
        timestamp: new Date().toISOString(), // server-side clock — never trust a client-supplied timestamp
        userAgent: req.headers["user-agent"] || "",
      }),
    });
    const bodyText = await webhookRes.text();
    console.log(`[analytics] webhook responded ${webhookRes.status}: ${bodyText.slice(0, 200)}`);
    res.json({ logged: true });
  } catch (err) {
    // Logging failing shouldn't surface as an error to the user — this
    // is purely for the app owner's visibility, not user-facing.
    console.error("[analytics] Failed to log login event:", err.message);
    res.json({ logged: false });
  }
});

export default router;
