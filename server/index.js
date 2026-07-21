/**
 * server/index.js
 *
 * Express entrypoint for Arclify's backend. Hosts Circle App Kit Swap
 * (POST /api/estimate-swap, POST /api/swap), wallet sign-in, Circle
 * Wallets (email/PIN), and a thin CCTP attestation proxy for Bridge.
 *
 * Send stays entirely client-side using the connected wallet directly —
 * no backend involvement needed there. Bridge's actual transactions are
 * also signed client-side; the backend only proxies Circle's Iris
 * attestation polling (see bridgeRoute.js for why).
 */

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import swapRoute from "./swapRoute.js";
import authRoute from "./authRoute.js";
import circleWalletsRoute from "./circleWalletsRoute.js";
import bridgeRoute from "./bridgeRoute.js";

dotenv.config();

const requiredEnvVars = ["KIT_KEY", "SWAP_SIGNER_PRIVATE_KEY"];
const missing = requiredEnvVars.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.warn(
    `Warning: missing env vars (${missing.join(", ")}). Swap endpoints will fail until these are set in .env.`
  );
}
if (!process.env.JWT_SECRET) {
  console.warn(
    "Warning: JWT_SECRET is not set. Wallet sign-in (/api/auth/*) will fail until it's set in .env."
  );
}
if (!process.env.CIRCLE_API_KEY) {
  console.warn(
    "Warning: CIRCLE_API_KEY is not set. Circle Wallets sign-in (/api/circle/*) will fail until it's set in .env."
  );
}

const app = express();

app.use(cors()); // tighten this to your actual frontend origin before production
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api", swapRoute);
app.use("/api", authRoute);
app.use("/api", circleWalletsRoute);
app.use("/api", bridgeRoute);

// Fallback error handler so a thrown error doesn't crash the process
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Arclify backend running on http://localhost:${PORT}`);
});
