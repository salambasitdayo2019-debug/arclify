# Arclify

**A stablecoin-native DeFi dashboard, built on Arc Testnet.**

Transfer, swap, bridge, lend, and lock — behind one login, with full feature parity whether you connect with MetaMask/WalletConnect or sign in with just an email and a PIN.

🔗 **Live app:** [arclify-ab66-eight.vercel.app](https://arclify-ab66-eight.vercel.app)
🔗 **Backend:** [arclify-backend.onrender.com](https://arclify-backend.onrender.com)

---

## What this is

Arclify unifies four distinct Circle products — App Kit, User-Controlled Wallets, CCTP, and the USDC/EURC stablecoin suite — into one coherent app on Arc, Circle's stablecoin-native Layer 1. Rather than treating USDC as "just another ERC-20," Arclify handles it as what it actually is on Arc: the chain's native currency, which shapes how transfers, collateral, and swaps are all built under the hood.

## Features

| Feature | What it does |
|---|---|
| **Deposit** | Fund your wallet with Naira via a real Paystack checkout (test mode), converted to USDC/EURC and credited on-chain by a treasury wallet. KES/GHS use a simulated flow. |
| **Withdraw** | Cash out USDC/EURC — your tokens genuinely leave your wallet on-chain; the fiat payout leg is a clearly-labeled prototype (real settlement needs a licensed partner like HoneyCoin, Eversend, or Quidax). |
| **Transfer / Bulk Transfer** | Native USDC, EURC, and cirBTC — single or batched sends. |
| **Swap** | Server-side token swaps via Circle App Kit, routed through on-chain liquidity, with a live Fast Transfer fee lookup. |
| **Bridge** | Real CCTP burn-and-mint from Ethereum Sepolia, Base Sepolia, or Avalanche Fuji into Arc — not a wrapped asset. Works for both MetaMask and Circle Wallet users. |
| **Lending** | Deposit USDC as collateral, borrow EURC against it — a custom Solidity contract, deployed and verified. |
| **NFT Lock** | Mint a test NFT, time-lock it in a vault, with a background watcher that detects unlocks automatically. |
| **Activity Centre** | A persistent, filterable feed of everything that's happened across the app. |

## Wallet support

Two fully independent sign-in paths, with identical feature access:

- **MetaMask / WalletConnect** — standard injected/EIP-6963 wallet discovery, self-custodied.
- **Circle User-Controlled Wallets** — email + PIN, no seed phrase. Every action is a PIN-confirmed challenge through Circle's Web SDK instead of a browser wallet popup.

## Deployed contracts (Arc Testnet)

All hand-written, deployed via Remix, verified via Sourcify.

| Contract | Address | Purpose |
|---|---|---|
| `ArclifyTestNFT` | `0x7A239844c124666d1f5fD1fCeecB3BFB0824049F` | ERC-721 test collection — free mint, feeds NFT Lock |
| `ArclifyNFTLock` | `0x11F202F8A2aE3784C0aE234da1FB405BF9FC4162` | Time-lock vault for NFTs |
| `ArclifyLendingPool` | `0x63F38a7cf59BcC8FBaB11D4F84747ae0b9357267` | USDC-collateral / EURC-borrow lending market |

## Tech stack

- **Frontend:** React + Vite, Tailwind CSS, ethers.js v6 — deployed on Vercel
- **Backend:** Express.js — deployed on Render
- **Smart contracts:** Solidity, deployed via Remix IDE
- **Circle products:** App Kit (Swap), User-Controlled Wallets, CCTP (Bridge)
- **Payments:** Paystack (Deposit's Naira on-ramp)

## Known limitations

This is a testnet project — a few things are explicit, documented simplifications rather than oversights:

- Swap's signer wallet is a single shared hot wallet with no per-user spend limit.
- Lending's exchange rate is fixed and owner-set, not a live oracle; liquidity suppliers don't yet earn individual yield.
- Bridge's Circle Wallet support covers all three source chains; the deposit treasury and Paystack integration are scoped to demo/test-mode use.
- Nothing here has been professionally audited. No real funds should touch this app.

## Credits

Built by Salam Basit — [@callmebashrc](https://x.com/callmebashrc) · Discord: bash039630
