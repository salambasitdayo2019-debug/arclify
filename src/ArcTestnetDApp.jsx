import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ethers } from "ethers";
import QRCode from "qrcode";
import { W3SSdk } from "@circle-fin/w3s-pw-web-sdk";
import { useInjectedWallets } from "./wallet/eip6963";
import { getWalletConnectProvider } from "./wallet/walletConnectProvider";

/* ------------------------------------------------------------------ */
/*  Error boundary — catches render-time errors anywhere in the app     */
/*  and shows a recoverable screen instead of a blank white page. Has   */
/*  to be a class component; React doesn't offer a hook for this.       */
/* ------------------------------------------------------------------ */

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error("Arclify crashed:", error, info);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        data-theme={typeof window !== "undefined" ? localStorage.getItem("arc_theme") || "dark" : "dark"}
        className="min-h-screen flex items-center justify-center p-6 bg-[var(--bg-base)] bg-[radial-gradient(circle_at_20%_0%,var(--bg-grad-1),transparent_45%),radial-gradient(circle_at_80%_100%,var(--bg-grad-2),transparent_40%)]"
      >
        <div className="max-w-md w-full rounded-2xl border border-[var(--border)] bg-[var(--surface-subtle)] backdrop-blur-xl p-8 text-center">
          <img src="/favicon.svg" alt="Arclify" className="w-10 h-10 mx-auto mb-4" />
          <h1 className="text-[var(--text-primary)] text-lg font-semibold mb-2">Something went wrong</h1>
          <p className="text-[var(--text-secondary)] text-sm mb-6">
            Arclify hit an unexpected error. Reloading usually fixes it — if it keeps happening, the error is logged in your browser console.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-5 py-2.5 rounded-xl font-medium text-sm bg-gradient-to-r from-cyan-500 to-purple-600 text-white hover:brightness-110 transition"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Arc Testnet config                                                 */
/* ------------------------------------------------------------------ */

const ARC_TESTNET = {
  chainIdHex: "0x4CEF52", // 5042002
  chainId: 5042002,
  chainName: "Arc Testnet",
  // MetaMask (and other wallets) strictly require nativeCurrency.decimals
  // to be 18 for any chain registered via wallet_addEthereumChain — this
  // isn't optional metadata, it's enforced validation. This also matches
  // the raw balance math we verified directly against Arc Testnet: even
  // though Arc's own docs describe USDC as "6 decimals" at a conceptual
  // level, eth_getBalance still returns standard 18-decimal wei units.
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: ["https://rpc.testnet.arc.network"],
  blockExplorerUrls: ["https://testnet.arcscan.app"],
};

const CONTRACTS = {
  USDC: "0x3600000000000000000000000000000000000000", // Arc's optional ERC-20 interface for native USDC — not used elsewhere in the app (Transfer/Dashboard use native currency directly), but this is exactly what Lending needs since it treats collateral as a plain ERC-20
  EURC: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
  cirBTC: "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF",
};

const LENDING_POOL_ADDRESS = "0x63F38a7cf59BcC8FBaB11D4F84747ae0b9357267";

// ArclifyUSD (aUSD) — a USDC-collateralized testnet stablecoin. Deposit
// USDC, mint aUSD 1:1; burn aUSD, get USDC back 1:1. Uses the same USDC
// ERC-20 interface (CONTRACTS.USDC) Lending already treats as collateral.
const ARCLIFY_USD_ADDRESS = "0xFA9b703d1EE9d7E5D6203A94137c2e3CbBeeB201";
const ARCLIFY_USD_ABI = [
  "function mint(uint256 amount)",
  "function redeem(uint256 amount)",
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function collateralBalance() view returns (uint256)",
];

// Circle stablecoins (USDC, EURC) always use 6 decimals — hardcoding this
// avoids an extra RPC round trip per token, which matters on Arc Testnet's
// rate-limited public RPC. cirBTC follows standard Bitcoin/WBTC precision
// (8 decimals), same as Circle's own reference docs.
const STABLECOIN_DECIMALS = 6;
const CIRBTC_DECIMALS = 8;
const TOKEN_DECIMALS = { EURC: STABLECOIN_DECIMALS, cirBTC: CIRBTC_DECIMALS };

// How far back to scan for on-chain Transfer events. Arc Testnet's public
// RPC both rate-limits and caps how wide a single eth_getLogs range can be,
// so History/Leaderboard show "recent activity" rather than all-time —
// there's no indexer behind this app to make an all-time view cheap.
const RECENT_BLOCK_WINDOW = 8000;

// IMPORTANT: ARC_TESTNET.nativeCurrency.decimals (6) is metadata used only
// when registering the chain with a wallet (wallet_addEthereumChain) — it's
// what MetaMask shows as a label. The actual raw balance returned by
// eth_getBalance / provider.getBalance still follows the standard EVM
// convention of 18 decimals, same as every other chain. Using 6 here would
// inflate every native-currency amount by 10^12.
const NATIVE_BALANCE_DECIMALS = 18;

/**
 * Retries a Promise-returning RPC call with backoff when the node responds
 * with a rate-limit error (seen on Arc Testnet's public RPC as JSON-RPC
 * code -32005). Any other error is thrown immediately — we only want to
 * absorb "you're going too fast," not mask real failures.
 */
// Fires on every successful login, both wallet types — best-effort, never
// blocks or fails the actual login if either destination is unreachable.
// Two destinations, two different questions: the backend log (a Google
// Sheet, since there's no database) answers "who, specifically, signed
// in" — GA4 answers "how much traffic is this getting, in aggregate."
function logLoginEvent(address, walletType) {
  fetch(`${API_BASE}/analytics/log-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, walletType }),
  }).catch(() => {});
  window.gtag?.("event", "login", { method: walletType });
}

async function withRpcRetry(fn, { retries = 5, baseDelayMs = 900 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const isRateLimited =
        e?.code === -32005 ||
        e?.error?.code === -32005 ||
        /rate limit/i.test(e?.message || "") ||
        /rate limit/i.test(e?.error?.message || "");
      // A genuine contract revert always carries either a reason string
      // or revert data. When BOTH come back null on a call to a plain
      // getter with no require()/revert() in it at all (like a public
      // state variable), that's not a real revert — it's Arc's RPC
      // returning a garbled response under load, which ethers can only
      // report as a generic CALL_EXCEPTION since it has nothing else to
      // go on. Worth retrying rather than trusting it as a real failure.
      const isGarbledCallException =
        e?.code === "CALL_EXCEPTION" && e?.data == null && e?.reason == null;
      if ((!isRateLimited && !isGarbledCallException) || attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, baseDelayMs * (attempt + 1)));
    }
  }
  throw lastErr;
}

// Circle-wallet users have no ethers.js provider (Circle holds the signing
// keyshare, not the browser) — this plain read-only RPC provider lets us
// still read on-chain state (lock status, receipts/logs after a Circle
// contract-execution transaction) the same way for both wallet types.
const readOnlyProvider = new ethers.JsonRpcProvider(ARC_TESTNET.rpcUrls[0]);

const API_BASE = import.meta?.env?.VITE_SWAP_API_BASE || "/api";
const SESSION_STORAGE_KEY = "arclify_session";
const CIRCLE_SESSION_STORAGE_KEY = "arclify_circle_session";
const CIRCLE_APP_ID = import.meta?.env?.VITE_CIRCLE_APP_ID;

// USDC is Arc Testnet's native currency (like ETH on mainnet) — it does NOT
// live at an ERC-20 contract address, so balances/sends for it must go
// through the standard native-balance / native-transfer paths, not
// ERC20_ABI calls. EURC is a real ERC-20 token and uses the normal path.
const NATIVE_TOKEN_SYMBOL = ARC_TESTNET.nativeCurrency.symbol; // "USDC"

// Tokens actually swappable on Arc Testnet (thin liquidity — see App Kit FAQ)
const SWAP_SUPPORTED_TESTNET_TOKENS = ["USDC", "EURC", "cirBTC"];

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

/* ------------------------------------------------------------------ */
/*  NFT Lock contracts — deployed to Arc Testnet via Remix              */
/* ------------------------------------------------------------------ */

const NFT_CONTRACT_ADDRESS = "0x7A239844c124666d1f5fD1fCeecB3BFB0824049F";
const NFT_LOCK_VAULT_ADDRESS = "0x11F202F8A2aE3784C0aE234da1FB405BF9FC4162";

const NFT_ABI = [
  "function mint() returns (uint256)",
  "function approve(address to, uint256 tokenId)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
];

const NFT_LOCK_ABI = [
  "function lock(address nftContract, uint256 tokenId, uint256 unlockAt) returns (uint256)",
  "function withdraw(uint256 lockId)",
  "function getLock(uint256 lockId) view returns (address owner, address nftContract, uint256 tokenId, uint256 unlockAt, bool withdrawn, bool canWithdraw)",
  "event Locked(uint256 indexed lockId, address indexed owner, address nftContract, uint256 tokenId, uint256 unlockAt)",
];

// Shared between NFTLockPage's manual "Withdraw" button and the app-level
// auto-watch notification's "Withdraw now" toast action, so both paths
// stay in sync rather than drifting into two slightly different
// implementations over time.
async function performLockWithdraw(wallet, lockId) {
  if (wallet.isCircleWallet) {
    await wallet.circleExecuteContract({
      contractAddress: NFT_LOCK_VAULT_ADDRESS,
      abiFunctionSignature: "withdraw(uint256)",
      abiParameters: [String(lockId)],
    });
  } else {
    const signer = await wallet.provider.getSigner();
    const vault = new ethers.Contract(NFT_LOCK_VAULT_ADDRESS, NFT_LOCK_ABI, signer);
    const tx = await withRpcRetry(() => vault.withdraw(lockId));
    await withRpcRetry(() => tx.wait());
  }
}

/* ------------------------------------------------------------------ */
/*  Lending — ArclifyLendingPool.sol, deployed via Remix               */
/*  Deposit USDC (via Arc's ERC-20 interface) as collateral, borrow    */
/*  EURC against it. Fixed exchange rate + fixed interest rate (not a  */
/*  live oracle or utilization curve) — see the contract's own header  */
/*  comment for the full reasoning behind each simplification.         */
/* ------------------------------------------------------------------ */

const LENDING_ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
];

const LENDING_POOL_ABI = [
  "function depositCollateral(uint256 amount)",
  "function withdrawCollateral(uint256 amount)",
  "function borrow(uint256 amount)",
  "function repay(uint256 amount)",
  "function fundPool(uint256 amount)",
  "function liquidate(address borrower)",
  "function isLiquidatable(address borrower) view returns (bool)",
  "function getCurrentDebt(address user) view returns (uint256)",
  "function getMaxBorrowable(address user) view returns (uint256)",
  "function usdcValueInEurc(uint256 usdcAmount) view returns (uint256)",
  "function availableLiquidity() view returns (uint256)",
  "function positions(address) view returns (uint256 collateralAmount, uint256 principal, uint256 lastAccrualTime)",
  "function exchangeRate() view returns (uint256)",
  "function collateralFactorBps() view returns (uint256)",
  "function liquidationThresholdBps() view returns (uint256)",
  "function interestRateBps() view returns (uint256)",
];

// Wallet-agnostic "approve token, then call the pool" — used by both
// depositCollateral (approve USDC) and repay (approve EURC). Mirrors the
// same two-step approve-then-act pattern NFT Lock's circleExecuteContract
// path already established.
async function lendingApproveAndCall(wallet, { tokenAddress, amountUnits, functionSignature, functionParams }) {
  if (wallet.isCircleWallet) {
    await wallet.circleExecuteContract({
      contractAddress: tokenAddress,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [LENDING_POOL_ADDRESS, String(amountUnits)],
    });
    await wallet.circleExecuteContract({
      contractAddress: LENDING_POOL_ADDRESS,
      abiFunctionSignature: functionSignature,
      abiParameters: functionParams.map(String),
    });
  } else {
    const signer = await wallet.provider.getSigner();
    const token = new ethers.Contract(tokenAddress, LENDING_ERC20_ABI, signer);
    const approveTx = await withRpcRetry(() => token.approve(LENDING_POOL_ADDRESS, amountUnits));
    await withRpcRetry(() => approveTx.wait());
    const pool = new ethers.Contract(LENDING_POOL_ADDRESS, LENDING_POOL_ABI, signer);
    const fnName = functionSignature.split("(")[0];
    const tx = await withRpcRetry(() => pool[fnName](...functionParams));
    await withRpcRetry(() => tx.wait());
  }
}

// For pool calls that don't need a prior approval (borrow, withdraw —
// the pool is sending TO the user, not pulling FROM them).
async function lendingCall(wallet, { functionSignature, functionParams }) {
  if (wallet.isCircleWallet) {
    await wallet.circleExecuteContract({
      contractAddress: LENDING_POOL_ADDRESS,
      abiFunctionSignature: functionSignature,
      abiParameters: functionParams.map(String),
    });
  } else {
    const signer = await wallet.provider.getSigner();
    const pool = new ethers.Contract(LENDING_POOL_ADDRESS, LENDING_POOL_ABI, signer);
    const fnName = functionSignature.split("(")[0];
    const tx = await withRpcRetry(() => pool[fnName](...functionParams));
    await withRpcRetry(() => tx.wait());
  }
}
/*   capability for NFT locks or leaderboards, so those stay custom.)  */
/* ------------------------------------------------------------------ */

// Deposit USDC, mint aUSD 1:1 — same two-step approve-then-call pattern
// Lending's depositCollateral already uses.
async function arclifyUsdMint(wallet, amountUnits) {
  if (wallet.isCircleWallet) {
    await wallet.circleExecuteContract({
      contractAddress: CONTRACTS.USDC,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [ARCLIFY_USD_ADDRESS, String(amountUnits)],
    });
    await wallet.circleExecuteContract({
      contractAddress: ARCLIFY_USD_ADDRESS,
      abiFunctionSignature: "mint(uint256)",
      abiParameters: [String(amountUnits)],
    });
  } else {
    const signer = await wallet.provider.getSigner();
    const usdc = new ethers.Contract(CONTRACTS.USDC, LENDING_ERC20_ABI, signer);
    const approveTx = await withRpcRetry(() => usdc.approve(ARCLIFY_USD_ADDRESS, amountUnits));
    await withRpcRetry(() => approveTx.wait());
    const ausd = new ethers.Contract(ARCLIFY_USD_ADDRESS, ARCLIFY_USD_ABI, signer);
    const tx = await withRpcRetry(() => ausd.mint(amountUnits));
    await withRpcRetry(() => tx.wait());
  }
}

// Burn aUSD, get USDC back — no approval needed here, since the
// contract is sending TO the user rather than pulling FROM them.
async function arclifyUsdRedeem(wallet, amountUnits) {
  if (wallet.isCircleWallet) {
    await wallet.circleExecuteContract({
      contractAddress: ARCLIFY_USD_ADDRESS,
      abiFunctionSignature: "redeem(uint256)",
      abiParameters: [String(amountUnits)],
    });
  } else {
    const signer = await wallet.provider.getSigner();
    const ausd = new ethers.Contract(ARCLIFY_USD_ADDRESS, ARCLIFY_USD_ABI, signer);
    const tx = await withRpcRetry(() => ausd.redeem(amountUnits));
    await withRpcRetry(() => tx.wait());
  }
}

const LS_KEYS = {
  txs: "arc_txs",
  bulk: "arc_bulk",
  nftLocks: "arc_nft_locks",
};

// Render's free tier spins down after inactivity and can take 50+ seconds
// to wake back up on the first request. Both session-restore checks below
// gate the ENTIRE app behind a full-screen "Loading…" state, so without a
// cap, a cold backend leaves the person staring at a blank screen with no
// way out except reloading — which just restarts the same slow wait.
// SESSION_CHECK_TIMEOUT_MS bounds that: if the check hasn't resolved in
// time, callers fall through to "couldn't verify right now" instead of
// hanging, and deliberately do NOT treat that as "session is invalid" —
// the stored session is left alone so a later, successful check can still
// log the person back in automatically.
const SESSION_CHECK_TIMEOUT_MS = 10000;
function withTimeout(promise, ms = SESSION_CHECK_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

function readLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeLS(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function pushTx(entry) {
  const txs = readLS(LS_KEYS.txs, []);
  txs.unshift({ id: crypto.randomUUID(), timestamp: Date.now(), ...entry });
  writeLS(LS_KEYS.txs, txs);
  return txs;
}

/* ------------------------------------------------------------------ */
/*  Wallet / adapter hook                                               */
/*  Builds a viem/ethers-style adapter straight from window.ethereum,   */
/*  matching App Kit's createEthersAdapterFromProvider pattern.         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Bridge — CCTP (Circle's Cross-Chain Transfer Protocol) config       */
/*  Scoped to Ethereum Sepolia -> Arc Testnet, the direction Circle's   */
/*  own quickstart documents end-to-end:                                */
/*  developers.circle.com/cctp/quickstarts/transfer-usdc-ethereum-to-arc*/
/* ------------------------------------------------------------------ */

const ARC_TESTNET_DOMAIN = 26;

// TokenMessengerV2 and MessageTransmitterV2 sit at the SAME address on
// every one of Circle's EVM CCTP v2 testnets (deterministic/CREATE2
// deployment) — confirmed against Circle's own @circle-fin/bridge-kit
// package, not assumed. That's what makes adding more source chains here
// mostly just new USDC addresses + domain IDs, not new contract logic.
const CCTP_TOKEN_MESSENGER = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA";
const CCTP_USDC_DECIMALS = 6; // standard ERC-20 USDC decimals — same across all these source chains, unlike Arc's native 18-decimal USDC

// One entry per supported Bridge source chain. Add more here later by
// copying an entry — domain IDs and USDC addresses per Circle's own docs
// and bridge-kit package.
const BRIDGE_SOURCE_CHAINS = {
  ETH_SEPOLIA: {
    label: "Ethereum Sepolia",
    domain: 0,
    usdc: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
    circleBlockchain: "ETH-SEPOLIA",
    chain: {
      chainIdHex: "0xaa36a7", // 11155111
      chainId: 11155111,
      chainName: "Ethereum Sepolia",
      nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://rpc.sepolia.org"],
      blockExplorerUrls: ["https://sepolia.etherscan.io"],
    },
  },
  BASE_SEPOLIA: {
    label: "Base Sepolia",
    domain: 6,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    circleBlockchain: "BASE-SEPOLIA",
    chain: {
      chainIdHex: "0x14a34", // 84532
      chainId: 84532,
      chainName: "Base Sepolia",
      nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://sepolia.base.org"],
      blockExplorerUrls: ["https://sepolia.basescan.org"],
    },
  },
  AVAX_FUJI: {
    label: "Avalanche Fuji",
    domain: 1,
    usdc: "0x5425890298aed601595a70AB815c96711a31Bc65",
    circleBlockchain: "AVAX-FUJI",
    chain: {
      chainIdHex: "0xa869", // 43113
      chainId: 43113,
      chainName: "Avalanche Fuji Testnet",
      nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
      rpcUrls: ["https://api.avax-test.network/ext/bc/C/rpc"],
      blockExplorerUrls: ["https://testnet.snowtrace.io"],
    },
  },
};

// Curated, not exhaustive — picked specifically because they don't gate
// on holding mainnet ETH (several faucets we hit while testing Bridge
// did, which is the exact friction this panel exists to avoid). Faucets
// change often; if one stops working, the others are real fallbacks.
const BRIDGE_GAS_FAUCETS = {
  ETH_SEPOLIA: [
    { name: "Google Cloud Web3 Faucet", url: "https://cloud.google.com/application/web3/faucet/ethereum/sepolia" },
    { name: "Alchemy Faucet", url: "https://www.alchemy.com/faucets/ethereum-sepolia" },
  ],
  BASE_SEPOLIA: [
    { name: "Coinbase Developer Platform Faucet", url: "https://portal.cdp.coinbase.com/products/faucet" },
    { name: "Alchemy Faucet", url: "https://www.alchemy.com/faucets/base-sepolia" },
  ],
  AVAX_FUJI: [
    { name: "Chainlink Faucet", url: "https://faucets.chain.link/fuji" },
    { name: "Core Wallet Faucet", url: "https://core.app/tools/testnet-faucet/?subnet=c&token=c" },
  ],
};

const CCTP = {
  ARC_TESTNET_DOMAIN,
  ARC_TESTNET_MESSAGE_TRANSMITTER: "0xe737e5cebeeba77efe34d4aa090756590b1ce275",
};

// Chain switching goes straight to window.ethereum, not through an ethers
// provider instance — ethers v6's BrowserProvider throws "network changed"
// if you later call getSigner() on an instance that saw a different chain
// earlier, so Bridge always builds a brand new BrowserProvider right after
// this resolves rather than reusing one across the switch.
async function switchViaEthereum(chainConfig) {
  if (!window.ethereum?.request) {
    throw new Error("No injected wallet found — Bridge needs MetaMask or a similar browser wallet.");
  }
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainConfig.chainIdHex }],
    });
  } catch (switchErr) {
    const code = switchErr?.code ?? switchErr?.error?.code ?? switchErr?.info?.error?.code;
    if (code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: chainConfig.chainIdHex,
            chainName: chainConfig.chainName,
            nativeCurrency: chainConfig.nativeCurrency,
            rpcUrls: chainConfig.rpcUrls,
            blockExplorerUrls: chainConfig.blockExplorerUrls,
          },
        ],
      });
    } else {
      throw switchErr;
    }
  }
}

async function switchToArc(rawProvider) {
  if (!rawProvider?.request) return;
  try {
    await rawProvider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: ARC_TESTNET.chainIdHex }],
    });
  } catch (switchErr) {
    // 4902 = chain not added yet
    if (switchErr.code === 4902) {
      await rawProvider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: ARC_TESTNET.chainIdHex,
            chainName: ARC_TESTNET.chainName,
            nativeCurrency: ARC_TESTNET.nativeCurrency,
            rpcUrls: ARC_TESTNET.rpcUrls,
            blockExplorerUrls: ARC_TESTNET.blockExplorerUrls,
          },
        ],
      });
    } else if (switchErr.code !== 4001) {
      // Some mobile wallets (via WalletConnect) don't support programmatic
      // chain switching at all — don't hard-fail the connection over it.
      console.warn("Could not switch network automatically:", switchErr);
    } else {
      throw switchErr;
    }
  }
}

/**
 * Any-wallet connection hook. Surfaces every EIP-6963 browser extension
 * wallet it can detect (MetaMask, Coinbase Wallet, Rabby, Brave, OKX,
 * Rainbow, Trust, etc.) plus a WalletConnect option for mobile wallets via
 * QR code. The returned shape matches the app's original single-wallet
 * hook so every page component below keeps working unmodified.
 */
function useWallet() {
  const injected = useInjectedWallets();
  const [rawProvider, setRawProvider] = useState(null);
  const [address, setAddress] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [provider, setProvider] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);
  const [qrUri, setQrUri] = useState(null);

  const connectors = useMemo(() => {
    const list = injected.map((p) => ({
      id: p.info.rdns || p.info.uuid,
      name: p.info.name,
      icon: p.info.icon,
      kind: "injected",
      raw: p.provider,
    }));
    list.push({
      id: "walletconnect",
      name: "WalletConnect (mobile / QR)",
      icon: "",
      kind: "walletconnect",
    });
    return list;
  }, [injected]);

  const disconnect = useCallback(() => {
    if (rawProvider?.disconnect) {
      try {
        rawProvider.disconnect();
      } catch {
        // ignore
      }
    }
    setRawProvider(null);
    setAddress(null);
    setProvider(null);
    setChainId(null);
  }, [rawProvider]);

  const connect = useCallback(
    async (connectorId, { silent = false } = {}) => {
      const target = connectors.find((c) => c.id === connectorId);
      if (!target) {
        if (!silent) setError("Choose a wallet to continue.");
        return null;
      }
      if (!silent) setConnecting(true);
      setError(null);
      try {
        let raw = target.raw;
        if (target.kind === "walletconnect") {
          if (silent) return null; // WalletConnect manages its own session restore
          raw = await getWalletConnectProvider();
          const onDisplayUri = (uri) => setQrUri(uri);
          raw.on("display_uri", onDisplayUri);
          try {
            await raw.connect();
          } finally {
            raw.removeListener?.("display_uri", onDisplayUri);
            setQrUri(null);
          }
        }
        // "any" tells ethers not to lock onto the network it saw first and
        // throw if it later changes — needed because Bridge legitimately
        // switches the wallet to Sepolia and back mid-flow. Also makes the
        // app more robust if someone manually switches networks in their
        // wallet while connected, instead of hard-erroring.
        const browserProvider = new ethers.BrowserProvider(raw, "any");
        let accounts;
        if (target.kind === "walletconnect") {
          accounts = raw.accounts;
        } else if (silent) {
          // eth_accounts never opens a popup — it just returns whatever
          // accounts this site is already authorized to see, or an empty
          // list if the wallet hasn't granted access (or was disconnected).
          accounts = await browserProvider.send("eth_accounts", []);
        } else {
          accounts = await browserProvider.send("eth_requestAccounts", []);
        }
        if (!accounts?.length) {
          if (silent) return null;
          throw new Error("No account returned by wallet.");
        }
        if (target.kind === "injected" && !silent) await switchToArc(raw);
        const network = await browserProvider.getNetwork();
        setRawProvider(raw);
        setProvider(browserProvider);
        setAddress(accounts[0]);
        setChainId(Number(network.chainId));
        return { address: accounts[0], browserProvider };
      } catch (e) {
        if (!silent) setError(e?.message || "Failed to connect wallet.");
        if (!silent) throw e;
        return null;
      } finally {
        if (!silent) setConnecting(false);
      }
    },
    [connectors]
  );

  useEffect(() => {
    if (!rawProvider?.on) return;
    const onAccountsChanged = (accounts) => {
      if (!accounts?.length) disconnect();
      else setAddress(accounts[0]);
    };
    const onChainChanged = (hex) =>
      setChainId(typeof hex === "string" ? parseInt(hex, 16) : Number(hex));
    rawProvider.on("accountsChanged", onAccountsChanged);
    rawProvider.on("chainChanged", onChainChanged);
    return () => {
      rawProvider.removeListener?.("accountsChanged", onAccountsChanged);
      rawProvider.removeListener?.("chainChanged", onChainChanged);
    };
  }, [rawProvider, disconnect]);

  return {
    address,
    chainId,
    provider,
    connecting,
    error,
    connectors,
    connect,
    disconnect,
    qrUri,
    isOnArc: chainId === ARC_TESTNET.chainId,
  };
}

/* ------------------------------------------------------------------ */
/*  Auth hook — SIWE-style signature login                             */
/*  Wallet CONNECTION just proves you hold the keys to sign; SIGNING    */
/*  a challenge nonce proves you actually control the account, which    */
/*  is what gates access to the app.                                    */
/* ------------------------------------------------------------------ */

function useAuth(wallet) {
  const [status, setStatus] = useState("checking"); // checking | loggedOut | authenticating | authenticated
  const [error, setError] = useState(null);
  const [sessionAddress, setSessionAddress] = useState(null);

  // `wallet` is a new object every render, and the mount-only effect below
  // captures it once. By the time the delayed silent-reconnect fires, the
  // wallet extensions have usually finished announcing themselves (EIP-6963)
  // and `wallet.connectors` has grown — but the captured closure wouldn't
  // see that update. Routing through a ref keeps it pointed at the latest
  // wallet object on every render, so the delayed call sees the current
  // connector list instead of the empty one from the very first render.
  const walletRef = useRef(wallet);
  walletRef.current = wallet;

  useEffect(() => {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) {
      setStatus("loggedOut");
      return;
    }
    let cancelled = false;
    (async () => {
      let timedOut = false;
      try {
        const { token, address, connectorId } = JSON.parse(raw);
        const res = await withTimeout(
          fetch(`${API_BASE}/auth/session`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        );
        if (!res.ok) throw new Error("expired");
        if (cancelled) return;
        setSessionAddress(address);
        setStatus("authenticated");

        // Session is valid, but the wallet itself isn't connected in this
        // tab yet (a page reload resets React state, not the wallet's own
        // permission grant). Give injected wallets a moment to announce
        // themselves via EIP-6963, then try a silent reconnect — this uses
        // eth_accounts, which never shows a popup, so it only succeeds if
        // the site is already authorized.
        if (connectorId) {
          setTimeout(async () => {
            if (cancelled) return;
            await walletRef.current.connect(connectorId, { silent: true });
          }, 800);
        }
      } catch (e) {
        timedOut = e?.message === "timeout";
        // A slow/cold-starting backend isn't the same as an invalid
        // session — only clear the stored session when the backend
        // actually told us it's expired, not when we simply couldn't
        // reach it in time.
        if (!timedOut) localStorage.removeItem(SESSION_STORAGE_KEY);
        if (!cancelled) setStatus("loggedOut");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(
    async (connectorId) => {
      setStatus("authenticating");
      setError(null);
      try {
        const connected = await wallet.connect(connectorId);
        if (!connected) throw new Error("Wallet connection failed.");
        const { address, browserProvider } = connected;

        const nonceRes = await fetch(
          `${API_BASE}/auth/nonce?address=${address}`
        );
        if (!nonceRes.ok) throw new Error("Could not start sign-in. Please try again.");
        const { message } = await nonceRes.json();

        const signer = await browserProvider.getSigner();
        const signature = await signer.signMessage(message);

        const verifyRes = await fetch(`${API_BASE}/auth/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address, signature }),
        });
        if (!verifyRes.ok) {
          const body = await verifyRes.json().catch(() => ({}));
          throw new Error(body.error || "Signature verification failed.");
        }
        const { token } = await verifyRes.json();

        localStorage.setItem(
          SESSION_STORAGE_KEY,
          JSON.stringify({ token, address, connectorId })
        );
        setSessionAddress(address);
        setStatus("authenticated");
        logLoginEvent(address, connectorId || "injected");
      } catch (e) {
        setError(
          e?.code === "ACTION_REJECTED" || e?.code === 4001
            ? "Signature request was rejected."
            : e?.message || "Sign-in failed. Please try again."
        );
        setStatus("loggedOut");
      }
    },
    [wallet]
  );

  const logout = useCallback(() => {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    wallet.disconnect();
    setSessionAddress(null);
    setStatus("loggedOut");
  }, [wallet]);

  return { status, error, sessionAddress, login, logout };
}

/* ------------------------------------------------------------------ */
/*  Circle User-Controlled Wallets — Phase 1 (email + PIN login,        */
/*  wallet creation, balance display). Transfer/Swap/NFT Lock for       */
/*  Circle-wallet users is Phase 2 — those actions need Circle's        */
/*  transaction-challenge system, not ethers.js signing, so the pages   */
/*  below show a "coming soon" state for this wallet type for now.      */
/* ------------------------------------------------------------------ */

function useCircleWallet() {
  const [status, setStatus] = useState("idle"); // idle | working | pinChallenge | ready | error
  // Synchronous check (no flicker): true only when a persisted session
  // genuinely exists, so the landing page never flashes for someone who's
  // actually still logged in — and stays false (no delay at all) for
  // everyone else, who never had a session to restore in the first place.
  const [restoringSession, setRestoringSession] = useState(
    () => typeof window !== "undefined" && !!localStorage.getItem(CIRCLE_SESSION_STORAGE_KEY)
  );
  const [error, setError] = useState(null);
  const [address, setAddress] = useState(null);
  const [walletId, setWalletId] = useState(null);
  const [walletsByChain, setWalletsByChain] = useState({});
  const [createDate, setCreateDate] = useState(null);
  const [balance, setBalance] = useState(null);
  const [balances, setBalances] = useState({ USDC: "0", EURC: "0", cirBTC: "0" });
  const sdkRef = useRef(null);
  const deviceIdRef = useRef(null);
  const sessionRef = useRef(null); // { userId, userToken, encryptionKey }

  // Initialize the SDK and pre-fetch its deviceId as soon as this hook
  // mounts, not lazily on click. Circle's own reference implementation
  // does this on page load via a "sdkReady" flag — calling getDeviceId()
  // immediately after construction (same tick) is what was causing
  // "Failed to receive deviceId", since the SDK's internal channel needs
  // a moment to finish setting up first.
  useEffect(() => {
    if (!CIRCLE_APP_ID) return;
    let cancelled = false;
    try {
      sdkRef.current = new W3SSdk({ appSettings: { appId: CIRCLE_APP_ID } });
    } catch (e) {
      console.error("Failed to initialize Circle Web SDK:", e);
      return;
    }
    sdkRef.current
      .getDeviceId()
      .then((id) => {
        if (!cancelled) deviceIdRef.current = id;
      })
      .catch((e) => {
        console.error("Failed to pre-fetch Circle deviceId:", e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Circle's iframe reports many *recoverable* in-flow validation issues
  // (e.g. "hint can't be the same as the answer", a PIN typo with retries
  // left) through the same onError channel it uses for genuinely fatal
  // ones — and critically, Circle's own SDK does NOT close its iframe for
  // the recoverable kind (confirmed in @circle-fin/w3s-pw-web-sdk's
  // messageHandler: the onError branch never calls closeModal(), only
  // onClose/onComplete do). The iframe stays open, showing the message
  // itself, expecting the user to just fix the input and continue.
  // Treating every onError as fatal — resetting our own status and
  // showing our own error banner — fights the still-open iframe sitting
  // right in front of the user and leaves a stray error message stuck on
  // the page after the user moves on. Only these codes mean the challenge
  // is actually dead on Circle's side; anything else, we just log and let
  // the iframe do its job.
  const CIRCLE_TERMINAL_ERROR_CODES = new Set([
    3, // forbidden
    4, // unauthorized
    12, // invalidSession
    155104, // userTokenExpired
    155105, // invalidUserToken
    155116, // invalidChallengeId
    155119, // userPinLocked
    155120, // securityAnswersLocked
  ]);
  const isTerminalCircleError = (err) => !!err && CIRCLE_TERMINAL_ERROR_CODES.has(err.code);

  const getSdk = useCallback(() => {
    if (!sdkRef.current) {
      sdkRef.current = new W3SSdk({ appSettings: { appId: CIRCLE_APP_ID } });
    }
    return sdkRef.current;
  }, []);  const loadWalletAndBalance = useCallback(async (userToken) => {
    const walletsRes = await fetch(`${API_BASE}/circle/wallets?userToken=${encodeURIComponent(userToken)}`);
    if (!walletsRes.ok) throw new Error("Could not load wallet.");
    const { wallets } = await walletsRes.json();
    // Now that a user can hold wallets on more than just Arc (see Bridge),
    // index [0] is no longer a safe way to find "the Arc wallet" — has to
    // be found explicitly by blockchain.
    const byChain = Object.fromEntries((wallets || []).map((w) => [w.blockchain, w]));
    setWalletsByChain(byChain);
    const primary = byChain["ARC-TESTNET"];
    if (!primary) return null;
    setAddress(primary.address);
    setWalletId(primary.id);
    setCreateDate(primary.createDate || null); // ISO-8601, straight from Circle's wallet object

    const balRes = await fetch(`${API_BASE}/circle/balance?userToken=${encodeURIComponent(userToken)}&walletId=${primary.id}`);
    if (balRes.ok) {
      const { tokenBalances } = await balRes.json();
      // Circle's wallet-balance endpoint already returns every token this
      // wallet holds, not just USDC — we were just throwing the rest away.
      // Match by symbol so EURC/cirBTC show up too, same source of truth
      // (Circle's own balance API) as before.
      const findAmt = (matcher) =>
        tokenBalances?.find((t) => matcher((t.token?.symbol || "").toUpperCase()))?.amount ?? "0";
      const usdcAmt = findAmt((s) => s.startsWith("USDC"));
      setBalance(usdcAmt);
      setBalances({
        USDC: usdcAmt,
        EURC: findAmt((s) => s.startsWith("EURC")),
        cirBTC: findAmt((s) => s.includes("BTC")),
      });
    }
    return primary;
  }, []);

  // Provisions a wallet for this same Circle user on an ADDITIONAL
  // blockchain (e.g. ETH-SEPOLIA for Bridge) — same challenge->PIN
  // pattern as everything else, then refreshes the wallet list so the
  // newly created wallet shows up in walletsByChain.
  const createWalletOnChain = useCallback(async (blockchain) => {
    if (!sessionRef.current) throw new Error("Not signed in with a Circle wallet.");
    const { userToken, encryptionKey } = sessionRef.current;

    const res = await fetch(`${API_BASE}/circle/create-wallet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userToken, blockchain }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || body.message || "Could not create wallet.");
    }
    const { challengeId } = await res.json();

    const sdk = getSdk();
    if (!deviceIdRef.current) {
      deviceIdRef.current = await sdk.getDeviceId();
    }
    sdk.setAuthentication({ userToken, encryptionKey });

    await new Promise((resolve, reject) => {
      sdk.execute(challengeId, (err) => {
        if (err) {
          if (isTerminalCircleError(err)) {
            reject(new Error(err?.message || "Wallet setup was cancelled or failed."));
          } else {
            // Recoverable in-iframe validation nudge — Circle's modal is
            // still open showing it; nothing for us to do here.
            console.warn("Circle wallet-setup challenge (recoverable):", err);
          }
          return;
        }
        resolve();
      });
    });

    await loadWalletAndBalance(userToken);
  }, [getSdk, loadWalletAndBalance]);

  // Restore session on page load
  useEffect(() => {
    const raw = localStorage.getItem(CIRCLE_SESSION_STORAGE_KEY);
    if (!raw) return;
    try {
      const session = JSON.parse(raw);
      sessionRef.current = session;
      setStatus("working");
      withTimeout(loadWalletAndBalance(session.userToken))
        .then((w) => {
          setStatus(w ? "ready" : "idle");
          setRestoringSession(false);
          // Session restore bypasses loginWithEmail entirely, so without this
          // a restored session never shows up in the login log — tagged
          // "circle-restore" (not "circle") so it's easy to tell apart from
          // a genuine fresh sign-in in the sheet/GA4.
          if (w) logLoginEvent(w.address, "circle-restore");
        })
        .catch((e) => {
          // A slow/cold-starting backend isn't the same as an invalid
          // session — only clear the stored session on a real failure,
          // not because the check simply didn't finish in time. Leaving
          // it in place means the *next* reload can still restore it
          // once the backend's actually awake.
          if (e?.message !== "timeout") {
            localStorage.removeItem(CIRCLE_SESSION_STORAGE_KEY);
          }
          setStatus("idle");
          setRestoringSession(false);
        });
    } catch {
      localStorage.removeItem(CIRCLE_SESSION_STORAGE_KEY);
      setRestoringSession(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loginWithEmail = useCallback(
    async (email) => {
      if (!CIRCLE_APP_ID) {
        setError("Circle Wallets isn't configured yet (missing App ID).");
        return;
      }
      const userId = email.trim().toLowerCase();
      if (!userId || !userId.includes("@")) {
        setError("Enter a valid email address.");
        return;
      }
      setStatus("working");
      setError(null);
      try {
        // Create the user (idempotent-ish — Circle errors if it already
        // exists, which is fine, we just continue to the token step).
        await fetch(`${API_BASE}/circle/create-user`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId }),
        }).catch(() => {});

        const tokenRes = await fetch(`${API_BASE}/circle/user-token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId }),
        });
        if (!tokenRes.ok) throw new Error("Could not start sign-in. Try again.");
        const { userToken, encryptionKey } = await tokenRes.json();
        sessionRef.current = { userId, userToken, encryptionKey };

        const initRes = await fetch(`${API_BASE}/circle/initialize-user`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userToken }),
        });
        const initData = await initRes.json();

        if (initRes.ok && initData.challengeId) {
          // First time for this user — Circle needs them to set a PIN via
          // its own hosted popup before the wallet is actually created.
          setStatus("pinChallenge");
          const sdk = getSdk();
          // Use the deviceId pre-fetched on mount if we have it; otherwise
          // this is a fresh retry, which by now has had time to succeed.
          if (!deviceIdRef.current) {
            deviceIdRef.current = await sdk.getDeviceId();
          }
          sdk.setAuthentication({ userToken, encryptionKey });
          sdk.execute(initData.challengeId, async (err) => {
            if (err) {
              if (!isTerminalCircleError(err)) {
                // Recoverable in-iframe validation nudge (e.g. hint/answer
                // conflict, PIN mismatch with retries left) — Circle's
                // modal is still open and will let the user fix it and
                // continue. Don't tear down our own state for this.
                console.warn("Circle PIN challenge (recoverable):", err);
                return;
              }
              console.error("Circle PIN challenge failed:", err);
              setError(err?.message || "PIN setup was cancelled or failed.");
              setStatus("idle");
              return;
            }
            try {
              await new Promise((r) => setTimeout(r, 2000)); // give Circle a moment to index the new wallet
              const w = await loadWalletAndBalance(userToken);
              localStorage.setItem(CIRCLE_SESSION_STORAGE_KEY, JSON.stringify(sessionRef.current));
              setStatus(w ? "ready" : "error");
              if (w) logLoginEvent(w.address, "circle");
            } catch (e) {
              setError(e.message);
              setStatus("error");
            }
          });
        } else if (initData.code === 155106) {
          // Already initialized in a previous session — just load it.
          const w = await loadWalletAndBalance(userToken);
          localStorage.setItem(CIRCLE_SESSION_STORAGE_KEY, JSON.stringify(sessionRef.current));
          setStatus(w ? "ready" : "error");
          if (w) logLoginEvent(w.address, "circle");
        } else {
          throw new Error(initData.error || initData.message || "Could not initialize wallet.");
        }
      } catch (e) {
        console.error("Circle Wallets sign-in failed:", e);
        setError(e?.message || "Sign-in failed. Please try again.");
        setStatus("idle");
      }
    },
    [getSdk, loadWalletAndBalance]
  );

  const logout = useCallback(() => {
    localStorage.removeItem(CIRCLE_SESSION_STORAGE_KEY);
    sessionRef.current = null;
    setAddress(null);
    setWalletId(null);
    setBalance(null);
    setStatus("idle");
  }, []);

  const refreshBalance = useCallback(() => {
    if (sessionRef.current?.userToken) {
      loadWalletAndBalance(sessionRef.current.userToken).catch(() => {});
    }
  }, [loadWalletAndBalance]);

  // Phase 2a: send native USDC from a Circle-controlled wallet. Creates a
  // transfer challenge server-side, then has the user approve it with
  // their PIN via the Web SDK — a genuinely different flow from ethers.js
  // signing, since Circle (not the browser) holds the signing keyshare.
  // token/tokenAddress: pass tokenAddress for EURC/cirBTC (real ERC-20s on
  // Arc Testnet); omit it for native USDC — the backend only attaches it
  // to the Circle request when present, matching Circle's native-vs-token
  // transfer request shapes.
  const sendTransfer = useCallback(async ({ to, amount, tokenAddress }) => {
    if (!sessionRef.current || !walletId) {
      throw new Error("Not signed in with a Circle wallet.");
    }
    const { userToken, encryptionKey } = sessionRef.current;

    const res = await fetch(`${API_BASE}/circle/transfer-challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userToken, walletId, destinationAddress: to, amount, tokenAddress }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || body.message || "Could not start transfer.");
    }
    const { challengeId } = await res.json();

    const sdk = getSdk();
    if (!deviceIdRef.current) {
      deviceIdRef.current = await sdk.getDeviceId();
    }
    sdk.setAuthentication({ userToken, encryptionKey });

    await new Promise((resolve, reject) => {
      sdk.execute(challengeId, (err) => {
        if (err) {
          if (isTerminalCircleError(err)) {
            reject(new Error(err?.message || "Transfer was cancelled or failed."));
          } else {
            console.warn("Circle transfer challenge (recoverable):", err);
          }
          return;
        }
        resolve();
      });
    });

    // Give Circle a moment to settle, then refresh balance.
    setTimeout(() => refreshBalance(), 2500);
  }, [walletId, getSdk, refreshBalance]);

  // Phase 2c: generic contract-execution challenge — used by NFT Lock for
  // mint/approve/lock/withdraw, since those are arbitrary contract calls
  // rather than token sends. Resolves to the txHash of the confirmed
  // transaction (found via Circle's transaction list, matched by
  // contractAddress) so callers can read the on-chain receipt themselves
  // to pull out event data (minted tokenId, new lockId, etc.) the same
  // way the app already does for MetaMask/WalletConnect users.
  // targetWalletId defaults to the Arc wallet (walletId) — every existing
  // caller (NFT Lock) keeps working unchanged. Bridge is the first caller
  // that needs to target a DIFFERENT chain's wallet (the source chain,
  // for approve/burn), so it passes that wallet's id explicitly.
  // targetWalletId defaults to the Arc wallet — every existing caller
  // (NFT Lock) keeps working unchanged. Bridge is the first caller that
  // needs to target a DIFFERENT chain's wallet (the source chain, for
  // approve/burn), so it passes that wallet's id explicitly. No separate
  // "blockchain" field is needed alongside it — walletId alone already
  // fully determines which chain a call runs on (confirmed directly from
  // Circle's own validation error: walletId + blockchain together is an
  // invalid combination, not a disambiguation).
  const executeContract = useCallback(async ({ contractAddress, abiFunctionSignature, abiParameters, targetWalletId, onPoll }) => {
    const useWalletId = targetWalletId || walletId;
    if (!sessionRef.current || !useWalletId) {
      throw new Error("Not signed in with a Circle wallet.");
    }
    const { userToken, encryptionKey } = sessionRef.current;

    const res = await fetch(`${API_BASE}/circle/contract-execution-challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userToken,
        walletId: useWalletId,
        contractAddress,
        abiFunctionSignature,
        abiParameters,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || body.message || "Could not start transaction.");
    }
    const { challengeId } = await res.json();

    const sdk = getSdk();
    if (!deviceIdRef.current) {
      deviceIdRef.current = await sdk.getDeviceId();
    }
    sdk.setAuthentication({ userToken, encryptionKey });

    await new Promise((resolve, reject) => {
      sdk.execute(challengeId, (err) => {
        if (err) {
          if (isTerminalCircleError(err)) {
            reject(new Error(err?.message || "Transaction was cancelled or failed."));
          } else {
            console.warn("Circle transaction challenge (recoverable):", err);
          }
          return;
        }
        resolve();
      });
    });

    // The SDK callback doesn't hand back a txHash, so poll Circle's own
    // transaction list for the matching transaction and wait for it to
    // reach a state that has a txHash. Filtered to just this wallet
    // (Circle's own walletIds param) so it isn't crowded out by
    // unrelated activity on other wallets under the same Circle account.
    // Generous window — a burn on an external testnet (Sepolia, Base
    // Sepolia, Fuji) can take meaningfully longer to get a txHash
    // populated than a same-chain Arc transaction does.
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise((r) => setTimeout(r, 3000));
      if (onPoll && attempt > 0 && attempt % 5 === 0) onPoll(attempt * 3);
      try {
        const listRes = await fetch(
          `${API_BASE}/circle/transactions?userToken=${encodeURIComponent(userToken)}&walletId=${useWalletId}`
        );
        if (!listRes.ok) continue;
        const { transactions } = await listRes.json();
        const match = transactions?.find(
          (t) => (t.contractAddress || "").toLowerCase() === contractAddress.toLowerCase() && t.txHash
        );
        if (match) return match.txHash;
      } catch {
        // keep polling
      }
    }
    throw new Error("Transaction confirmed but couldn't locate its hash yet — check History in a moment.");
  }, [walletId, getSdk]);

  return {
    status,
    restoringSession,
    error,
    address,
    walletId,
    walletsByChain,
    createDate,
    balance,
    balances,
    loginWithEmail,
    logout,
    refreshBalance,
    sendTransfer,
    executeContract,
    createWalletOnChain,
  };
}

/* ------------------------------------------------------------------ */
/*  Shared UI atoms — dark purple / cyan glass morphism                */
/* ------------------------------------------------------------------ */

const GlassCard = ({ children, className = "" }) => (
  <div
    className={`rounded-2xl border border-purple-500/20 bg-[var(--surface-subtle)] backdrop-blur-xl shadow-[0_0_40px_-15px_rgba(168,85,247,0.35)] ${className}`}
  >
    {children}
  </div>
);

const PrimaryButton = ({ children, disabled, className = "", ...props }) => (
  <button
    disabled={disabled}
    className={`px-5 py-2.5 rounded-xl font-medium text-sm transition border
      ${
        disabled
          ? "bg-[var(--surface)] text-[var(--text-secondary)] border-[var(--border-strong)] cursor-not-allowed"
          : "bg-gradient-to-r from-cyan-500 to-purple-600 text-[var(--text-primary)] border-transparent hover:brightness-110 active:scale-[0.98]"
      } ${className}`}
    {...props}
  >
    {children}
  </button>
);

const Pill = ({ tone = "neutral", children }) => {
  const tones = {
    neutral: "bg-[var(--surface)] text-[var(--text-soft)]",
    ok: "bg-emerald-500/15 text-emerald-300",
    warn: "bg-amber-500/15 text-amber-300",
    bad: "bg-rose-500/15 text-rose-300",
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
};

// Simple animated placeholder bar shown while a value is still loading.
const Skeleton = ({ className = "" }) => (
  <div className={`animate-pulse rounded-md bg-[var(--surface)] ${className}`} />
);

function CopyButton({ value, className = "" }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Fallback for browsers/contexts where clipboard API is blocked
      const el = document.createElement("textarea");
      el.value = value;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [value]);

  if (!value) return null;
  return (
    <button
      onClick={handleCopy}
      title="Copy to clipboard"
      aria-label="Copy to clipboard"
      className={`inline-flex items-center gap-1 text-[var(--text-muted)] hover:text-[var(--text-strong)] transition ${className}`}
    >
      {copied ? (
        <span className="text-emerald-300 text-xs">Copied!</span>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/*  Toast notifications — a tiny global pub/sub, no context needed      */
/*  since pages here just receive `wallet` as a prop rather than        */
/*  reading from a provider. `toast(...)` can be called from anywhere;  */
/*  <ToastViewport/> (mounted once in the App shell) renders them.      */
/*                                                                      */
/*  Every toast with a `category` and a real outcome (tone "ok" or      */
/*  "bad" — not "neutral"/"warn" status-only messages) also gets        */
/*  written to a persistent Activity log, so it's still visible after   */
/*  the toast itself disappears. One system, two audiences: the toast   */
/*  is the in-the-moment nudge, the Activity page is the searchable     */
/*  record of everything that's happened.                               */
/* ------------------------------------------------------------------ */

const ACTIVITY_LOG_KEY = "arc_activity_log";
const ACTIVITY_LOG_MAX_ENTRIES = 200;
let activityListeners = [];

function logActivity(entry) {
  const log = readLS(ACTIVITY_LOG_KEY, []);
  const next = [entry, ...log].slice(0, ACTIVITY_LOG_MAX_ENTRIES);
  writeLS(ACTIVITY_LOG_KEY, next);
  activityListeners.forEach((fn) => fn(entry));
}

let toastListeners = [];
function toast({ tone = "neutral", title, message, action, category }) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const entry = { id, tone, title, message, action };
  toastListeners.forEach((fn) => fn(entry));

  if (category && (tone === "ok" || tone === "bad")) {
    logActivity({ id, category, tone, title, message, timestamp: Date.now() });
  }
  return id;
}

function ToastViewport() {
  const [items, setItems] = useState([]);

  useEffect(() => {
    const onToast = (entry) => {
      setItems((prev) => [...prev, entry]);
      // Toasts with an action (e.g. "Withdraw now") stay up longer —
      // giving the person time to notice and tap it, rather than
      // disappearing at the same 6s pace as a plain status message.
      const ttl = entry.action ? 20000 : 6000;
      setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== entry.id));
      }, ttl);
    };
    toastListeners.push(onToast);
    return () => {
      toastListeners = toastListeners.filter((fn) => fn !== onToast);
    };
  }, []);

  const toneStyles = {
    ok: "border-emerald-500/30 bg-emerald-950/80",
    bad: "border-rose-500/30 bg-rose-950/80",
    warn: "border-amber-500/30 bg-amber-950/80",
    neutral: "border-[var(--border)] bg-[var(--card-solid)]/90",
  };

  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-[calc(100%-2rem)] max-w-sm">
      {items.map((t) => (
        <div
          key={t.id}
          className={`rounded-xl border ${toneStyles[t.tone] || toneStyles.neutral} backdrop-blur-xl px-4 py-3 shadow-lg animate-[fadeIn_0.15s_ease-out]`}
        >
          {t.title && <p className="text-[var(--text-primary)] text-sm font-medium mb-0.5">{t.title}</p>}
          {t.message && <p className="text-[var(--text-tertiary)] text-xs break-all">{t.message}</p>}
          {t.action && (
            <button
              onClick={() => {
                t.action.onClick?.();
                setItems((prev) => prev.filter((item) => item.id !== t.id));
              }}
              className="mt-2 text-xs font-medium text-cyan-300 hover:text-cyan-200 transition"
            >
              {t.action.label} →
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Command bar — type a plain-English instruction, it parses and       */
/*  executes it directly, no need to visit the matching page first.     */
/*  Pattern-matching only (no AI/API calls), so it's free and instant,  */
/*  but only understands the phrasings listed in COMMAND_EXAMPLES.      */
/* ------------------------------------------------------------------ */

const TOKEN_ALIASES = { usdc: "USDC", eurc: "EURC", cirbtc: "cirBTC" };

const COMMAND_EXAMPLES = [
  "send 20 USDC to 0x1234...5678",
  "swap 10 USDC to EURC",
  "mint an nft",
  "lock nft 5 for 7 days",
  "withdraw lock 3",
  "bulk send 5 USDC to 0xabc..., 0xdef...",
  "check my balance",
  "go to history",
];

function parseCommand(raw) {
  const text = raw.trim();

  const sendMatch = text.match(/send\s+([\d.]+)\s+(usdc|eurc|cirbtc)\s+to\s+(0x[a-fA-F0-9]{40})/i);
  if (sendMatch) {
    return {
      action: "send",
      amount: sendMatch[1],
      token: TOKEN_ALIASES[sendMatch[2].toLowerCase()],
      to: sendMatch[3],
    };
  }

  const bulkMatch = text.match(/bulk\s*send\s+([\d.]+)\s+(usdc|eurc|cirbtc)\s+to\s+((?:0x[a-fA-F0-9]{40}[\s,]*)+)/i);
  if (bulkMatch) {
    const addresses = bulkMatch[3].match(/0x[a-fA-F0-9]{40}/g) || [];
    if (addresses.length > 0) {
      return {
        action: "bulkSend",
        amount: bulkMatch[1],
        token: TOKEN_ALIASES[bulkMatch[2].toLowerCase()],
        addresses,
      };
    }
  }

  const swapMatch = text.match(/swap\s+([\d.]+)\s+(usdc|eurc|cirbtc)\s+(?:to|for|into)\s+(usdc|eurc|cirbtc)/i);
  if (swapMatch) {
    return {
      action: "swap",
      amount: swapMatch[1],
      tokenIn: TOKEN_ALIASES[swapMatch[2].toLowerCase()],
      tokenOut: TOKEN_ALIASES[swapMatch[3].toLowerCase()],
    };
  }

  if (/mint\s+(?:an?\s+)?nft/i.test(text)) {
    return { action: "mintNft" };
  }

  const lockMatch = text.match(/lock\s+nft\s+(\d+)\s+for\s+(\d+)\s*days?/i);
  if (lockMatch) {
    return { action: "lockNft", tokenId: lockMatch[1], days: lockMatch[2] };
  }

  const withdrawMatch = text.match(/withdraw\s+(?:nft\s+)?lock\s+(\d+)/i);
  if (withdrawMatch) {
    return { action: "withdrawLock", lockId: withdrawMatch[1] };
  }

  if (/balance/i.test(text)) {
    return { action: "navigate", page: "Dashboard" };
  }

  const navMatch = text.match(/(?:go to|open|show)\s+(dashboard|transfer|bulk transfer|swap|nft lock|history|leaderboard|wallet profile)/i);
  if (navMatch) {
    const page = NAV_ITEMS.find((p) => p.toLowerCase() === navMatch[1].toLowerCase());
    if (page) return { action: "navigate", page };
  }

  return null;
}

function describeCommand(cmd) {
  if (cmd.action === "send") return `Send ${cmd.amount} ${cmd.token} to ${cmd.to.slice(0, 8)}…${cmd.to.slice(-6)}`;
  if (cmd.action === "bulkSend") return `Send ${cmd.amount} ${cmd.token} to ${cmd.addresses.length} address(es)`;
  if (cmd.action === "swap") return `Swap ${cmd.amount} ${cmd.tokenIn} → ${cmd.tokenOut}`;
  if (cmd.action === "mintNft") return "Mint a new NFT";
  if (cmd.action === "lockNft") return `Lock NFT #${cmd.tokenId} for ${cmd.days} day(s)`;
  if (cmd.action === "withdrawLock") return `Withdraw lock #${cmd.lockId}`;
  if (cmd.action === "navigate") return `Open ${cmd.page}`;
  return "";
}

function CommandBar({ wallet, onNavigate }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);

  const handleParse = useCallback(() => {
    setError(null);
    const result = parseCommand(text);
    if (!result) {
      setError("Didn't recognize that — try one of the example phrasings below.");
      setParsed(null);
      return;
    }
    setParsed(result);
  }, [text]);

  const reset = useCallback(() => {
    setText("");
    setParsed(null);
    setError(null);
    setOpen(false);
  }, []);

  const runCommand = useCallback(async () => {
    if (!parsed) return;

    if (parsed.action === "navigate") {
      onNavigate(parsed.page);
      reset();
      return;
    }

    if (!wallet.provider || !wallet.address) {
      setError("Connect your wallet first.");
      return;
    }

    setRunning(true);
    try {
      if (parsed.action === "send") {
        const signer = await wallet.provider.getSigner();
        let tx;
        if (parsed.token === NATIVE_TOKEN_SYMBOL) {
          tx = await signer.sendTransaction({
            to: parsed.to,
            value: ethers.parseUnits(parsed.amount, NATIVE_BALANCE_DECIMALS),
          });
        } else {
          const contract = new ethers.Contract(CONTRACTS[parsed.token], ERC20_ABI, signer);
          tx = await contract.transfer(parsed.to, ethers.parseUnits(parsed.amount, TOKEN_DECIMALS[parsed.token]));
        }
        toast({ category: "Command", tone: "warn", title: "Transaction submitted", message: `${tx.hash.slice(0, 18)}…` });
        await tx.wait();
        pushTx({ type: "Transfer", token: parsed.token, to: parsed.to, amount: parsed.amount, txHash: tx.hash, status: "confirmed" });
        toast({ category: "Command", tone: "ok", title: "Command complete", message: describeCommand(parsed) });
      } else if (parsed.action === "bulkSend") {
        const signer = await wallet.provider.getSigner();
        const isNative = parsed.token === NATIVE_TOKEN_SYMBOL;
        const contract = isNative ? null : new ethers.Contract(CONTRACTS[parsed.token], ERC20_ABI, signer);
        const decimals = isNative ? NATIVE_BALANCE_DECIMALS : TOKEN_DECIMALS[parsed.token];
        let succeeded = 0;
        let failed = 0;
        for (const addr of parsed.addresses) {
          try {
            const tx = isNative
              ? await signer.sendTransaction({ to: addr, value: ethers.parseUnits(parsed.amount, decimals) })
              : await contract.transfer(addr, ethers.parseUnits(parsed.amount, decimals));
            await tx.wait();
            succeeded++;
          } catch {
            failed++;
          }
        }
        writeLS(LS_KEYS.bulk, [{ id: crypto.randomUUID(), token: parsed.token, rows: parsed.addresses.map((to) => ({ to, amount: parsed.amount })), timestamp: Date.now() }, ...readLS(LS_KEYS.bulk, [])]);
        toast({ category: "Command",
          tone: failed === 0 ? "ok" : succeeded === 0 ? "bad" : "warn",
          title: "Bulk send complete",
          message: `${succeeded} succeeded, ${failed} failed.`,
        });
      } else if (parsed.action === "swap") {
        const res = await fetch(`${SWAP_API_BASE}/swap`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chain: "Arc_Testnet",
            tokenIn: parsed.tokenIn,
            tokenOut: parsed.tokenOut,
            amountIn: parsed.amount,
            slippageBps: 300,
            walletAddress: wallet.address,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error || "Swap failed");
        const data = await res.json();
        pushTx({ type: "Swap", tokenIn: parsed.tokenIn, tokenOut: parsed.tokenOut, amountIn: parsed.amount, estimatedOutput: data.estimatedOutput, status: data.status || "submitted" });
        toast({ category: "Command", tone: "ok", title: "Command complete", message: describeCommand(parsed) });
      } else if (parsed.action === "mintNft") {
        const signer = await wallet.provider.getSigner();
        const nft = new ethers.Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, signer);
        const tx = await withRpcRetry(() => nft.mint());
        const receipt = await withRpcRetry(() => tx.wait());
        const transferEvent = receipt.logs
          .map((log) => { try { return nft.interface.parseLog(log); } catch { return null; } })
          .find((p) => p?.name === "Transfer");
        const newTokenId = transferEvent?.args?.tokenId?.toString();
        writeLS(LS_MINTED_KEY, [newTokenId, ...readLS(LS_MINTED_KEY, [])]);
        toast({ category: "Command", tone: "ok", title: "NFT minted", message: `Token #${newTokenId}` });
      } else if (parsed.action === "lockNft") {
        const signer = await wallet.provider.getSigner();
        const nft = new ethers.Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, signer);
        const vault = new ethers.Contract(NFT_LOCK_VAULT_ADDRESS, NFT_LOCK_ABI, signer);
        const approveTx = await withRpcRetry(() => nft.approve(NFT_LOCK_VAULT_ADDRESS, parsed.tokenId));
        await withRpcRetry(() => approveTx.wait());
        const unlockAt = Math.floor(Date.now() / 1000) + Number(parsed.days) * 86400;
        const lockTx = await withRpcRetry(() => vault.lock(NFT_CONTRACT_ADDRESS, parsed.tokenId, unlockAt));
        const receipt = await withRpcRetry(() => lockTx.wait());
        const lockedEvent = receipt.logs
          .map((log) => { try { return vault.interface.parseLog(log); } catch { return null; } })
          .find((p) => p?.name === "Locked");
        const newLockId = lockedEvent?.args?.lockId?.toString();
        writeLS(LS_LOCK_IDS_KEY, [newLockId, ...readLS(LS_LOCK_IDS_KEY, [])]);
        writeLS(LS_MINTED_KEY, readLS(LS_MINTED_KEY, []).filter((id) => id !== parsed.tokenId));
        toast({ category: "Command", tone: "ok", title: "NFT locked", message: describeCommand(parsed) });
      } else if (parsed.action === "withdrawLock") {
        const signer = await wallet.provider.getSigner();
        const vault = new ethers.Contract(NFT_LOCK_VAULT_ADDRESS, NFT_LOCK_ABI, signer);
        const tx = await withRpcRetry(() => vault.withdraw(parsed.lockId));
        await withRpcRetry(() => tx.wait());
        toast({ category: "Command", tone: "ok", title: "Withdrawn", message: describeCommand(parsed) });
      }
      reset();
    } catch (e) {
      const msg = e.shortMessage || e.message || "Command failed.";
      setError(msg);
      toast({ category: "Command", tone: "bad", title: "Command failed", message: msg });
    } finally {
      setRunning(false);
    }
  }, [parsed, wallet, onNavigate, reset]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 left-4 z-40 w-12 h-12 rounded-full bg-gradient-to-br from-cyan-400 to-purple-600 flex items-center justify-center text-[var(--text-primary)] text-lg shadow-lg hover:scale-105 transition"
        title="Quick command"
        aria-label="Open quick command bar"
      >
        <span aria-hidden="true">⚡</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <GlassCard className="w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-[var(--text-primary)] text-base font-semibold">Quick command</h3>
              <button onClick={reset} aria-label="Close command bar" className="text-[var(--text-muted)] hover:text-[var(--text-soft)] text-sm">✕</button>
            </div>
            <p className="text-[var(--text-muted)] text-xs mb-3">
              Type an instruction in plain English — no need to open the matching page.
            </p>

            <input
              autoFocus
              value={text}
              onChange={(e) => { setText(e.target.value); setParsed(null); setError(null); }}
              onKeyDown={(e) => e.key === "Enter" && (parsed ? runCommand() : handleParse())}
              placeholder="send 20 USDC to 0x..."
              className="w-full bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm mb-3"
            />

            {!parsed && (
              <PrimaryButton onClick={handleParse} className="w-full mb-1" disabled={!text.trim()}>
                Parse command
              </PrimaryButton>
            )}

            {parsed && (
              <div className="mb-3 px-3 py-3 rounded-lg border border-cyan-500/30 bg-cyan-950/30">
                <p className="text-[var(--text-secondary)] text-xs mb-1">This will:</p>
                <p className="text-[var(--text-primary)] text-sm font-medium mb-3">{describeCommand(parsed)}</p>
                <div className="flex gap-2">
                  <PrimaryButton onClick={runCommand} disabled={running} className="flex-1">
                    {running ? "Running…" : "Confirm"}
                  </PrimaryButton>
                  <button
                    onClick={() => setParsed(null)}
                    disabled={running}
                    className="px-4 py-2 rounded-lg text-[var(--text-tertiary)] text-sm border border-[var(--border)] hover:bg-[var(--surface-subtle)]"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {error && <p className="text-rose-300 text-xs mb-3">{error}</p>}

            <div className="border-t border-[var(--border-subtle)] pt-3">
              <p className="text-[var(--text-muted)] text-xs mb-2">Try phrases like:</p>
              <div className="space-y-1">
                {COMMAND_EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => { setText(ex.replace("0x1234...5678", "0x")); setParsed(null); setError(null); }}
                    className="block text-left text-cyan-300/70 hover:text-cyan-300 text-xs font-mono"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          </GlassCard>
        </div>
      )}
    </>
  );
}

const NAV_ITEMS = [
  "Dashboard",
  "Deposit",
  "Withdraw",
  "Agent Payroll",
  "Transfer",
  "Bulk Transfer",
  "Swap",
  "Bridge",
  "Lending",
  "ArclifyUSD",
  "NFT Lock",
  "Activity",
  "History",
  "Leaderboard",
  "Wallet Profile",
];

/* ------------------------------------------------------------------ */
/*  Page: Dashboard                                                    */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Small legend row used next to the portfolio donut.
function LegendRow({ colorClass, label, pct, amount }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${colorClass}`} />
      <span className="text-[var(--text-secondary)] w-14 shrink-0">{label}</span>
      <span className="text-[var(--text-primary)] font-medium tabular-nums">{pct.toFixed(0)}%</span>
      <span className="text-[var(--text-faint)] text-xs tabular-nums truncate">{amount}</span>
    </div>
  );
}

// Token mix donut — shown by *amount*, not USD value. EURC and cirBTC
// aren't run through a price feed anywhere in this app (see the hero
// total's own caveat), so a value-weighted pie would silently imply a
// conversion rate that doesn't exist. Labeling it as a raw-amount mix
// keeps it honest with what the data actually is.
function TokenAllocationDonut({ balances }) {
  const usdc = Number(balances.USDC) || 0;
  const eurc = Number(balances.EURC) || 0;
  const cirbtc = Number(balances.cirBTC) || 0;
  const total = usdc + eurc + cirbtc;

  if (total <= 0) return null;

  const pUsdc = (usdc / total) * 100;
  const pEurc = (eurc / total) * 100;
  const pCirbtc = Math.max(0, 100 - pUsdc - pEurc);

  const stops = `#22d3ee 0% ${pUsdc}%, #a855f7 ${pUsdc}% ${pUsdc + pEurc}%, #fb923c ${pUsdc + pEurc}% 100%`;

  return (
    <GlassCard className="p-6">
      <div className="flex items-center justify-between mb-5">
        <span className="text-[var(--text-secondary)] text-sm font-medium">Token mix</span>
        <span className="text-[var(--text-faint)] text-[10px]">By amount, not USD value</span>
      </div>
      <div className="flex items-center gap-6 flex-wrap">
        <div className="w-24 h-24 rounded-full shrink-0" style={{ background: `conic-gradient(${stops})` }}>
          <div
            className="w-full h-full rounded-full flex items-center justify-center"
            style={{ background: "radial-gradient(circle, var(--surface-subtle) 54%, transparent 55%)" }}
          />
        </div>
        <div className="space-y-2">
          <LegendRow colorClass="bg-cyan-400" label="USDC" pct={pUsdc} amount={balances.USDC} />
          <LegendRow colorClass="bg-purple-400" label="EURC" pct={pEurc} amount={balances.EURC} />
          <LegendRow colorClass="bg-orange-400" label="cirBTC" pct={pCirbtc} amount={balances.cirBTC} />
        </div>
      </div>
    </GlassCard>
  );
}

// Buttons for the 4 most common actions, right on the dashboard, so
// users don't need the sidebar for everyday moves.
function QuickActionsRow({ setPage }) {
  const actions = [
    { label: "Deposit", page: "Deposit", grad: "from-cyan-500 to-cyan-600" },
    { label: "Withdraw", page: "Withdraw", grad: "from-purple-500 to-purple-600" },
    { label: "Transfer", page: "Transfer", grad: "from-emerald-500 to-emerald-600" },
    { label: "Swap", page: "Swap", grad: "from-orange-500 to-orange-600" },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {actions.map((a) => (
        <button
          key={a.page}
          onClick={() => setPage(a.page)}
          className={`rounded-xl px-4 py-3 text-sm font-medium text-[var(--text-primary)] bg-gradient-to-r ${a.grad} hover:brightness-110 active:scale-[0.98] transition text-center`}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

// Last 4 Activity Centre entries, inline on the dashboard, with a link
// to the full Activity page. Subscribes the same way ActivityPage does
// so a fresh action elsewhere in the app updates this list live.
function RecentActivityPreview({ setPage }) {
  const [entries, setEntries] = useState(() => readLS(ACTIVITY_LOG_KEY, []));

  useEffect(() => {
    const onActivity = () => setEntries(readLS(ACTIVITY_LOG_KEY, []));
    activityListeners.push(onActivity);
    return () => {
      activityListeners = activityListeners.filter((fn) => fn !== onActivity);
    };
  }, []);

  const recent = entries.slice(0, 4);

  return (
    <GlassCard className="p-6">
      <div className="flex items-center justify-between mb-4">
        <span className="text-[var(--text-secondary)] text-sm font-medium">Recent activity</span>
        <button
          onClick={() => setPage("Activity")}
          className="text-[var(--text-muted)] hover:text-[var(--text-soft)] text-xs underline decoration-dotted"
        >
          View all
        </button>
      </div>
      {recent.length === 0 ? (
        <p className="text-[var(--text-faint)] text-sm py-4 text-center">
          Nothing yet — actions you take will show up here.
        </p>
      ) : (
        <div className="space-y-2">
          {recent.map((entry) => (
            <div key={entry.id} className="flex items-start justify-between gap-3 bg-[var(--surface-subtle)] rounded-lg px-3 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${entry.tone === "ok" ? "bg-emerald-400" : "bg-rose-400"}`} />
                  <span className="text-[var(--text-primary)] text-sm font-medium truncate">{entry.title}</span>
                </div>
                {entry.message && <p className="text-[var(--text-secondary)] text-xs truncate">{entry.message}</p>}
              </div>
              <span className="text-[var(--text-faint)] text-xs shrink-0">{relativeTime(entry.timestamp)}</span>
            </div>
          ))}
        </div>
      )}
    </GlassCard>
  );
}

function DashboardPage({ wallet, setPage }) {
  const [balances, setBalances] = useState({ USDC: "—", EURC: "—", cirBTC: "—" });
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [lastSynced, setLastSynced] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function loadBalances() {
      if (wallet.isCircleWallet) {
        // Circle wallets get every token's balance from Circle's own
        // balance API (already fetched by useCircleWallet), not a direct
        // RPC call.
        setBalances({
          USDC: wallet.circleBalances?.USDC ?? wallet.circleBalance ?? "0.00",
          EURC: wallet.circleBalances?.EURC ?? "0.00",
          cirBTC: wallet.circleBalances?.cirBTC ?? "0.00",
        });
        if (!cancelled) setLastSynced(Date.now());
        return;
      }
      if (!wallet.provider || !wallet.address) return;
      setLoading(true);
      const eurc = new ethers.Contract(CONTRACTS.EURC, ERC20_ABI, wallet.provider);
      const cirbtc = new ethers.Contract(CONTRACTS.cirBTC, ERC20_ABI, wallet.provider);

      // Each balance is fetched (and can fail) independently — one bad
      // token shouldn't blank out the ones that succeeded. A short pause
      // between calls (on top of the retry backoff inside each call)
      // gives Arc Testnet's rate-limited public RPC more breathing room.
      try {
        const nativeBal = await withRpcRetry(() =>
          wallet.provider.getBalance(wallet.address)
        );
        if (!cancelled) {
          setBalances((b) => ({ ...b, USDC: ethers.formatUnits(nativeBal, NATIVE_BALANCE_DECIMALS) }));
        }
      } catch {
        if (!cancelled) setBalances((b) => ({ ...b, USDC: "0.00" }));
      }

      await sleep(400);
      try {
        const eBal = await withRpcRetry(() => eurc.balanceOf(wallet.address));
        if (!cancelled) {
          setBalances((b) => ({ ...b, EURC: ethers.formatUnits(eBal, TOKEN_DECIMALS.EURC) }));
        }
      } catch {
        if (!cancelled) setBalances((b) => ({ ...b, EURC: "0.00" }));
      }

      await sleep(400);
      try {
        const bBal = await withRpcRetry(() => cirbtc.balanceOf(wallet.address));
        if (!cancelled) {
          setBalances((b) => ({ ...b, cirBTC: ethers.formatUnits(bBal, TOKEN_DECIMALS.cirBTC) }));
        }
      } catch {
        if (!cancelled) setBalances((b) => ({ ...b, cirBTC: "0.00" }));
      }

      if (!cancelled) {
        setLoading(false);
        setLastSynced(Date.now());
      }
    }
    // A safety net, not the normal path: withRpcRetry already handles
    // rate limits and flaky responses with bounded retries, so loadBalances
    // normally always resolves on its own, one way or another. This only
    // matters if a single RPC call truly hangs (connection open, server
    // never responds) rather than failing — without a ceiling, `loading`
    // would stay stuck true forever, and since the 10s auto-refresh skips
    // ticks while loading is true, it would silently stop updating with
    // no visible error. 45s is well above the worst-case legitimate
    // retry/backoff duration (~40s), so it only fires on a genuine stall.
    withTimeout(loadBalances(), 45000).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [wallet.provider, wallet.address, wallet.isCircleWallet, wallet.circleBalance, wallet.circleBalances, refreshKey]);

  // Auto-refresh every 10s. Uses a ref (not `loading` in the deps array)
  // so the interval itself never restarts mid-countdown — it just skips a
  // tick if the previous refresh is still in flight, instead of piling
  // requests on top of Arc Testnet's rate-limited public RPC.
  const loadingRef = useRef(loading);
  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);
  useEffect(() => {
    if (!wallet.address) return;
    const id = setInterval(() => {
      if (!loadingRef.current) setRefreshKey((k) => k + 1);
    }, 10000);
    return () => clearInterval(id);
  }, [wallet.address]);

  const usdcNum = Number(balances.USDC);
  const hasBalances = balances.USDC !== "—" && !Number.isNaN(usdcNum);
  // Rough combined total for the hero figure — USDC 1:1, EURC/cirBTC show
  // separately in their own units below since they aren't real USD
  // conversions (especially cirBTC, whose BTC price isn't tracked here).
  const total = hasBalances ? usdcNum : null;
  const isEmptyWallet =
    hasBalances && usdcNum === 0 && Number(balances.EURC) === 0 && Number(balances.cirBTC) === 0;

  return (
    <div className="space-y-5">
      {/* Hero total balance — big and unmissable, bank-app style */}
      <GlassCard className="p-8 md:p-10">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <p className="text-[var(--text-secondary)] text-sm mb-2">Total balance</p>
            {total === null ? (
              <Skeleton className="h-12 sm:h-14 md:h-16 w-64 max-w-full" />
            ) : (
              <p className="text-[var(--text-primary)] text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight tabular-nums break-all">
                {`$${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              </p>
            )}
            <p className="text-[var(--text-faint)] text-xs mt-2">Your USDC balance (1 USDC ≈ $1)</p>
            {wallet.isCircleWallet && (
              <p className="text-cyan-300/70 text-xs mt-1">
                Circle Wallet (email login) — Transfer, Swap, and NFT Lock all work here now.
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-2">
              <Pill tone={wallet.isOnArc ? "ok" : "warn"}>
                {wallet.isOnArc ? "Arc Testnet · 5042002" : "Wrong network"}
              </Pill>
              <button
                onClick={() => setRefreshKey((k) => k + 1)}
                disabled={loading}
                className="text-[var(--text-muted)] text-xs hover:text-[var(--text-soft)] disabled:opacity-40 disabled:cursor-not-allowed underline decoration-dotted"
              >
                {loading ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            {lastSynced && (
              <p className="text-[var(--text-faint)] text-[10px]">Last synced {relativeTime(lastSynced)}</p>
            )}
            <div className="flex items-center gap-2 justify-end">
              <p className="text-[var(--text-muted)] font-mono text-xs break-all">
                {wallet.address ?? "Not connected"}
              </p>
              <CopyButton value={wallet.address} />
            </div>
          </div>
        </div>
      </GlassCard>

      {/* Quick actions — the 4 most common moves, no sidebar needed */}
      <QuickActionsRow setPage={setPage} />

      {isEmptyWallet ? (
        <GlassCard className="p-8 text-center">
          <p className="text-[var(--text-primary)] text-base font-medium mb-1">Nothing here yet</p>
          <p className="text-[var(--text-secondary)] text-sm mb-5 max-w-sm mx-auto">
            This wallet doesn't hold any USDC, EURC, or cirBTC yet. Fund it with a testnet deposit to get started.
          </p>
          <PrimaryButton onClick={() => setPage("Deposit")}>Make a deposit</PrimaryButton>
        </GlassCard>
      ) : (
        <>
          {/* Individual token cards */}
          <div className="grid sm:grid-cols-3 gap-4">
            <GlassCard className="p-6">
              <div className="flex items-center justify-between mb-5">
                <span className="text-[var(--text-secondary)] text-sm font-medium">USDC</span>
                <span className="w-9 h-9 rounded-full bg-gradient-to-br from-cyan-400 to-cyan-600 flex items-center justify-center text-xs font-bold text-[var(--text-primary)]">
                  $
                </span>
              </div>
              {balances.USDC === "—" ? (
                <Skeleton className="h-9 w-28" />
              ) : (
                <p className="text-[var(--text-primary)] text-3xl font-semibold tabular-nums">{balances.USDC}</p>
              )}
            </GlassCard>
            <GlassCard className="p-6">
              <div className="flex items-center justify-between mb-5">
                <span className="text-[var(--text-secondary)] text-sm font-medium">EURC</span>
                <span className="w-9 h-9 rounded-full bg-gradient-to-br from-purple-400 to-purple-600 flex items-center justify-center text-xs font-bold text-[var(--text-primary)]">
                  €
                </span>
              </div>
              {balances.EURC === "—" ? (
                <Skeleton className="h-9 w-28" />
              ) : (
                <p className="text-[var(--text-primary)] text-3xl font-semibold tabular-nums">{balances.EURC}</p>
              )}
            </GlassCard>
            <GlassCard className="p-6">
              <div className="flex items-center justify-between mb-5">
                <span className="text-[var(--text-secondary)] text-sm font-medium">cirBTC</span>
                <span className="w-9 h-9 rounded-full bg-gradient-to-br from-orange-400 to-orange-600 flex items-center justify-center text-xs font-bold text-[var(--text-primary)]">
                  ₿
                </span>
              </div>
              {balances.cirBTC === "—" ? (
                <Skeleton className="h-9 w-28" />
              ) : (
                <p className="text-[var(--text-primary)] text-3xl font-semibold tabular-nums">{balances.cirBTC}</p>
              )}
            </GlassCard>
          </div>

          {/* Token mix donut + recent activity preview, side by side */}
          <div className="grid md:grid-cols-2 gap-4">
            <TokenAllocationDonut balances={balances} />
            <RecentActivityPreview setPage={setPage} />
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page: Transfer (real on-chain ERC-20 transfer via connected wallet) */
/* ------------------------------------------------------------------ */

function CirclePhase2Notice({ feature }) {
  return (
    <GlassCard className="p-6 max-w-lg">
      <h2 className="text-[var(--text-primary)] text-lg font-semibold mb-2">{feature}</h2>
      <p className="text-[var(--text-secondary)] text-sm">
        {feature} isn't wired up for Circle Wallets (email login) yet — that's
        planned for a follow-up build. Sign in with MetaMask or WalletConnect
        instead to use this feature right now.
      </p>
    </GlassCard>
  );
}

function TransferPage({ wallet }) {
  const [token, setToken] = useState("USDC");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(async () => {
    if (!wallet.address) {
      toast({ category: "Transfer", tone: "bad", title: "Not connected", message: "Connect your wallet first." });
      return;
    }
    if (!ethers.isAddress(to) || !amount) {
      toast({ category: "Transfer", tone: "bad", title: "Invalid input", message: "Enter a valid address and amount." });
      return;
    }

    if (wallet.isCircleWallet) {
      setSending(true);
      try {
        // Native USDC omits tokenAddress entirely; EURC/cirBTC are real
        // ERC-20 contracts so we pass their address through.
        const tokenAddress = token === NATIVE_TOKEN_SYMBOL ? undefined : CONTRACTS[token];
        await wallet.circleSendTransfer({ to, amount, tokenAddress });
        toast({ category: "Transfer", tone: "ok", title: "Transfer confirmed", message: `${amount} ${token} sent successfully.` });
        setTo("");
        setAmount("");
      } catch (e) {
        toast({ category: "Transfer", tone: "bad", title: "Transfer failed", message: e.message });
      } finally {
        setSending(false);
      }
      return;
    }

    if (!wallet.provider) {
      toast({ category: "Transfer", tone: "bad", title: "Not connected", message: "Connect your wallet first." });
      return;
    }
    setSending(true);
    try {
      const signer = await wallet.provider.getSigner();
      let tx;
      if (token === NATIVE_TOKEN_SYMBOL) {
        tx = await signer.sendTransaction({
          to,
          value: ethers.parseUnits(amount, NATIVE_BALANCE_DECIMALS),
        });
      } else {
        const contract = new ethers.Contract(CONTRACTS[token], ERC20_ABI, signer);
        const decimals = TOKEN_DECIMALS[token];
        tx = await contract.transfer(to, ethers.parseUnits(amount, decimals));
      }
      toast({ category: "Transfer", tone: "warn", title: "Transaction submitted", message: `${tx.hash.slice(0, 18)}…` });
      await tx.wait();
      pushTx({ type: "Transfer", token, to, amount, txHash: tx.hash, status: "confirmed" });
      toast({ category: "Transfer", tone: "ok", title: "Transfer confirmed", message: `${amount} ${token} sent successfully.` });
      setTo("");
      setAmount("");
    } catch (e) {
      toast({ category: "Transfer", tone: "bad", title: "Transfer failed", message: e.shortMessage || e.message });
    } finally {
      setSending(false);
    }
  }, [wallet, token, to, amount]);

  return (
    <GlassCard className="p-6 max-w-lg">
      <h2 className="text-[var(--text-primary)] text-lg font-semibold mb-4">Transfer</h2>
      {wallet.isCircleWallet && (
        <p className="text-cyan-300/70 text-xs mb-3">
          Circle Wallet: sending USDC, EURC, or cirBTC — you'll confirm with your PIN.
        </p>
      )}
      <label className="text-[var(--text-secondary)] text-xs">Token</label>
      <select
        value={token}
        onChange={(e) => setToken(e.target.value)}
        className="w-full mt-1 mb-3 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)]"
      >
        <option value="USDC">USDC</option>
        <option value="EURC">EURC</option>
        <option value="cirBTC">cirBTC</option>
      </select>
      <label className="text-[var(--text-secondary)] text-xs">Recipient address</label>
      <input
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="0x..."
        className="w-full mt-1 mb-3 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] font-mono text-sm"
      />
      <label className="text-[var(--text-secondary)] text-xs">Amount</label>
      <input
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="0.00"
        className="w-full mt-1 mb-4 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)]"
      />
      <PrimaryButton onClick={handleSend} disabled={sending}>
        {sending ? "Sending…" : "Send"}
      </PrimaryButton>
    </GlassCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Page: Bulk Transfer                                                 */
/* ------------------------------------------------------------------ */

function BulkTransferPage({ wallet }) {
  const [rows, setRows] = useState([{ to: "", amount: "" }]);
  const [token, setToken] = useState("USDC");
  const [log, setLog] = useState([]);

  const addRow = () => setRows((r) => [...r, { to: "", amount: "" }]);
  const updateRow = (i, field, val) =>
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, [field]: val } : row)));

  const runBatch = useCallback(async () => {
    if (!wallet.provider) {
      toast({ category: "Bulk Transfer", tone: "bad", title: "Not connected", message: "Connect your wallet first." });
      return;
    }
    const signer = await wallet.provider.getSigner();
    const isNative = token === NATIVE_TOKEN_SYMBOL;
    const contract = isNative ? null : new ethers.Contract(CONTRACTS[token], ERC20_ABI, signer);
    const decimals = isNative ? NATIVE_BALANCE_DECIMALS : TOKEN_DECIMALS[token];
    const results = [];
    let succeeded = 0;
    let failed = 0;
    for (const row of rows) {
      if (!ethers.isAddress(row.to) || !row.amount) continue;
      try {
        const tx = isNative
          ? await signer.sendTransaction({ to: row.to, value: ethers.parseUnits(row.amount, decimals) })
          : await contract.transfer(row.to, ethers.parseUnits(row.amount, decimals));
        await tx.wait();
        results.push(`✓ ${row.amount} ${token} → ${row.to.slice(0, 10)}… (${tx.hash.slice(0, 10)}…)`);
        succeeded++;
      } catch (e) {
        results.push(`✗ ${row.to.slice(0, 10)}… failed: ${e.shortMessage || e.message}`);
        failed++;
      }
    }
    writeLS(LS_KEYS.bulk, [{ id: crypto.randomUUID(), token, rows, timestamp: Date.now() }, ...readLS(LS_KEYS.bulk, [])]);
    setLog(results);
    toast({ category: "Bulk Transfer",
      tone: failed === 0 ? "ok" : succeeded === 0 ? "bad" : "warn",
      title: "Batch complete",
      message: `${succeeded} succeeded, ${failed} failed.`,
    });
  }, [wallet, rows, token]);

  if (wallet.isCircleWallet) return <CirclePhase2Notice feature="Bulk Transfer" />;

  return (
    <GlassCard className="p-6 max-w-2xl">
      <h2 className="text-[var(--text-primary)] text-lg font-semibold mb-4">Bulk Transfer</h2>
      <select
        value={token}
        onChange={(e) => setToken(e.target.value)}
        className="mb-3 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)]"
      >
        <option value="USDC">USDC</option>
        <option value="EURC">EURC</option>
        <option value="cirBTC">cirBTC</option>
      </select>
      {rows.map((row, i) => (
        <div key={i} className="flex gap-2 mb-2">
          <input
            value={row.to}
            onChange={(e) => updateRow(i, "to", e.target.value)}
            placeholder="0x recipient"
            className="flex-1 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] font-mono text-sm"
          />
          <input
            value={row.amount}
            onChange={(e) => updateRow(i, "amount", e.target.value)}
            placeholder="Amount"
            className="w-28 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)]"
          />
        </div>
      ))}
      <div className="flex gap-2 mt-2">
        <button onClick={addRow} className="text-cyan-300 text-sm">+ Add row</button>
      </div>
      <div className="mt-4">
        <PrimaryButton onClick={runBatch}>Send batch</PrimaryButton>
      </div>
      {log.length > 0 && (
        <div className="mt-4 space-y-1 text-xs font-mono text-[var(--text-soft)]">
          {log.map((l, i) => (
            <p key={i}>{l}</p>
          ))}
        </div>
      )}
    </GlassCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Page: Agent Payroll — chat-style front end over vaults, contractors, */
/*  and payroll runs. The 8 quick actions are deterministic and need no  */
/*  AI at all; free-text goes to /api/payroll-chat (Gemini function-     */
/*  calling), which picks one of the same actions. Read actions (check   */
/*  balance, list contractors, etc.) execute immediately either way.     */
/*  Anything that creates data or moves money — even when the AI         */
/*  proposed it — always opens the matching form instead of running      */
/*  straight away, so a person always explicitly confirms before real    */
/*  USDC moves.                                                          */
/* ------------------------------------------------------------------ */

function AgentPayrollPage({ wallet }) {
  const [vaults, setVaults] = useState([]);
  const [contractorsByVault, setContractorsByVault] = useState({});
  const [activeVaultId, setActiveVaultId] = useState(null);
  const [messages, setMessages] = useState([
    {
      id: "welcome",
      role: "assistant",
      text: 'I can help you manage USDC payroll on Arc Testnet — create vaults, add contractors, and run payments.\n\nWhat would you like to do?',
    },
  ]);
  const [pendingForm, setPendingForm] = useState(null);
  const [inputText, setInputText] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, pendingForm]);

  const activeVault = vaults.find((v) => v.id === activeVaultId) || null;

  const say = (text) => setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text }]);
  const sayUser = (text) => setMessages((m) => [...m, { id: crypto.randomUUID(), role: "user", text }]);

  // Vaults now live in Postgres (Neon), keyed by the connected wallet's
  // address rather than browser localStorage — same data on any device,
  // survives clearing site data. Loaded once per wallet on mount.
  useEffect(() => {
    if (!wallet.address) return;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/payroll/vaults?owner=${encodeURIComponent(wallet.address)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          say(data.error || "Couldn't load your vaults right now.");
          return;
        }
        setVaults(data.vaults);
        setActiveVaultId((cur) => cur ?? data.vaults[0]?.id ?? null);
      } catch {
        say("Couldn't reach the backend to load your vaults — try refreshing the page.");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.address]);

  // Contractor lists are fetched on demand rather than bundled with every
  // vault, and cached per vault — `force` bypasses the cache for the one
  // place that actually needs a guaranteed-fresh list (running payroll).
  const fetchContractors = async (vaultId, { force = false } = {}) => {
    if (!force && contractorsByVault[vaultId]) return contractorsByVault[vaultId];
    const res = await fetch(`${API_BASE}/payroll/vaults/${vaultId}/contractors?owner=${encodeURIComponent(wallet.address)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Couldn't load contractors.");
    setContractorsByVault((m) => ({ ...m, [vaultId]: data.contractors }));
    return data.contractors;
  };

  const actionCreateVault = async (name) => {
    try {
      const res = await fetch(`${API_BASE}/payroll/vaults`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: wallet.address, name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        say(data.error || "Couldn't create the vault.");
        return;
      }
      setVaults((v) => [...v, data.vault]);
      setActiveVaultId(data.vault.id);
      say(`Created vault "${name}" and switched to it. Add some contractors next, or run payroll once you have some.`);
    } catch {
      say("Couldn't reach the backend — try again in a moment.");
    }
  };

  const actionShowVaults = () => {
    if (vaults.length === 0) {
      say("You don't have any vaults yet — create one first.");
      return;
    }
    const lines = vaults.map(
      (v) => `• ${v.name}${v.id === activeVaultId ? " (active)" : ""} — ${v.contractorCount} contractor${v.contractorCount === 1 ? "" : "s"}`
    );
    say(`Your vaults:\n${lines.join("\n")}`);
  };

  const actionAddContractor = async (name, address) => {
    if (!activeVault) {
      say("You need an active vault first — create one, or switch to an existing one.");
      return;
    }
    if (!ethers.isAddress(address)) {
      say(`"${address}" isn't a valid address — double check it and try again.`);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/payroll/vaults/${activeVault.id}/contractors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: wallet.address, name, address }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        say(data.error || "Couldn't add that contractor.");
        return;
      }
      setContractorsByVault((m) => ({ ...m, [activeVault.id]: [...(m[activeVault.id] || []), data.contractor] }));
      setVaults((vs) => vs.map((v) => (v.id === activeVault.id ? { ...v, contractorCount: v.contractorCount + 1 } : v)));
      say(`Added ${name} (${address.slice(0, 10)}…) to "${activeVault.name}".`);
    } catch {
      say("Couldn't reach the backend — try again in a moment.");
    }
  };

  const actionListContractors = async () => {
    if (!activeVault) {
      say("No active vault — create one or switch to one first.");
      return;
    }
    try {
      const list = await fetchContractors(activeVault.id);
      if (list.length === 0) {
        say(`"${activeVault.name}" has no contractors yet.`);
        return;
      }
      const lines = list.map((c) => `• ${c.name} — ${c.address.slice(0, 10)}…`);
      say(`Contractors in "${activeVault.name}":\n${lines.join("\n")}`);
    } catch (e) {
      say(e.message || "Couldn't load contractors right now.");
    }
  };

  const actionCheckBalance = async () => {
    say("Checking your wallet balance…");
    try {
      let usdc = "0.00";
      if (wallet.isCircleWallet) {
        usdc = wallet.circleBalances?.USDC ?? wallet.circleBalance ?? "0.00";
      } else if (wallet.provider && wallet.address) {
        const bal = await withRpcRetry(() => wallet.provider.getBalance(wallet.address));
        usdc = ethers.formatUnits(bal, NATIVE_BALANCE_DECIMALS);
      }
      say(`Your current balance is ${Number(usdc).toFixed(4)} USDC.`);
    } catch (e) {
      say(`Couldn't check your balance right now: ${e.message}`);
    }
  };

  const actionSwitchVault = (vaultId) => {
    const v = vaults.find((x) => x.id === vaultId);
    if (!v) {
      say("Couldn't find that vault.");
      return;
    }
    setActiveVaultId(v.id);
    say(`Switched to "${v.name}".`);
  };

  const actionShowHistory = () => {
    const log = readLS(ACTIVITY_LOG_KEY, []);
    const payrollEntries = log.filter((e) => e.category === "Agent Payroll").slice(0, 8);
    if (payrollEntries.length === 0) {
      say("No payroll runs yet.");
      return;
    }
    const lines = payrollEntries.map((e) => `• ${e.title} — ${relativeTime(e.timestamp)}`);
    say(`Recent payroll activity:\n${lines.join("\n")}`);
  };

  // The one real money-moving action. Loops the same per-recipient send
  // TransferPage already uses for both wallet types, one at a time, so a
  // Circle wallet gets its normal per-send PIN confirmation on each
  // payment rather than one confirmation covering the whole batch.
  const actionRunPayroll = async (token, amountPerContractor) => {
    if (!activeVault) {
      say("Your active vault has no contractors to pay.");
      return;
    }
    let contractors;
    try {
      contractors = await fetchContractors(activeVault.id, { force: true });
    } catch (e) {
      say(e.message || "Couldn't load contractors for this vault.");
      return;
    }
    if (!contractors || contractors.length === 0) {
      say("Your active vault has no contractors to pay.");
      return;
    }
    setBusy(true);
    say(`Running payroll: ${amountPerContractor} ${token} to each of ${contractors.length} contractor(s) in "${activeVault.name}"…`);
    let succeeded = 0;
    let failed = 0;
    const results = [];
    for (const c of contractors) {
      try {
        if (wallet.isCircleWallet) {
          const tokenAddress = token === NATIVE_TOKEN_SYMBOL ? undefined : CONTRACTS[token];
          await wallet.circleSendTransfer({ to: c.address, amount: amountPerContractor, tokenAddress });
        } else {
          if (!wallet.provider) throw new Error("Wallet not connected.");
          const signer = await wallet.provider.getSigner();
          if (token === NATIVE_TOKEN_SYMBOL) {
            const tx = await signer.sendTransaction({ to: c.address, value: ethers.parseUnits(amountPerContractor, NATIVE_BALANCE_DECIMALS) });
            await tx.wait();
          } else {
            const contract = new ethers.Contract(CONTRACTS[token], ERC20_ABI, signer);
            const tx = await contract.transfer(c.address, ethers.parseUnits(amountPerContractor, TOKEN_DECIMALS[token]));
            await tx.wait();
          }
        }
        succeeded++;
        results.push(`✓ ${c.name}`);
      } catch (e) {
        failed++;
        results.push(`✗ ${c.name}: ${e.shortMessage || e.message}`);
      }
    }
    writeLS(ACTIVITY_LOG_KEY, [
      {
        id: crypto.randomUUID(),
        category: "Agent Payroll",
        tone: failed === 0 ? "ok" : succeeded === 0 ? "bad" : "warn",
        title: `Payroll run — ${activeVault.name}`,
        message: `${succeeded} paid, ${failed} failed (${amountPerContractor} ${token} each)`,
        timestamp: Date.now(),
      },
      ...readLS(ACTIVITY_LOG_KEY, []),
    ].slice(0, ACTIVITY_LOG_MAX_ENTRIES));
    toast({
      category: "Agent Payroll",
      tone: failed === 0 ? "ok" : succeeded === 0 ? "bad" : "warn",
      title: "Payroll run complete",
      message: `${succeeded} paid, ${failed} failed — ${activeVault.name}`,
    });
    say(`Payroll run finished:\n${results.join("\n")}`);
    setBusy(false);
  };

  const QUICK_ACTIONS = [
    { label: "Create my payroll vault", onClick: () => setPendingForm({ type: "createVault", name: "" }) },
    { label: "Show my vaults", onClick: actionShowVaults },
    { label: "Add a contractor", onClick: () => setPendingForm({ type: "addContractor", name: "", address: "" }) },
    { label: "Check vault balance", onClick: actionCheckBalance },
    { label: "List my contractors", onClick: actionListContractors },
    { label: "Run payroll for all", onClick: () => setPendingForm({ type: "runPayroll", token: "USDC", amount: "" }) },
    { label: "Switch vault", onClick: () => setPendingForm({ type: "switchVault" }) },
    { label: "Show payment history", onClick: actionShowHistory },
  ];

  // Maps a Gemini tool call onto the SAME forms/actions the buttons use.
  // Read-only calls execute immediately; anything that creates data or
  // moves money opens the matching form pre-filled instead of running
  // straight away — the AI proposes, the person still has to confirm.
  const applyToolCall = (toolCall) => {
    const { name, args = {} } = toolCall || {};
    switch (name) {
      case "show_vaults": return actionShowVaults();
      case "list_contractors": return actionListContractors();
      case "check_balance": return actionCheckBalance();
      case "show_history": return actionShowHistory();
      case "create_vault": return setPendingForm({ type: "createVault", name: args.name || "" });
      case "add_contractor": return setPendingForm({ type: "addContractor", name: args.name || "", address: args.address || "" });
      case "run_payroll": return setPendingForm({ type: "runPayroll", token: args.token || "USDC", amount: args.amount || "" });
      case "switch_vault": {
        const match = vaults.find((v) => v.name.toLowerCase() === (args.vaultName || "").toLowerCase());
        return setPendingForm({ type: "switchVault", suggestedId: match?.id ?? null });
      }
      default: say("I wasn't sure how to do that — try one of the buttons below.");
    }
  };

  const sendFreeText = async () => {
    const text = inputText.trim();
    if (!text || busy) return;
    sayUser(text);
    setInputText("");
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/payroll-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          context: {
            activeVaultName: activeVault?.name ?? null,
            vaults: vaults.map((v) => ({ name: v.name, contractorCount: v.contractorCount })),
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        say(data.error || "Something went wrong reaching the AI.");
        return;
      }
      if (data.reply) say(data.reply);
      if (data.toolCall) applyToolCall(data.toolCall);
    } catch {
      say("Couldn't reach the AI backend — you can still use the buttons below.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <GlassCard className="p-0 max-w-2xl overflow-hidden flex flex-col h-[560px]">
      <div className="px-5 py-4 border-b border-[var(--border-subtle)]">
        <h2 className="text-[var(--text-primary)] text-base font-semibold">Agent Payroll</h2>
        <p className="text-[var(--text-faint)] text-xs mt-0.5">
          {activeVault ? `Active vault: ${activeVault.name}` : "No active vault yet"}
        </p>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[80%] rounded-xl px-3.5 py-2.5 text-sm whitespace-pre-line ${
                m.role === "user"
                  ? "bg-gradient-to-r from-cyan-500 to-purple-600 text-white"
                  : "bg-[var(--surface-subtle)] text-[var(--text-primary)]"
              }`}
            >
              {m.text}
            </div>
          </div>
        ))}

        {pendingForm?.type === "createVault" && (
          <div className="bg-[var(--surface-subtle)] rounded-xl p-4 space-y-3">
            <p className="text-[var(--text-secondary)] text-xs">Vault name</p>
            <input
              autoFocus
              value={pendingForm.name}
              onChange={(e) => setPendingForm({ ...pendingForm, name: e.target.value })}
              placeholder="e.g. Engineering team"
              className="w-full bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm"
            />
            <div className="flex gap-2">
              <PrimaryButton
                disabled={!pendingForm.name.trim()}
                onClick={() => { actionCreateVault(pendingForm.name.trim()); setPendingForm(null); }}
              >
                Create
              </PrimaryButton>
              <button onClick={() => setPendingForm(null)} className="text-[var(--text-muted)] text-sm">Cancel</button>
            </div>
          </div>
        )}

        {pendingForm?.type === "addContractor" && (
          <div className="bg-[var(--surface-subtle)] rounded-xl p-4 space-y-3">
            {!activeVault ? (
              <p className="text-rose-300 text-xs">Create or switch to a vault first.</p>
            ) : (
              <>
                <p className="text-[var(--text-secondary)] text-xs">Adding to "{activeVault.name}"</p>
                <input
                  autoFocus
                  value={pendingForm.name}
                  onChange={(e) => setPendingForm({ ...pendingForm, name: e.target.value })}
                  placeholder="Contractor name"
                  className="w-full bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm"
                />
                <input
                  value={pendingForm.address}
                  onChange={(e) => setPendingForm({ ...pendingForm, address: e.target.value })}
                  placeholder="0x..."
                  className="w-full bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] font-mono text-sm"
                />
                <div className="flex gap-2">
                  <PrimaryButton
                    disabled={!pendingForm.name.trim() || !pendingForm.address.trim()}
                    onClick={() => { actionAddContractor(pendingForm.name.trim(), pendingForm.address.trim()); setPendingForm(null); }}
                  >
                    Add
                  </PrimaryButton>
                  <button onClick={() => setPendingForm(null)} className="text-[var(--text-muted)] text-sm">Cancel</button>
                </div>
              </>
            )}
          </div>
        )}

        {pendingForm?.type === "switchVault" && (
          <div className="bg-[var(--surface-subtle)] rounded-xl p-4 space-y-2">
            {vaults.length === 0 ? (
              <p className="text-[var(--text-secondary)] text-xs">No vaults yet — create one first.</p>
            ) : (
              vaults.map((v) => (
                <button
                  key={v.id}
                  onClick={() => { actionSwitchVault(v.id); setPendingForm(null); }}
                  className="w-full text-left px-3 py-2 rounded-lg bg-[var(--surface)] hover:bg-[var(--border-subtle)] text-[var(--text-primary)] text-sm"
                >
                  {v.name} · {v.contractorCount} contractor{v.contractorCount === 1 ? "" : "s"}
                </button>
              ))
            )}
            <button onClick={() => setPendingForm(null)} className="text-[var(--text-muted)] text-sm">Cancel</button>
          </div>
        )}

        {pendingForm?.type === "runPayroll" && (
          <div className="bg-[var(--surface-subtle)] rounded-xl p-4 space-y-3">
            {!activeVault || activeVault.contractorCount === 0 ? (
              <p className="text-rose-300 text-xs">Your active vault needs at least one contractor before you can run payroll.</p>
            ) : (
              <>
                <p className="text-amber-300 text-xs">
                  This pays {activeVault.contractorCount} contractor(s) in "{activeVault.name}" — real testnet USDC will move on-chain.
                </p>
                <div className="flex gap-2">
                  <select
                    value={pendingForm.token}
                    onChange={(e) => setPendingForm({ ...pendingForm, token: e.target.value })}
                    className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm"
                  >
                    <option value="USDC">USDC</option>
                    <option value="EURC">EURC</option>
                    <option value="cirBTC">cirBTC</option>
                  </select>
                  <input
                    value={pendingForm.amount}
                    onChange={(e) => setPendingForm({ ...pendingForm, amount: e.target.value })}
                    placeholder="Amount each"
                    className="flex-1 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm"
                  />
                </div>
                <div className="flex gap-2">
                  <PrimaryButton
                    disabled={!pendingForm.amount || busy}
                    onClick={async () => {
                      const { token, amount } = pendingForm;
                      setPendingForm(null);
                      await actionRunPayroll(token, amount);
                    }}
                  >
                    Confirm & pay all
                  </PrimaryButton>
                  <button onClick={() => setPendingForm(null)} className="text-[var(--text-muted)] text-sm">Cancel</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="px-5 py-3 border-t border-[var(--border-subtle)]">
        <div className="flex flex-wrap gap-1.5 mb-3">
          {QUICK_ACTIONS.map((a) => (
            <button
              key={a.label}
              onClick={a.onClick}
              disabled={busy}
              className="text-xs px-2.5 py-1.5 rounded-full border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] disabled:opacity-50 transition"
            >
              {a.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendFreeText()}
            placeholder="Message Agent Payroll…"
            disabled={busy}
            className="flex-1 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm disabled:opacity-50"
          />
          <button
            onClick={sendFreeText}
            disabled={busy || !inputText.trim()}
            className="w-10 h-10 rounded-lg bg-gradient-to-r from-cyan-500 to-purple-600 flex items-center justify-center text-white disabled:opacity-40 shrink-0"
            aria-label="Send"
          >
            →
          </button>
        </div>
      </div>
    </GlassCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Page: Swap — real integration point                                 */
/*  Swap MUST run server-side (Kit Key can never reach the browser),    */
/*  so this calls your own backend, which calls kit.swap() with the     */
/*  server-side adapter. See server/swapRoute.js for that endpoint.     */
/* ------------------------------------------------------------------ */

const SWAP_API_BASE = API_BASE;

function SwapPage({ wallet }) {
  const [tokenIn, setTokenIn] = useState("USDC");
  const [tokenOut, setTokenOut] = useState("EURC");
  const [amountIn, setAmountIn] = useState("");
  const [estimate, setEstimate] = useState(null);
  const [slippageBps, setSlippageBps] = useState(300);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [signerStatus, setSignerStatus] = useState(null);

  const tokenOptions = SWAP_SUPPORTED_TESTNET_TOKENS;

  useEffect(() => {
    let cancelled = false;
    fetch(`${SWAP_API_BASE}/swap/signer-status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) setSignerStatus(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleEstimate = useCallback(async () => {
    setErrorMsg(null);
    setEstimate(null);
    if (!amountIn) return;
    setBusy(true);
    try {
      const res = await fetch(`${SWAP_API_BASE}/estimate-swap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chain: "Arc_Testnet",
          tokenIn,
          tokenOut,
          amountIn,
          slippageBps,
          walletAddress: wallet.address,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Estimate failed");
      const data = await res.json();
      setEstimate(data);
    } catch (e) {
      setErrorMsg(
        e.message +
          " — thin testnet liquidity is the usual cause; try a smaller amount or raise slippage."
      );
    } finally {
      setBusy(false);
    }
  }, [tokenIn, tokenOut, amountIn, slippageBps, wallet.address]);

  const handleSwap = useCallback(async () => {
    if (!wallet.address) {
      setErrorMsg("Connect your wallet first.");
      toast({ category: "Swap", tone: "bad", title: "Not connected", message: "Connect your wallet first." });
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`${SWAP_API_BASE}/swap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chain: "Arc_Testnet",
          tokenIn,
          tokenOut,
          amountIn,
          slippageBps,
          walletAddress: wallet.address,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Swap failed");
      const data = await res.json();
      setResult(data);
      pushTx({
        type: "Swap",
        tokenIn,
        tokenOut,
        amountIn,
        estimatedOutput: data.estimatedOutput,
        status: data.status || "submitted",
      });
      toast({ category: "Swap",
        tone: "ok",
        title: "Swap submitted",
        message: `${amountIn} ${tokenIn} → ${tokenOut}`,
      });
    } catch (e) {
      setErrorMsg(e.message);
      toast({ category: "Swap", tone: "bad", title: "Swap failed", message: e.message });
    } finally {
      setBusy(false);
    }
  }, [wallet.address, tokenIn, tokenOut, amountIn, slippageBps]);

  return (
    <GlassCard className="p-6 max-w-lg">
      <h2 className="text-[var(--text-primary)] text-lg font-semibold mb-1">Swap</h2>
      <p className="text-[var(--text-muted)] text-xs mb-4">
        Runs server-side via Circle App Kit — client-side Swap isn't available yet.
      </p>

      {signerStatus?.lowBalance && (
        <div className="mb-4 px-3 py-2 rounded-lg border border-amber-500/30 bg-amber-950/40">
          <p className="text-amber-300 text-xs">
            The swap wallet is running low ({signerStatus.usdc.toFixed(2)} USDC,{" "}
            {signerStatus.eurc.toFixed(2)} EURC) — swaps may fail until it's topped up.
          </p>
        </div>
      )}

      <div className="flex gap-2 mb-3">
        <div className="flex-1">
          <label className="text-[var(--text-secondary)] text-xs">From</label>
          <select
            value={tokenIn}
            onChange={(e) => setTokenIn(e.target.value)}
            className="w-full mt-1 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)]"
          >
            {tokenOptions.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="flex-1">
          <label className="text-[var(--text-secondary)] text-xs">To</label>
          <select
            value={tokenOut}
            onChange={(e) => setTokenOut(e.target.value)}
            className="w-full mt-1 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)]"
          >
            {tokenOptions.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      </div>

      <label className="text-[var(--text-secondary)] text-xs">Amount in</label>
      <input
        value={amountIn}
        onChange={(e) => setAmountIn(e.target.value)}
        placeholder="0.00"
        className="w-full mt-1 mb-3 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)]"
      />

      <label className="text-[var(--text-secondary)] text-xs">Slippage (bps)</label>
      <input
        type="number"
        value={slippageBps}
        onChange={(e) => setSlippageBps(Number(e.target.value))}
        className="w-full mt-1 mb-4 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)]"
      />

      <div className="flex gap-2">
        <PrimaryButton disabled={busy || !amountIn} onClick={handleEstimate}>
          Estimate
        </PrimaryButton>
        <PrimaryButton disabled={busy || !estimate} onClick={handleSwap}>
          Confirm swap
        </PrimaryButton>
      </div>

      {estimate && (
        <div className="mt-4 text-sm text-[var(--text-soft)] space-y-1">
          <p>Estimated output: <span className="font-mono">{estimate.estimatedOutput?.amount} {estimate.estimatedOutput?.token}</span></p>
          <p>Guaranteed minimum: <span className="font-mono">{estimate.stopLimit?.amount} {estimate.stopLimit?.token}</span></p>
        </div>
      )}
      {result && (
        <p className="mt-3 text-xs text-emerald-300 break-all">
          Swap submitted — status: {result.status}
        </p>
      )}
      {errorMsg && <p className="mt-3 text-xs text-rose-300">{errorMsg}</p>}
    </GlassCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Page: Bridge — CCTP, Ethereum Sepolia -> Arc Testnet                */
/*  Real burn-and-mint (not a wrapped token): USDC is burned on Sepolia */
/*  and native USDC is minted fresh on Arc once Circle attests to the   */
/*  burn. Both legs are signed by the user's own connected wallet, so   */
/*  this only supports MetaMask/WalletConnect for now — Circle Wallets  */
/*  (email login) are currently initialized for Arc only.               */
/* ------------------------------------------------------------------ */

const SEPOLIA_USDC_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
];

const TOKEN_MESSENGER_ABI = [
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
];

const MESSAGE_TRANSMITTER_ABI = [
  "function receiveMessage(bytes message, bytes attestation)",
];

function BridgePage({ wallet }) {
  const [sourceKey, setSourceKey] = useState("ETH_SEPOLIA");
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState("idle"); // idle | provisioning | switching | approving | burning | attesting | minting | done | error
  const [log, setLog] = useState([]);
  const [error, setError] = useState(null);
  const busy = status !== "idle" && status !== "done" && status !== "error";
  const source = BRIDGE_SOURCE_CHAINS[sourceKey];
  const circleSourceWallet = wallet.isCircleWallet ? wallet.circleWalletsByChain?.[source.circleBlockchain] : null;
  const needsCircleWalletSetup = wallet.isCircleWallet && !circleSourceWallet;

  const appendLog = (line) => setLog((l) => [...l, line]);

  // Shared by both wallet paths: Circle explicitly warns against
  // hardcoding this fee (see the longer comment further down where it's
  // actually used) — always fetched fresh right before burning.
  const fetchMaxFee = useCallback(async (amountUnits) => {
    let maxFee = 500n; // fallback only if the live lookup itself fails
    try {
      const feeRes = await fetch(`${API_BASE}/bridge/fee?sourceDomain=${source.domain}&destDomain=${CCTP.ARC_TESTNET_DOMAIN}`);
      if (feeRes.ok) {
        const fees = await feeRes.json();
        const minimumFeeBps = fees?.[0]?.minimumFee;
        if (typeof minimumFeeBps === "number") {
          const protocolFee = (amountUnits * BigInt(Math.round(minimumFeeBps * 100))) / 1_000_000n;
          maxFee = (protocolFee * 120n) / 100n;
        }
      }
    } catch {
      // fall back to the flat default above
    }
    return maxFee;
  }, [source.domain]);

  const pollAttestation = useCallback(async (burnTxHash) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const res = await fetch(`${API_BASE}/bridge/attestation?domain=${source.domain}&txHash=${burnTxHash}`);
      if (res.ok) {
        const data = await res.json();
        if (data?.messages?.[0]?.status === "complete") return data.messages[0];
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    return null;
  }, [source.domain]);

  const runBridgeInjected = useCallback(async (amountUnits) => {
    setStatus("switching");
    appendLog(`Switching wallet to ${source.label}…`);
    await switchViaEthereum(source.chain);
    // Deliberately a BRAND NEW BrowserProvider here, not wallet.provider.
    // Ethers v6 throws "network changed" if you call getSigner() on a
    // provider instance that was already used on a different chain —
    // even with staticNetwork left at its default — so every leg of
    // this flow gets its own fresh instance right after switching.
    const sourceProvider = new ethers.BrowserProvider(window.ethereum);
    const sourceSigner = await sourceProvider.getSigner();

    setStatus("approving");
    appendLog("Approving USDC for the CCTP TokenMessenger…");
    const usdc = new ethers.Contract(source.usdc, SEPOLIA_USDC_ABI, sourceSigner);
    const approveTx = await withRpcRetry(() => usdc.approve(CCTP_TOKEN_MESSENGER, amountUnits));
    await withRpcRetry(() => approveTx.wait());
    appendLog(`Approved — ${approveTx.hash.slice(0, 14)}…`);

    appendLog("Checking the current Fast Transfer fee…");
    const maxFee = await fetchMaxFee(amountUnits);

    setStatus("burning");
    appendLog(`Burning USDC on ${source.label}…`);
    const tokenMessenger = new ethers.Contract(CCTP_TOKEN_MESSENGER, TOKEN_MESSENGER_ABI, sourceSigner);
    const mintRecipient = ethers.zeroPadValue(wallet.address, 32);
    const burnTx = await withRpcRetry(() =>
      tokenMessenger.depositForBurn(
        amountUnits,
        CCTP.ARC_TESTNET_DOMAIN,
        mintRecipient,
        source.usdc,
        ethers.ZeroHash, // destinationCaller — zero allows any address to call receiveMessage
        maxFee,
        1000 // minFinalityThreshold — 1000 or less selects Fast Transfer
      )
    );
    await withRpcRetry(() => burnTx.wait());
    appendLog(`Burned — ${burnTx.hash.slice(0, 14)}…`);

    setStatus("attesting");
    appendLog("Waiting for Circle's attestation (usually under a minute)…");
    const attestation = await pollAttestation(burnTx.hash);
    if (!attestation) {
      throw new Error(
        `Attestation didn't complete in time. Your USDC was burned on ${source.label} — it isn't lost, but you'll need to complete the mint manually once Circle finishes attesting. Try again shortly.`
      );
    }
    appendLog("Attestation received.");

    setStatus("minting");
    appendLog("Switching wallet back to Arc Testnet…");
    await switchViaEthereum(ARC_TESTNET);
    const arcProvider = new ethers.BrowserProvider(window.ethereum);
    const arcSigner = await arcProvider.getSigner();
    const transmitter = new ethers.Contract(CCTP.ARC_TESTNET_MESSAGE_TRANSMITTER, MESSAGE_TRANSMITTER_ABI, arcSigner);
    appendLog("Minting USDC on Arc Testnet…");
    const mintTx = await withRpcRetry(() => transmitter.receiveMessage(attestation.message, attestation.attestation));
    await withRpcRetry(() => mintTx.wait());
    appendLog(`Minted — ${mintTx.hash.slice(0, 14)}…`);
  }, [wallet.address, source, fetchMaxFee, pollAttestation]);

  // Circle wallets don't have a "switch network" concept — each
  // blockchain is a genuinely separate wallet (different walletId, same
  // Circle user), so this skips the switching steps entirely and just
  // targets the right wallet per call via executeContract's
  // targetWalletId. Every step is a PIN-confirmed challenge instead of a
  // MetaMask popup, same pattern already used for NFT Lock.
  const runBridgeCircle = useCallback(async (amountUnits) => {
    setStatus("approving");
    appendLog("Approving USDC for the CCTP TokenMessenger…");
    await wallet.circleExecuteContract({
      contractAddress: source.usdc,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [CCTP_TOKEN_MESSENGER, String(amountUnits)],
      targetWalletId: circleSourceWallet.id,
    });
    appendLog("Approved.");

    appendLog("Checking the current Fast Transfer fee…");
    const maxFee = await fetchMaxFee(amountUnits);

    setStatus("burning");
    appendLog(`Burning USDC on ${source.label}…`);
    const mintRecipient = ethers.zeroPadValue(wallet.address, 32);
    const burnTxHash = await wallet.circleExecuteContract({
      contractAddress: CCTP_TOKEN_MESSENGER,
      abiFunctionSignature: "depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)",
      abiParameters: [
        String(amountUnits),
        String(CCTP.ARC_TESTNET_DOMAIN),
        mintRecipient,
        source.usdc,
        ethers.ZeroHash,
        String(maxFee),
        "1000",
      ],
      targetWalletId: circleSourceWallet.id,
      onPoll: (seconds) => appendLog(`Still waiting on ${source.label} to confirm the burn (${seconds}s)…`),
    });
    appendLog(`Burned — ${burnTxHash.slice(0, 14)}…`);

    setStatus("attesting");
    appendLog("Waiting for Circle's attestation (usually under a minute)…");
    const attestation = await pollAttestation(burnTxHash);
    if (!attestation) {
      throw new Error(
        `Attestation didn't complete in time. Your USDC was burned on ${source.label} — it isn't lost, but you'll need to complete the mint manually once Circle finishes attesting. Try again shortly.`
      );
    }
    appendLog("Attestation received.");

    setStatus("minting");
    appendLog("Minting USDC on Arc Testnet…");
    await wallet.circleExecuteContract({
      contractAddress: CCTP.ARC_TESTNET_MESSAGE_TRANSMITTER,
      abiFunctionSignature: "receiveMessage(bytes,bytes)",
      abiParameters: [attestation.message, attestation.attestation],
      // no targetWalletId — defaults to the Arc wallet, which is exactly where this needs to run
    });
    appendLog("Minted.");
  }, [wallet, source, circleSourceWallet, fetchMaxFee, pollAttestation]);

  const runBridge = useCallback(async () => {
    if (!wallet.address) {
      toast({ category: "Bridge", tone: "bad", title: "Not connected", message: "Connect your wallet first." });
      return;
    }
    if (!amount || Number(amount) <= 0) {
      toast({ category: "Bridge", tone: "bad", title: "Invalid amount", message: "Enter an amount to bridge." });
      return;
    }
    if (needsCircleWalletSetup) {
      toast({ category: "Bridge", tone: "bad", title: "Wallet not set up", message: `Set up your ${source.label} wallet first.` });
      return;
    }
    setError(null);
    setLog([]);
    try {
      const amountUnits = ethers.parseUnits(amount, CCTP_USDC_DECIMALS);
      if (wallet.isCircleWallet) {
        await runBridgeCircle(amountUnits);
      } else {
        await runBridgeInjected(amountUnits);
      }
      setStatus("done");
      toast({ category: "Bridge", tone: "ok", title: "Bridge complete", message: `${amount} USDC arrived on Arc Testnet.` });
    } catch (e) {
      setError(e.shortMessage || e.message);
      setStatus("error");
      toast({ category: "Bridge", tone: "bad", title: "Bridge failed", message: e.shortMessage || e.message });
    }
  }, [wallet, amount, source, needsCircleWalletSetup, runBridgeCircle, runBridgeInjected]);

  const [settingUpWallet, setSettingUpWallet] = useState(false);
  const handleSetupWallet = useCallback(async () => {
    setSettingUpWallet(true);
    try {
      await wallet.circleCreateWallet(source.circleBlockchain);
      toast({ category: "Bridge", tone: "ok", title: "Wallet ready", message: `Set up on ${source.label}.` });
    } catch (e) {
      toast({ category: "Bridge", tone: "bad", title: "Setup failed", message: e.shortMessage || e.message });
    } finally {
      setSettingUpWallet(false);
    }
  }, [wallet, source]);

  return (
    <GlassCard className="p-6 max-w-lg">
      <h2 className="text-[var(--text-primary)] text-lg font-semibold mb-1">Bridge</h2>
      <p className="text-[var(--text-muted)] text-xs mb-4">
        Move USDC in from another testnet via Circle's CCTP — a real burn on
        the source chain and a fresh native mint on Arc, not a wrapped
        token.{" "}
        {wallet.isCircleWallet
          ? "Each step is a separate PIN confirmation."
          : "Your wallet will prompt you to switch networks twice (source chain to burn, Arc to mint)."}
      </p>

      <label className="text-[var(--text-secondary)] text-xs">From</label>
      <div className="grid grid-cols-3 gap-2 mt-1 mb-3">
        {Object.entries(BRIDGE_SOURCE_CHAINS).map(([key, cfg]) => (
          <button
            key={key}
            type="button"
            onClick={() => setSourceKey(key)}
            disabled={busy}
            className={`px-2 py-2.5 rounded-lg text-xs font-medium border transition text-center disabled:opacity-50 disabled:cursor-not-allowed ${
              sourceKey === key
                ? "bg-gradient-to-r from-cyan-500/20 to-purple-600/20 border-cyan-400 text-[var(--text-primary)]"
                : "bg-[var(--surface-subtle)] border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
            }`}
          >
            {cfg.label}
          </button>
        ))}
      </div>

      <details className="mb-4 group">
        <summary className="text-xs text-cyan-300/80 cursor-pointer select-none hover:text-cyan-300">
          Need gas on {source.label}?
        </summary>
        <div className="mt-2 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg p-3">
          <p className="text-[var(--text-muted)] text-[11px] mb-2">
            Bridging needs a small amount of {source.chain.nativeCurrency.symbol} on {source.label} to pay gas for the approve/burn steps — separate from the USDC you're bridging. These faucets don't require holding mainnet ETH first:
          </p>
          <div className="flex flex-col gap-1">
            {(BRIDGE_GAS_FAUCETS[sourceKey] || []).map((f) => (
              <a key={f.url} href={f.url} target="_blank" rel="noreferrer" className="text-cyan-300 text-xs underline">
                {f.name} →
              </a>
            ))}
          </div>
        </div>
      </details>

      {needsCircleWalletSetup ? (
        <div className="mb-4 bg-cyan-950/30 border border-cyan-500/20 rounded-lg p-3">
          <p className="text-cyan-200 text-xs mb-2">
            Your Circle Wallet doesn't have a wallet on {source.label} yet — needed to hold and burn USDC there. One-time setup, PIN-confirmed.
          </p>
          <PrimaryButton disabled={settingUpWallet} onClick={handleSetupWallet}>
            {settingUpWallet ? "Setting up…" : `Set up ${source.label} wallet`}
          </PrimaryButton>
        </div>
      ) : (
        <>
          {wallet.isCircleWallet && circleSourceWallet && (
            <p className="text-[var(--text-muted)] text-[11px] mb-3 break-all">
              Your {source.label} wallet: <span className="font-mono">{circleSourceWallet.address}</span>
              {" — "}
              <a
                href={`${source.chain.blockExplorerUrls[0]}/address/${circleSourceWallet.address}`}
                target="_blank"
                rel="noreferrer"
                className="text-cyan-300"
              >
                view on explorer →
              </a>
            </p>
          )}
          <label className="text-[var(--text-secondary)] text-xs">Amount (USDC on {source.label})</label>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            disabled={busy}
            className="w-full mt-1 mb-4 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)]"
          />

          <PrimaryButton disabled={busy} onClick={runBridge}>
            {busy ? "Bridging…" : "Bridge to Arc Testnet"}
          </PrimaryButton>
        </>
      )}

      {log.length > 0 && (
        <div className="mt-4 space-y-1">
          {log.map((line, i) => (
            <p key={i} className="text-[var(--text-tertiary)] text-xs font-mono">{line}</p>
          ))}
        </div>
      )}
      {error && <p className="mt-3 text-xs text-rose-300">{error}</p>}
      {status === "done" && (
        <p className="mt-3 text-xs text-emerald-300">Done — check your Dashboard balance.</p>
      )}
    </GlassCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Page: Lending — ArclifyLendingPool.sol                             */
/*  Deposit USDC as collateral, borrow EURC against it.                */
/* ------------------------------------------------------------------ */

function LendingPage({ wallet }) {
  const [account, setAccount] = useState(null); // { collateral, debt, maxBorrowable, liquidatable, availableLiquidity }
  const [poolInfo, setPoolInfo] = useState(null); // { exchangeRate, collateralFactorBps, liquidationThresholdBps, interestRateBps }
  const [loadError, setLoadError] = useState(null);
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [borrowAmount, setBorrowAmount] = useState("");
  const [repayAmount, setRepayAmount] = useState("");
  const [fundAmount, setFundAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [lastSynced, setLastSynced] = useState(null);

  const loadAccount = useCallback(async () => {
    if (!wallet.address) return;
    const provider = wallet.provider || readOnlyProvider;
    const pool = new ethers.Contract(LENDING_POOL_ADDRESS, LENDING_POOL_ABI, provider);
    try {
      const [position, debt, maxBorrowable, liquidatable, liquidity, rate, cf, lt, ir] = await Promise.all([
        withRpcRetry(() => pool.positions(wallet.address)),
        withRpcRetry(() => pool.getCurrentDebt(wallet.address)),
        withRpcRetry(() => pool.getMaxBorrowable(wallet.address)),
        withRpcRetry(() => pool.isLiquidatable(wallet.address)),
        withRpcRetry(() => pool.availableLiquidity()),
        withRpcRetry(() => pool.exchangeRate()),
        withRpcRetry(() => pool.collateralFactorBps()),
        withRpcRetry(() => pool.liquidationThresholdBps()),
        withRpcRetry(() => pool.interestRateBps()),
      ]);
      setAccount({
        collateral: ethers.formatUnits(position.collateralAmount, STABLECOIN_DECIMALS),
        debt: ethers.formatUnits(debt, STABLECOIN_DECIMALS),
        maxBorrowable: ethers.formatUnits(maxBorrowable, STABLECOIN_DECIMALS),
        liquidatable,
        availableLiquidity: ethers.formatUnits(liquidity, STABLECOIN_DECIMALS),
      });
      setPoolInfo({
        exchangeRate: Number(rate) / 1_000_000,
        collateralFactorBps: Number(cf),
        liquidationThresholdBps: Number(lt),
        interestRateBps: Number(ir),
      });
      setLoadError(null);
      setLastSynced(Date.now());
    } catch (e) {
      console.warn("Failed to load lending account data:", e);
      setLoadError(e.shortMessage || e.message || "Failed to load account data.");
    }
  }, [wallet.provider, wallet.address, refreshKey]);

  useEffect(() => {
    loadAccount();
  }, [loadAccount]);

  const refresh = () => setRefreshKey((k) => k + 1);

  const handleDeposit = useCallback(async () => {
    if (!wallet.address) {
      toast({ category: "Lending", tone: "bad", title: "Not connected", message: "Connect your wallet first." });
      return;
    }
    if (!depositAmount || Number(depositAmount) <= 0) return;
    setBusy(true);
    try {
      const amountUnits = ethers.parseUnits(depositAmount, STABLECOIN_DECIMALS);
      await lendingApproveAndCall(wallet, {
        tokenAddress: CONTRACTS.USDC,
        amountUnits,
        functionSignature: "depositCollateral(uint256)",
        functionParams: [amountUnits],
      });
      toast({ category: "Lending", tone: "ok", title: "Collateral deposited", message: `${depositAmount} USDC added.` });
      setDepositAmount("");
      refresh();
    } catch (e) {
      toast({ category: "Lending", tone: "bad", title: "Deposit failed", message: e.shortMessage || e.message });
    } finally {
      setBusy(false);
    }
  }, [wallet, depositAmount]);

  const handleWithdraw = useCallback(async () => {
    if (!withdrawAmount || Number(withdrawAmount) <= 0) return;
    setBusy(true);
    try {
      const amountUnits = ethers.parseUnits(withdrawAmount, STABLECOIN_DECIMALS);
      await lendingCall(wallet, {
        functionSignature: "withdrawCollateral(uint256)",
        functionParams: [amountUnits],
      });
      toast({ category: "Lending", tone: "ok", title: "Collateral withdrawn", message: `${withdrawAmount} USDC returned.` });
      setWithdrawAmount("");
      refresh();
    } catch (e) {
      toast({ category: "Lending", tone: "bad", title: "Withdraw failed", message: e.shortMessage || e.message });
    } finally {
      setBusy(false);
    }
  }, [wallet, withdrawAmount]);

  const handleBorrow = useCallback(async () => {
    if (!borrowAmount || Number(borrowAmount) <= 0) return;
    setBusy(true);
    try {
      const amountUnits = ethers.parseUnits(borrowAmount, STABLECOIN_DECIMALS);
      await lendingCall(wallet, {
        functionSignature: "borrow(uint256)",
        functionParams: [amountUnits],
      });
      toast({ category: "Lending", tone: "ok", title: "Borrowed", message: `${borrowAmount} EURC sent to your wallet.` });
      setBorrowAmount("");
      refresh();
    } catch (e) {
      toast({ category: "Lending", tone: "bad", title: "Borrow failed", message: e.shortMessage || e.message });
    } finally {
      setBusy(false);
    }
  }, [wallet, borrowAmount]);

  const handleRepay = useCallback(async () => {
    if (!repayAmount || Number(repayAmount) <= 0) return;
    setBusy(true);
    try {
      const amountUnits = ethers.parseUnits(repayAmount, STABLECOIN_DECIMALS);
      await lendingApproveAndCall(wallet, {
        tokenAddress: CONTRACTS.EURC,
        amountUnits,
        functionSignature: "repay(uint256)",
        functionParams: [amountUnits],
      });
      toast({ category: "Lending", tone: "ok", title: "Repaid", message: `${repayAmount} EURC repaid.` });
      setRepayAmount("");
      refresh();
    } catch (e) {
      toast({ category: "Lending", tone: "bad", title: "Repay failed", message: e.shortMessage || e.message });
    } finally {
      setBusy(false);
    }
  }, [wallet, repayAmount]);

  const handleFundPool = useCallback(async () => {
    if (!fundAmount || Number(fundAmount) <= 0) return;
    setBusy(true);
    try {
      const amountUnits = ethers.parseUnits(fundAmount, STABLECOIN_DECIMALS);
      await lendingApproveAndCall(wallet, {
        tokenAddress: CONTRACTS.EURC,
        amountUnits,
        functionSignature: "fundPool(uint256)",
        functionParams: [amountUnits],
      });
      toast({ category: "Lending", tone: "ok", title: "Pool funded", message: `${fundAmount} EURC added to available liquidity.` });
      setFundAmount("");
      refresh();
    } catch (e) {
      toast({ category: "Lending", tone: "bad", title: "Fund pool failed", message: e.shortMessage || e.message });
    } finally {
      setBusy(false);
    }
  }, [wallet, fundAmount]);

  return (
    <GlassCard className="p-6 max-w-lg">
      <div className="flex items-start justify-between gap-3 mb-1">
        <h2 className="text-[var(--text-primary)] text-lg font-semibold">Lending</h2>
        <div className="text-right shrink-0">
          <button
            onClick={refresh}
            className="text-[var(--text-muted)] text-xs hover:text-[var(--text-soft)] underline decoration-dotted"
          >
            Refresh
          </button>
          {lastSynced && (
            <p className="text-[var(--text-faint)] text-[10px] mt-0.5">Last synced {relativeTime(lastSynced)}</p>
          )}
        </div>
      </div>
      <p className="text-[var(--text-muted)] text-xs mb-4">
        Deposit USDC as collateral, borrow EURC against it. Fixed exchange
        rate (not a live oracle) and fixed interest — a starting point, not
        a production money market. Contract:{" "}
        <span className="font-mono">{LENDING_POOL_ADDRESS.slice(0, 10)}…</span>
      </p>

      {loadError && !account && (
        <div className="mb-5 text-xs text-rose-300 bg-rose-950/40 border border-rose-500/30 rounded-lg p-3">
          <p className="mb-2">Couldn't load your position: {loadError}</p>
          <button
            onClick={() => setRefreshKey((k) => k + 1)}
            className="text-cyan-300 hover:text-cyan-200 font-medium"
          >
            Retry →
          </button>
        </div>
      )}

      {!account && !loadError && (
        <div className="grid grid-cols-2 gap-3 mb-5 text-sm">
          {["Your collateral", "Your debt", "Max borrowable", "Pool liquidity"].map((label) => (
            <div key={label} className="bg-[var(--surface-subtle)] rounded-lg p-3">
              <p className="text-[var(--text-muted)] text-xs mb-2">{label}</p>
              <Skeleton className="h-5 w-20" />
            </div>
          ))}
        </div>
      )}

      {account && (
        <div className="grid grid-cols-2 gap-3 mb-5 text-sm">
          <div className="bg-[var(--surface-subtle)] rounded-lg p-3">
            <p className="text-[var(--text-muted)] text-xs">Your collateral</p>
            <p className="text-[var(--text-primary)] font-medium">{Number(account.collateral).toFixed(4)} USDC</p>
          </div>
          <div className="bg-[var(--surface-subtle)] rounded-lg p-3">
            <p className="text-[var(--text-muted)] text-xs">Your debt</p>
            <p className="text-[var(--text-primary)] font-medium">{Number(account.debt).toFixed(4)} EURC</p>
          </div>
          <div className="bg-[var(--surface-subtle)] rounded-lg p-3">
            <p className="text-[var(--text-muted)] text-xs">Max borrowable</p>
            <p className="text-[var(--text-primary)] font-medium">{Number(account.maxBorrowable).toFixed(4)} EURC</p>
          </div>
          <div className="bg-[var(--surface-subtle)] rounded-lg p-3">
            <p className="text-[var(--text-muted)] text-xs">Pool liquidity</p>
            <p className="text-[var(--text-primary)] font-medium">{Number(account.availableLiquidity).toFixed(2)} EURC</p>
          </div>
        </div>
      )}

      {account?.liquidatable && (
        <p className="mb-4 text-xs text-rose-300 bg-rose-950/40 border border-rose-500/30 rounded-lg p-3">
          Your position is eligible for liquidation — your debt has exceeded the safe threshold. Repay some debt now to avoid losing your collateral.
        </p>
      )}

      {!poolInfo && (
        <Skeleton className="h-3 w-full max-w-md mb-5" />
      )}

      {poolInfo && (
        <p className="text-[var(--text-faint)] text-[11px] mb-5">
          Rate: 1 USDC = {poolInfo.exchangeRate.toFixed(4)} EURC · Max LTV {poolInfo.collateralFactorBps / 100}% · Liquidation at {poolInfo.liquidationThresholdBps / 100}% · {poolInfo.interestRateBps / 100}% APR
        </p>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-[var(--text-secondary)] text-xs">Deposit collateral (USDC)</label>
          <input
            value={depositAmount}
            onChange={(e) => setDepositAmount(e.target.value)}
            placeholder="0.00"
            disabled={busy}
            className="w-full mt-1 mb-2 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm"
          />
          <PrimaryButton disabled={busy} onClick={handleDeposit}>Deposit</PrimaryButton>
        </div>
        <div>
          <label className="text-[var(--text-secondary)] text-xs">Withdraw collateral (USDC)</label>
          <input
            value={withdrawAmount}
            onChange={(e) => setWithdrawAmount(e.target.value)}
            placeholder="0.00"
            disabled={busy}
            className="w-full mt-1 mb-2 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm"
          />
          <PrimaryButton disabled={busy} onClick={handleWithdraw}>Withdraw</PrimaryButton>
        </div>
        <div>
          <label className="text-[var(--text-secondary)] text-xs">Borrow (EURC)</label>
          <input
            value={borrowAmount}
            onChange={(e) => setBorrowAmount(e.target.value)}
            placeholder="0.00"
            disabled={busy}
            className="w-full mt-1 mb-2 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm"
          />
          <PrimaryButton disabled={busy} onClick={handleBorrow}>Borrow</PrimaryButton>
        </div>
        <div>
          <label className="text-[var(--text-secondary)] text-xs">Repay (EURC)</label>
          <input
            value={repayAmount}
            onChange={(e) => setRepayAmount(e.target.value)}
            placeholder="0.00"
            disabled={busy}
            className="w-full mt-1 mb-2 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm"
          />
          <PrimaryButton disabled={busy} onClick={handleRepay}>Repay</PrimaryButton>
        </div>
      </div>

      <div className="mt-6 pt-5 border-t border-[var(--border)]">
        <p className="text-[var(--text-muted)] text-xs mb-2">
          Fund the pool — adds EURC that anyone can borrow against their collateral. No individual yield tracking yet for suppliers (known limitation for this first version).
        </p>
        <div className="flex gap-2">
          <input
            value={fundAmount}
            onChange={(e) => setFundAmount(e.target.value)}
            placeholder="0.00"
            disabled={busy}
            className="flex-1 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm"
          />
          <PrimaryButton disabled={busy} onClick={handleFundPool}>Fund Pool</PrimaryButton>
        </div>
      </div>
    </GlassCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Page: ArclifyUSD (aUSD) — USDC-collateralized testnet stablecoin    */
/*  mint()/redeem() are atomic 1:1 swaps with USDC, so the contract is  */
/*  always fully backed by construction — collateralBalance() lets      */
/*  anyone verify that on-chain rather than just trusting a claim.      */
/* ------------------------------------------------------------------ */

function ArclifyUSDPage({ wallet }) {
  const [myBalance, setMyBalance] = useState(null);
  const [totalSupply, setTotalSupply] = useState(null);
  const [collateral, setCollateral] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [mintAmount, setMintAmount] = useState("");
  const [redeemAmount, setRedeemAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [lastSynced, setLastSynced] = useState(null);

  const loadData = useCallback(async () => {
    const provider = wallet.provider || readOnlyProvider;
    const ausd = new ethers.Contract(ARCLIFY_USD_ADDRESS, ARCLIFY_USD_ABI, provider);
    try {
      const [supply, coll, mine] = await Promise.all([
        withRpcRetry(() => ausd.totalSupply()),
        withRpcRetry(() => ausd.collateralBalance()),
        wallet.address ? withRpcRetry(() => ausd.balanceOf(wallet.address)) : Promise.resolve(0n),
      ]);
      setTotalSupply(ethers.formatUnits(supply, STABLECOIN_DECIMALS));
      setCollateral(ethers.formatUnits(coll, STABLECOIN_DECIMALS));
      setMyBalance(ethers.formatUnits(mine, STABLECOIN_DECIMALS));
      setLoadError(null);
      setLastSynced(Date.now());
    } catch (e) {
      console.warn("Failed to load ArclifyUSD data:", e);
      setLoadError(e.shortMessage || e.message || "Failed to load ArclifyUSD data.");
    }
  }, [wallet.provider, wallet.address, refreshKey]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const refresh = () => setRefreshKey((k) => k + 1);

  const handleMint = useCallback(async () => {
    if (!wallet.address) {
      toast({ category: "ArclifyUSD", tone: "bad", title: "Not connected", message: "Connect your wallet first." });
      return;
    }
    if (!mintAmount || Number(mintAmount) <= 0) return;
    setBusy(true);
    try {
      const amountUnits = ethers.parseUnits(mintAmount, STABLECOIN_DECIMALS);
      await arclifyUsdMint(wallet, amountUnits);
      toast({ category: "ArclifyUSD", tone: "ok", title: "aUSD minted", message: `${mintAmount} USDC deposited, ${mintAmount} aUSD received.` });
      setMintAmount("");
      refresh();
    } catch (e) {
      toast({ category: "ArclifyUSD", tone: "bad", title: "Mint failed", message: e.shortMessage || e.message });
    } finally {
      setBusy(false);
    }
  }, [wallet, mintAmount]);

  const handleRedeem = useCallback(async () => {
    if (!redeemAmount || Number(redeemAmount) <= 0) return;
    setBusy(true);
    try {
      const amountUnits = ethers.parseUnits(redeemAmount, STABLECOIN_DECIMALS);
      await arclifyUsdRedeem(wallet, amountUnits);
      toast({ category: "ArclifyUSD", tone: "ok", title: "aUSD redeemed", message: `${redeemAmount} aUSD burned, ${redeemAmount} USDC returned.` });
      setRedeemAmount("");
      refresh();
    } catch (e) {
      toast({ category: "ArclifyUSD", tone: "bad", title: "Redeem failed", message: e.shortMessage || e.message });
    } finally {
      setBusy(false);
    }
  }, [wallet, redeemAmount]);

  const fullyBacked = totalSupply !== null && collateral !== null && Number(collateral) >= Number(totalSupply);

  return (
    <GlassCard className="p-6 max-w-2xl">
      <div className="flex items-start justify-between gap-3 mb-1">
        <h2 className="text-[var(--text-primary)] text-lg font-semibold">ArclifyUSD (aUSD)</h2>
        <div className="text-right shrink-0">
          <button
            onClick={refresh}
            className="text-[var(--text-muted)] text-xs hover:text-[var(--text-soft)] underline decoration-dotted"
          >
            Refresh
          </button>
          {lastSynced && (
            <p className="text-[var(--text-faint)] text-[10px] mt-0.5">Last synced {relativeTime(lastSynced)}</p>
          )}
        </div>
      </div>
      <p className="text-[var(--text-muted)] text-xs mb-4">
        A USDC-collateralized testnet stablecoin — deposit USDC, mint aUSD 1:1; burn aUSD, get USDC back 1:1. No free minting, no algorithmic peg — just a real vault. Contract:{" "}
        <span className="font-mono">{ARCLIFY_USD_ADDRESS.slice(0, 10)}…</span>
      </p>

      {loadError && (
        <p className="mb-4 text-xs text-rose-300 bg-rose-950/40 border border-rose-500/30 rounded-lg p-3">{loadError}</p>
      )}

      <div className="grid grid-cols-2 gap-3 mb-3 text-sm">
        <div className="bg-[var(--surface-subtle)] rounded-lg p-3">
          <p className="text-[var(--text-muted)] text-xs mb-2">Your aUSD balance</p>
          {myBalance === null ? <Skeleton className="h-5 w-20" /> : (
            <p className="text-[var(--text-primary)] font-medium">{Number(myBalance).toFixed(4)} aUSD</p>
          )}
        </div>
        <div className="bg-[var(--surface-subtle)] rounded-lg p-3">
          <p className="text-[var(--text-muted)] text-xs mb-2">Total aUSD supply</p>
          {totalSupply === null ? <Skeleton className="h-5 w-20" /> : (
            <p className="text-[var(--text-primary)] font-medium">{Number(totalSupply).toFixed(4)} aUSD</p>
          )}
        </div>
      </div>

      <div className="bg-[var(--surface-subtle)] rounded-lg p-3 mb-5 text-sm flex items-center justify-between">
        <div>
          <p className="text-[var(--text-muted)] text-xs mb-1">USDC held in the contract (proof of backing)</p>
          {collateral === null ? <Skeleton className="h-5 w-24" /> : (
            <p className="text-[var(--text-primary)] font-medium">{Number(collateral).toFixed(4)} USDC</p>
          )}
        </div>
        {totalSupply !== null && collateral !== null && (
          <Pill tone={fullyBacked ? "ok" : "bad"}>{fullyBacked ? "Fully backed" : "Under-collateralized"}</Pill>
        )}
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label className="text-[var(--text-secondary)] text-xs">Mint aUSD (deposit USDC)</label>
          <input
            value={mintAmount}
            onChange={(e) => setMintAmount(e.target.value)}
            placeholder="0.00"
            disabled={busy}
            className="w-full mt-1 mb-2 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm disabled:opacity-50"
          />
          <PrimaryButton disabled={busy || !mintAmount} onClick={handleMint} className="w-full">
            Mint
          </PrimaryButton>
        </div>
        <div>
          <label className="text-[var(--text-secondary)] text-xs">Redeem aUSD (get USDC back)</label>
          <input
            value={redeemAmount}
            onChange={(e) => setRedeemAmount(e.target.value)}
            placeholder="0.00"
            disabled={busy}
            className="w-full mt-1 mb-2 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm disabled:opacity-50"
          />
          <PrimaryButton disabled={busy || !redeemAmount} onClick={handleRedeem} className="w-full">
            Redeem
          </PrimaryButton>
        </div>
      </div>
    </GlassCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Page: Off-Ramp (PROTOTYPE) — USDC/EURC -> local currency payout     */
/*                                                                      */
/*  Two genuinely different halves, and it matters that they're kept    */
/*  visually distinct rather than blurred together:                     */
/*                                                                      */
/*  REAL: the exchange rate (live public FX feed) and the on-chain leg  */
/*  — the token actually leaves the user's wallet on Arc Testnet,       */
/*  verifiable on Arcscan like any other transaction here.              */
/*                                                                      */
/*  SIMULATED: the fiat payout. Actually paying into a bank account or  */
/*  mobile money wallet needs a licensed money-transmitter partner      */
/*  (e.g. HoneyCoin, Eversend, Quidax for African corridors) — real     */
/*  business credentials this testnet project doesn't have. Swapping    */
/*  in a real provider later only touches the /offramp/simulate call,   */
/*  not this page's structure.                                          */
/* ------------------------------------------------------------------ */

// Testnet burn address — where the demo's "real" on-chain leg sends
// funds, standing in for "custody handed off to an off-ramp provider."
// Not a real provider's deposit address; nothing is recoverable from
// here, same as any burn address, which is honest for what this is.
const OFFRAMP_DEMO_ADDRESS = "0x000000000000000000000000000000000000dEaD";

const OFFRAMP_CURRENCIES = { NGN: "Nigerian Naira", KES: "Kenyan Shilling", GHS: "Ghanaian Cedi" };

function OffRampPage({ wallet }) {
  const [token, setToken] = useState("USDC");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("NGN");
  const [payoutMethod, setPayoutMethod] = useState("bank");
  const [bankName, setBankName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [momoProvider, setMomoProvider] = useState("");
  const [phone, setPhone] = useState("");

  const [rate, setRate] = useState(null); // { rate, currencyName, asOf, source }
  const [rateLoading, setRateLoading] = useState(false);
  const [step, setStep] = useState("idle"); // idle | onchain | converting | paying_out | settled | error
  const [log, setLog] = useState([]);
  const [result, setResult] = useState(null);
  const busy = step !== "idle" && step !== "settled" && step !== "error";

  const appendLog = (line) => setLog((l) => [...l, line]);

  const fetchRate = useCallback(async () => {
    setRateLoading(true);
    try {
      const res = await fetch(`${API_BASE}/offramp/rate?currency=${currency}`);
      if (!res.ok) throw new Error("Rate lookup failed.");
      setRate(await res.json());
    } catch (e) {
      toast({ category: "Withdraw", tone: "bad", title: "Rate lookup failed", message: e.message });
      setRate(null);
    } finally {
      setRateLoading(false);
    }
  }, [currency]);

  useEffect(() => { fetchRate(); }, [fetchRate]);

  const localAmount = rate && amount ? (Number(amount) * rate.rate).toLocaleString(undefined, { maximumFractionDigits: 2 }) : null;

  const handleCashOut = useCallback(async () => {
    if (!wallet.address) {
      toast({ category: "Withdraw", tone: "bad", title: "Not connected", message: "Connect your wallet first." });
      return;
    }
    if (!amount || Number(amount) <= 0) {
      toast({ category: "Withdraw", tone: "bad", title: "Invalid amount", message: "Enter an amount to withdraw." });
      return;
    }
    if (payoutMethod === "bank" && (!bankName || !accountNumber)) {
      toast({ category: "Withdraw", tone: "bad", title: "Missing details", message: "Enter a bank name and account number." });
      return;
    }
    if (payoutMethod === "momo" && (!momoProvider || !phone)) {
      toast({ category: "Withdraw", tone: "bad", title: "Missing details", message: "Enter a mobile money provider and phone number." });
      return;
    }

    setLog([]);
    setResult(null);
    try {
      // --- REAL leg: send the token on-chain, same pattern as Transfer ---
      setStep("onchain");
      appendLog(`Sending ${amount} ${token} on-chain…`);
      if (wallet.isCircleWallet) {
        const tokenAddress = token === NATIVE_TOKEN_SYMBOL ? undefined : CONTRACTS[token];
        await wallet.circleSendTransfer({ to: OFFRAMP_DEMO_ADDRESS, amount, tokenAddress });
      } else {
        const signer = await wallet.provider.getSigner();
        let tx;
        if (token === NATIVE_TOKEN_SYMBOL) {
          tx = await withRpcRetry(() => signer.sendTransaction({ to: OFFRAMP_DEMO_ADDRESS, value: ethers.parseUnits(amount, NATIVE_BALANCE_DECIMALS) }));
        } else {
          const contract = new ethers.Contract(CONTRACTS[token], ERC20_ABI, signer);
          tx = await withRpcRetry(() => contract.transfer(OFFRAMP_DEMO_ADDRESS, ethers.parseUnits(amount, TOKEN_DECIMALS[token])));
        }
        await withRpcRetry(() => tx.wait());
        appendLog(`On-chain — ${tx.hash.slice(0, 18)}… (real, verifiable on Arcscan)`);
      }
      appendLog("On-chain leg complete.");

      // --- SIMULATED leg from here down ---
      setStep("converting");
      appendLog(`Converting to ${currency} at today's rate (simulated settlement)…`);
      await new Promise((r) => setTimeout(r, 1200));

      setStep("paying_out");
      const accountLabel = payoutMethod === "bank" ? `${bankName} •••• ${accountNumber.slice(-4)}` : `${momoProvider} ${phone}`;
      appendLog(`Initiating payout to ${accountLabel} (simulated)…`);
      const res = await fetch(`${API_BASE}/offramp/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, token, currency, payoutMethod, accountLabel }),
      });
      const data = await res.json();
      await new Promise((r) => setTimeout(r, 1000));

      setStep("settled");
      setResult({ ...data, localAmount });
      appendLog(`Settled — ref ${data.reference} (simulated).`);
      toast({ category: "Withdraw", tone: "ok", title: "Withdrawal complete (demo)", message: `${localAmount} ${currency} — ${data.reference}` });
    } catch (e) {
      setStep("error");
      toast({ category: "Withdraw", tone: "bad", title: "Withdrawal failed", message: e.shortMessage || e.message });
    }
  }, [wallet, token, amount, currency, payoutMethod, bankName, accountNumber, momoProvider, phone, localAmount]);

  return (
    <GlassCard className="p-6 max-w-lg">
      <div className="flex items-center gap-2 mb-1">
        <h2 className="text-[var(--text-primary)] text-lg font-semibold">Withdraw</h2>
        <span className="text-[10px] uppercase tracking-wide bg-amber-500/15 text-amber-300 px-2 py-0.5 rounded-full">Prototype</span>
      </div>
      <p className="text-[var(--text-muted)] text-xs mb-4">
        Turn USDC or EURC into money you can actually spend — straight to a bank account or mobile money.
      </p>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="text-[var(--text-secondary)] text-xs">Token</label>
          <select value={token} onChange={(e) => setToken(e.target.value)} disabled={busy}
            className="w-full mt-1 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm">
            <option value="USDC">USDC</option>
            <option value="EURC">EURC</option>
          </select>
        </div>
        <div>
          <label className="text-[var(--text-secondary)] text-xs">Payout currency</label>
          <select value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={busy}
            className="w-full mt-1 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm">
            {Object.entries(OFFRAMP_CURRENCIES).map(([code, name]) => (
              <option key={code} value={code}>{code} — {name}</option>
            ))}
          </select>
        </div>
      </div>

      <label className="text-[var(--text-secondary)] text-xs">Amount ({token})</label>
      <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" disabled={busy}
        className="w-full mt-1 mb-2 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)]" />

      <p className="text-xs text-[var(--text-muted)] mb-4">
        {rateLoading ? "Fetching live rate…" : rate
          ? `1 USD = ${rate.rate.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${rate.currency} (live, updated ${new Date(rate.asOf).toLocaleDateString()})`
          : "Rate unavailable"}
        {localAmount && <span className="text-cyan-300"> — you'll receive ≈ {localAmount} {currency}</span>}
      </p>

      <label className="text-[var(--text-secondary)] text-xs">Payout method</label>
      <div className="flex gap-2 mt-1 mb-3">
        <button onClick={() => setPayoutMethod("bank")} disabled={busy}
          className={`flex-1 text-sm py-2 rounded-lg border ${payoutMethod === "bank" ? "bg-cyan-500/20 border-cyan-400/40 text-cyan-200" : "bg-[var(--surface-subtle)] border-[var(--border)] text-[var(--text-secondary)]"}`}>
          Bank Transfer
        </button>
        <button onClick={() => setPayoutMethod("momo")} disabled={busy}
          className={`flex-1 text-sm py-2 rounded-lg border ${payoutMethod === "momo" ? "bg-cyan-500/20 border-cyan-400/40 text-cyan-200" : "bg-[var(--surface-subtle)] border-[var(--border)] text-[var(--text-secondary)]"}`}>
          Mobile Money
        </button>
      </div>

      {payoutMethod === "bank" ? (
        <div className="grid grid-cols-2 gap-3 mb-4">
          <input value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="Bank name" disabled={busy}
            className="bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm" />
          <input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder="Account number" disabled={busy}
            className="bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm" />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 mb-4">
          <input value={momoProvider} onChange={(e) => setMomoProvider(e.target.value)} placeholder="Provider (e.g. M-Pesa)" disabled={busy}
            className="bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm" />
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone number" disabled={busy}
            className="bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm" />
        </div>
      )}

      <PrimaryButton disabled={busy} onClick={handleCashOut}>
        {busy ? "Processing…" : "Withdraw"}
      </PrimaryButton>

      {log.length > 0 && (
        <div className="mt-4 space-y-1">
          {log.map((line, i) => <p key={i} className="text-[var(--text-tertiary)] text-xs font-mono">{line}</p>)}
        </div>
      )}
      {result && step === "settled" && (
        <div className="mt-3 bg-emerald-950/30 border border-emerald-500/20 rounded-lg p-3">
          <p className="text-emerald-300 text-sm font-medium">Demo settlement complete</p>
          <p className="text-emerald-200/70 text-xs mt-1">Reference: {result.reference}</p>
        </div>
      )}
    </GlassCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Page: Deposit (PROTOTYPE) — local currency -> USDC/EURC             */
/*                                                                      */
/*  The inbound counterpart to Withdraw. The exchange rate is real, and */
/*  crediting is genuinely on-chain — a server-held treasury wallet     */
/*  (server/offRampRoute.js, same pattern as Swap's signer wallet)      */
/*  sends real testnet USDC/EURC once the (simulated) fiat payment      */
/*  "clears." The fiat collection step itself is what's simulated —     */
/*  actually collecting a bank transfer needs the same licensed-partner */
/*  integration Withdraw's payout side would need.                      */
/* ------------------------------------------------------------------ */

const PAYSTACK_PUBLIC_KEY = import.meta?.env?.VITE_PAYSTACK_PUBLIC_KEY || "";

function DepositPage({ wallet }) {
  const [token, setToken] = useState("USDC");
  const [currency, setCurrency] = useState("NGN");
  const [localAmount, setLocalAmount] = useState("");
  const [email, setEmail] = useState("");
  const [fundingMethod, setFundingMethod] = useState("bank");
  const [bankName, setBankName] = useState("");
  const [reference, setReference] = useState("");
  const [momoProvider, setMomoProvider] = useState("");
  const [phone, setPhone] = useState("");

  const [rate, setRate] = useState(null);
  const [rateLoading, setRateLoading] = useState(false);
  const [step, setStep] = useState("idle"); // idle | paying | converting | crediting | done | error
  const [log, setLog] = useState([]);
  const [result, setResult] = useState(null);
  const busy = step !== "idle" && step !== "done" && step !== "error";
  const isPaystackFlow = currency === "NGN";

  const appendLog = (line) => setLog((l) => [...l, line]);

  // Paystack's inline checkout is a plain script tag, not an npm
  // package — load it once, lazily, only when it's actually needed.
  useEffect(() => {
    if (!isPaystackFlow || window.PaystackPop) return;
    const script = document.createElement("script");
    script.src = "https://js.paystack.co/v1/inline.js";
    script.async = true;
    document.body.appendChild(script);
  }, [isPaystackFlow]);

  const fetchRate = useCallback(async () => {
    setRateLoading(true);
    try {
      const res = await fetch(`${API_BASE}/offramp/rate?currency=${currency}`);
      if (!res.ok) throw new Error("Rate lookup failed.");
      setRate(await res.json());
    } catch (e) {
      toast({ category: "Deposit", tone: "bad", title: "Rate lookup failed", message: e.message });
      setRate(null);
    } finally {
      setRateLoading(false);
    }
  }, [currency]);

  useEffect(() => { fetchRate(); }, [fetchRate]);

  // Inverse of Withdraw's math: local currency in, token out.
  const tokenAmount = rate && localAmount ? (Number(localAmount) / rate.rate) : null;

  // Real path: opens Paystack's actual checkout popup. Test-mode secret
  // key = fake test-card money; live secret key = real Naira — same
  // code either way, Paystack switches behavior based on which key the
  // backend holds.
  const handlePaystackDeposit = useCallback(() => {
    if (!wallet.address) {
      toast({ category: "Deposit", tone: "bad", title: "Not connected", message: "Connect your wallet first." });
      return;
    }
    if (!localAmount || Number(localAmount) <= 0) {
      toast({ category: "Deposit", tone: "bad", title: "Invalid amount", message: "Enter an amount to fund." });
      return;
    }
    if (!email) {
      toast({ category: "Deposit", tone: "bad", title: "Missing email", message: "Paystack needs an email for the receipt." });
      return;
    }
    if (!window.PaystackPop) {
      toast({ category: "Deposit", tone: "bad", title: "Not ready", message: "Payment popup is still loading — try again in a moment." });
      return;
    }
    if (!PAYSTACK_PUBLIC_KEY) {
      toast({ category: "Deposit", tone: "bad", title: "Not configured", message: "VITE_PAYSTACK_PUBLIC_KEY isn't set on the frontend yet." });
      return;
    }

    setLog([]);
    setResult(null);
    setStep("paying");
    appendLog("Opening Paystack checkout…");

    const handler = window.PaystackPop.setup({
      key: PAYSTACK_PUBLIC_KEY,
      email,
      amount: Math.round(Number(localAmount) * 100), // kobo
      currency: "NGN",
      callback: (response) => {
        // Paystack confirms client-side here, but that's never trusted
        // alone — the backend independently re-verifies against
        // Paystack's own API before anything gets credited.
        (async () => {
          try {
            setStep("converting");
            appendLog(`Payment received by Paystack — verifying…`);
            const verifyRes = await fetch(
              `${API_BASE}/offramp/paystack/verify?reference=${encodeURIComponent(response.reference)}&toAddress=${wallet.address}&token=${token}`
            );
            const data = await verifyRes.json();
            if (!verifyRes.ok) throw new Error(data.error || "Verification failed.");

            setStep("crediting");
            appendLog(`Verified — crediting your wallet on-chain…`);
            appendLog(`On-chain — ${data.txHash.slice(0, 18)}… (real, verifiable on Arcscan)`);

            setStep("done");
            setResult({ reference: response.reference, txHash: data.txHash, tokenAmount: data.tokenAmount });
            appendLog(`Done — ${data.tokenAmount.toFixed(4)} ${token} credited.`);
            toast({ category: "Deposit", tone: "ok", title: "Deposit complete", message: `${data.tokenAmount.toFixed(4)} ${token} credited on-chain` });
          } catch (e) {
            setStep("error");
            toast({ category: "Deposit", tone: "bad", title: "Deposit failed", message: e.message });
          }
        })();
      },
      onClose: () => {
        if (step === "paying") {
          setStep("idle");
          appendLog("Checkout closed before completing.");
        }
      },
    });
    handler.openIframe();
  }, [wallet, localAmount, email, token, step]);

  // Simulated path — KES/GHS only, no real Paystack-equivalent wired up
  // for those yet.
  const handleSimulatedDeposit = useCallback(async () => {
    if (!wallet.address) {
      toast({ category: "Deposit", tone: "bad", title: "Not connected", message: "Connect your wallet first." });
      return;
    }
    if (!localAmount || Number(localAmount) <= 0) {
      toast({ category: "Deposit", tone: "bad", title: "Invalid amount", message: "Enter an amount to fund." });
      return;
    }
    if (fundingMethod === "bank" && (!bankName || !reference)) {
      toast({ category: "Deposit", tone: "bad", title: "Missing details", message: "Enter a bank name and payment reference." });
      return;
    }
    if (fundingMethod === "momo" && (!momoProvider || !phone)) {
      toast({ category: "Deposit", tone: "bad", title: "Missing details", message: "Enter a mobile money provider and phone number." });
      return;
    }

    setLog([]);
    setResult(null);
    try {
      setStep("paying");
      const accountLabel = fundingMethod === "bank" ? `${bankName} · ref ${reference}` : `${momoProvider} ${phone}`;
      appendLog(`Waiting for ${currency} payment via ${accountLabel} (simulated)…`);
      await new Promise((r) => setTimeout(r, 1200));

      setStep("converting");
      appendLog(`Converting to ${token} at today's rate…`);
      const confirmRes = await fetch(`${API_BASE}/offramp/simulate-deposit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localAmount, currency, token, fundingMethod, accountLabel }),
      });
      const confirmData = await confirmRes.json();
      await new Promise((r) => setTimeout(r, 600));

      setStep("crediting");
      appendLog(`Crediting your wallet on-chain…`);
      const creditRes = await fetch(`${API_BASE}/offramp/credit-deposit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toAddress: wallet.address, token, localAmount, currency }),
      });
      const creditData = await creditRes.json();
      if (!creditRes.ok) throw new Error(creditData.error || "Crediting failed.");
      appendLog(`On-chain — ${creditData.txHash.slice(0, 18)}… (real, verifiable on Arcscan)`);

      setStep("done");
      setResult({ reference: confirmData.reference, txHash: creditData.txHash, tokenAmount: creditData.tokenAmount });
      appendLog(`Done — ${creditData.tokenAmount.toFixed(4)} ${token} credited.`);
      toast({ category: "Deposit", tone: "ok", title: "Deposit complete", message: `${creditData.tokenAmount.toFixed(4)} ${token} credited on-chain` });
    } catch (e) {
      setStep("error");
      toast({ category: "Deposit", tone: "bad", title: "Deposit failed", message: e.shortMessage || e.message });
    }
  }, [wallet, token, localAmount, currency, fundingMethod, bankName, reference, momoProvider, phone]);

  return (
    <GlassCard className="p-6 max-w-lg">
      <div className="flex items-center gap-2 mb-1">
        <h2 className="text-[var(--text-primary)] text-lg font-semibold">Deposit</h2>
        <span className="text-[10px] uppercase tracking-wide bg-amber-500/15 text-amber-300 px-2 py-0.5 rounded-full">
          {isPaystackFlow ? "Real payment (test mode)" : "Prototype"}
        </span>
      </div>
      <p className="text-[var(--text-muted)] text-xs mb-4">
        Fund your wallet with Naira, Shillings, or Cedis — just like topping up a mobile money or exchange wallet.
      </p>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="text-[var(--text-secondary)] text-xs">You'll receive</label>
          <select value={token} onChange={(e) => setToken(e.target.value)} disabled={busy}
            className="w-full mt-1 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm">
            <option value="USDC">USDC</option>
            <option value="EURC">EURC</option>
          </select>
        </div>
        <div>
          <label className="text-[var(--text-secondary)] text-xs">Fund with</label>
          <select value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={busy}
            className="w-full mt-1 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm">
            {Object.entries(OFFRAMP_CURRENCIES).map(([code, name]) => (
              <option key={code} value={code}>{code} — {name}</option>
            ))}
          </select>
        </div>
      </div>

      <label className="text-[var(--text-secondary)] text-xs">Amount ({currency})</label>
      <input value={localAmount} onChange={(e) => setLocalAmount(e.target.value)} placeholder="0.00" disabled={busy}
        className="w-full mt-1 mb-2 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)]" />

      <p className="text-xs text-[var(--text-muted)] mb-4">
        {rateLoading ? "Fetching live rate…" : rate
          ? `1 USD = ${rate.rate.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${rate.currency} (live, updated ${new Date(rate.asOf).toLocaleDateString()})`
          : "Rate unavailable"}
        {tokenAmount && <span className="text-cyan-300"> — you'll get ≈ {tokenAmount.toFixed(4)} {token}</span>}
      </p>

      {isPaystackFlow ? (
        <>
          <label className="text-[var(--text-secondary)] text-xs">Email (for Paystack's receipt)</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" disabled={busy}
            className="w-full mt-1 mb-4 bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm" />
        </>
      ) : (
        <>
          <label className="text-[var(--text-secondary)] text-xs">Funding method</label>
          <div className="flex gap-2 mt-1 mb-3">
            <button onClick={() => setFundingMethod("bank")} disabled={busy}
              className={`flex-1 text-sm py-2 rounded-lg border ${fundingMethod === "bank" ? "bg-cyan-500/20 border-cyan-400/40 text-cyan-200" : "bg-[var(--surface-subtle)] border-[var(--border)] text-[var(--text-secondary)]"}`}>
              Bank Transfer
            </button>
            <button onClick={() => setFundingMethod("momo")} disabled={busy}
              className={`flex-1 text-sm py-2 rounded-lg border ${fundingMethod === "momo" ? "bg-cyan-500/20 border-cyan-400/40 text-cyan-200" : "bg-[var(--surface-subtle)] border-[var(--border)] text-[var(--text-secondary)]"}`}>
              Mobile Money
            </button>
          </div>

          {fundingMethod === "bank" ? (
            <div className="grid grid-cols-2 gap-3 mb-4">
              <input value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="Bank name" disabled={busy}
                className="bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm" />
              <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Payment reference" disabled={busy}
                className="bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm" />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 mb-4">
              <input value={momoProvider} onChange={(e) => setMomoProvider(e.target.value)} placeholder="Provider (e.g. M-Pesa)" disabled={busy}
                className="bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm" />
              <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone number" disabled={busy}
                className="bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm" />
            </div>
          )}
        </>
      )}

      <PrimaryButton disabled={busy} onClick={isPaystackFlow ? handlePaystackDeposit : handleSimulatedDeposit}>
        {busy ? "Processing…" : isPaystackFlow ? "Pay with Paystack" : "Fund Wallet"}
      </PrimaryButton>

      {log.length > 0 && (
        <div className="mt-4 space-y-1">
          {log.map((line, i) => <p key={i} className="text-[var(--text-tertiary)] text-xs font-mono">{line}</p>)}
        </div>
      )}
      {result && step === "done" && (
        <div className="mt-3 bg-emerald-950/30 border border-emerald-500/20 rounded-lg p-3">
          <p className="text-emerald-300 text-sm font-medium">Deposit complete</p>
          <p className="text-emerald-200/70 text-xs mt-1">Payment ref (demo): {result.reference}</p>
          <a
            href={`${ARC_TESTNET.blockExplorerUrls[0]}/tx/${result.txHash}`}
            target="_blank"
            rel="noreferrer"
            className="text-cyan-300 text-xs underline"
          >
            View on-chain credit on Arcscan →
          </a>
        </div>
      )}
    </GlassCard>
  );
}
/* ------------------------------------------------------------------ */

// Local index of which lockIds belong to this browser, so we know which
// on-chain locks to display. The contract itself is the source of truth
// for status (owner, unlockAt, withdrawn) — this is just a lookup list.
const LS_LOCK_IDS_KEY = "arc_nft_lock_ids";
const LS_MINTED_KEY = "arc_nft_minted_ids";

function NFTLockPage({ wallet }) {
  const [mintedIds, setMintedIds] = useState(() => readLS(LS_MINTED_KEY, []));
  const [lockIds, setLockIds] = useState(() => readLS(LS_LOCK_IDS_KEY, []));
  const [lockDetails, setLockDetails] = useState({});
  const [duration, setDuration] = useState("7");
  const [busy, setBusy] = useState(false);
  const [lastSynced, setLastSynced] = useState(null);

  const getContracts = useCallback(async () => {
    const signer = await wallet.provider.getSigner();
    const nft = new ethers.Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, signer);
    const vault = new ethers.Contract(NFT_LOCK_VAULT_ADDRESS, NFT_LOCK_ABI, signer);
    return { nft, vault };
  }, [wallet.provider]);

  const nftInterface = useMemo(() => new ethers.Interface(NFT_ABI), []);
  const vaultInterface = useMemo(() => new ethers.Interface(NFT_LOCK_ABI), []);

  // Pull live status for every lock this browser knows about. Circle
  // wallets have no wallet.provider, so this falls back to the plain
  // read-only RPC provider — reading on-chain state doesn't need signing.
  useEffect(() => {
    async function loadLockDetails() {
      if (lockIds.length === 0) return;
      const provider = wallet.provider || readOnlyProvider;
      const vault = new ethers.Contract(NFT_LOCK_VAULT_ADDRESS, NFT_LOCK_ABI, provider);
      const entries = await Promise.all(
        lockIds.map(async (id) => {
          try {
            const l = await withRpcRetry(() => vault.getLock(id));
            return [id, {
              tokenId: l.tokenId.toString(),
              unlockAt: Number(l.unlockAt) * 1000,
              withdrawn: l.withdrawn,
              canWithdraw: l.canWithdraw,
            }];
          } catch {
            return [id, null];
          }
        })
      );
      setLockDetails(Object.fromEntries(entries));
      setLastSynced(Date.now());
    }
    loadLockDetails();
  }, [wallet.provider, lockIds]);

  const mintNft = useCallback(async () => {
    if (!wallet.address) {
      toast({ category: "NFT Lock", tone: "bad", title: "Not connected", message: "Connect your wallet first." });
      return;
    }
    setBusy(true);
    try {
      let receipt;
      if (wallet.isCircleWallet) {
        // Circle holds the signing keyshare — this creates a transaction
        // challenge, the user approves with their PIN, and we get back
        // the confirmed txHash to read the receipt from ourselves.
        const txHash = await wallet.circleExecuteContract({
          contractAddress: NFT_CONTRACT_ADDRESS,
          abiFunctionSignature: "mint()",
          abiParameters: [],
        });
        receipt = await withRpcRetry(() => readOnlyProvider.getTransactionReceipt(txHash));
      } else {
        const { nft } = await getContracts();
        const tx = await withRpcRetry(() => nft.mint());
        receipt = await withRpcRetry(() => tx.wait());
      }
      const transferEvent = receipt.logs
        .map((log) => { try { return nftInterface.parseLog(log); } catch { return null; } })
        .find((parsed) => parsed?.name === "Transfer");
      const newTokenId = transferEvent?.args?.tokenId?.toString();
      const next = [newTokenId, ...mintedIds];
      setMintedIds(next);
      writeLS(LS_MINTED_KEY, next);
      toast({ category: "NFT Lock", tone: "ok", title: "NFT minted", message: `Token #${newTokenId}` });
    } catch (e) {
      toast({ category: "NFT Lock", tone: "bad", title: "Mint failed", message: e.shortMessage || e.message });
    } finally {
      setBusy(false);
    }
  }, [wallet, mintedIds, getContracts, nftInterface]);

  const lockNft = useCallback(async (tokenId) => {
    setBusy(true);
    try {
      // "test2min" is a special-cased short duration for verifying the
      // auto-withdraw watcher without waiting on a real 7/30/90-day lock —
      // everything else is treated as whole days.
      const unlockAt =
        duration === "test2min"
          ? Math.floor(Date.now() / 1000) + 120
          : Math.floor(Date.now() / 1000) + Number(duration) * 86400;
      let receipt;
      if (wallet.isCircleWallet) {
        // approve() then lock() — two sequential PIN-approved transactions,
        // same two-step flow as the MetaMask path just done via Circle's
        // contract-execution challenges instead of ethers signing.
        await wallet.circleExecuteContract({
          contractAddress: NFT_CONTRACT_ADDRESS,
          abiFunctionSignature: "approve(address,uint256)",
          abiParameters: [NFT_LOCK_VAULT_ADDRESS, String(tokenId)],
        });
        const lockTxHash = await wallet.circleExecuteContract({
          contractAddress: NFT_LOCK_VAULT_ADDRESS,
          abiFunctionSignature: "lock(address,uint256,uint256)",
          abiParameters: [NFT_CONTRACT_ADDRESS, String(tokenId), String(unlockAt)],
        });
        receipt = await withRpcRetry(() => readOnlyProvider.getTransactionReceipt(lockTxHash));
      } else {
        const { nft, vault } = await getContracts();
        const approveTx = await withRpcRetry(() => nft.approve(NFT_LOCK_VAULT_ADDRESS, tokenId));
        await withRpcRetry(() => approveTx.wait());
        const lockTx = await withRpcRetry(() => vault.lock(NFT_CONTRACT_ADDRESS, tokenId, unlockAt));
        receipt = await withRpcRetry(() => lockTx.wait());
      }
      const lockedEvent = receipt.logs
        .map((log) => { try { return vaultInterface.parseLog(log); } catch { return null; } })
        .find((parsed) => parsed?.name === "Locked");
      const newLockId = lockedEvent?.args?.lockId?.toString();

      const nextLockIds = [newLockId, ...lockIds];
      setLockIds(nextLockIds);
      writeLS(LS_LOCK_IDS_KEY, nextLockIds);

      const nextMinted = mintedIds.filter((id) => id !== tokenId);
      setMintedIds(nextMinted);
      writeLS(LS_MINTED_KEY, nextMinted);

      toast({ category: "NFT Lock",
        tone: "ok",
        title: "NFT locked",
        message:
          duration === "test2min"
            ? `Token #${tokenId} locked for 2 minutes (testing).`
            : `Token #${tokenId} locked for ${duration} day(s).`,
      });
    } catch (e) {
      toast({ category: "NFT Lock", tone: "bad", title: "Lock failed", message: e.shortMessage || e.message });
    } finally {
      setBusy(false);
    }
  }, [wallet, getContracts, duration, lockIds, mintedIds, vaultInterface]);

  const withdrawLock = useCallback(async (lockId) => {
    setBusy(true);
    try {
      await performLockWithdraw(wallet, lockId);
      toast({ category: "NFT Lock", tone: "ok", title: "Withdrawn", message: `Lock #${lockId} withdrawn.` });
      setLockDetails((prev) => ({ ...prev, [lockId]: { ...prev[lockId], withdrawn: true } }));
    } catch (e) {
      toast({ category: "NFT Lock", tone: "bad", title: "Withdraw failed", message: e.shortMessage || e.message });
    } finally {
      setBusy(false);
    }
  }, [wallet]);

  return (
    <GlassCard className="p-6 max-w-lg">
      <h2 className="text-[var(--text-primary)] text-lg font-semibold mb-1">NFT Lock</h2>
      <p className="text-[var(--text-muted)] text-xs mb-4">
        Real on-chain lock via a custom vault contract on Arc Testnet. Mint a free test NFT, then lock it for a chosen duration.
      </p>
      {wallet.isCircleWallet && (
        <p className="text-cyan-300/70 text-xs mb-3">
          Circle Wallet: mint, lock, and withdraw each need a PIN confirmation — locking takes two (approve, then lock).
        </p>
      )}

      <PrimaryButton disabled={busy} onClick={mintNft}>
        {busy ? "Working…" : "Mint test NFT"}
      </PrimaryButton>

      {mintedIds.length > 0 && (
        <div className="mt-5">
          <p className="text-[var(--text-secondary)] text-xs mb-2">Unlocked NFTs you own — ready to lock</p>
          <div className="flex items-center gap-2 mb-3">
            <select
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              className="bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm"
            >
              <option value="test2min">2 minutes (testing)</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
            </select>
          </div>
          <div className="space-y-2">
            {mintedIds.map((id) => (
              <div key={id} className="flex justify-between items-center text-sm text-[var(--text-strong)] border-t border-[var(--border-subtle)] pt-2">
                <span>Token #{id}</span>
                <PrimaryButton disabled={busy} onClick={() => lockNft(id)}>Lock</PrimaryButton>
              </div>
            ))}
          </div>
        </div>
      )}

      {lockIds.length > 0 && (
        <div className="mt-5">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[var(--text-secondary)] text-xs">Your locks</p>
            {lastSynced && (
              <p className="text-[var(--text-faint)] text-[10px]">Last synced {relativeTime(lastSynced)}</p>
            )}
          </div>
          <div className="space-y-2">
            {lockIds.map((id) => {
              const d = lockDetails[id];
              return (
                <div key={id} className="flex justify-between items-center text-sm border-t border-[var(--border-subtle)] pt-2">
                  <span className="text-[var(--text-strong)]">
                    Lock #{id}{d ? ` — token #${d.tokenId}` : ""}
                  </span>
                  {d ? (
                    d.withdrawn ? (
                      <Pill tone="neutral">Withdrawn</Pill>
                    ) : d.canWithdraw ? (
                      <PrimaryButton disabled={busy} onClick={() => withdrawLock(id)}>Withdraw</PrimaryButton>
                    ) : (
                      <Pill tone="warn">Locked until {new Date(d.unlockAt).toLocaleDateString()}</Pill>
                    )
                  ) : (
                    <Skeleton className="h-6 w-24" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </GlassCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Page: Activity Centre — every real outcome the app has toasted      */
/*  about (transfers, swaps, bridges, lending, NFT lock, commands),     */
/*  persisted so it's still visible after the toast itself disappears.  */
/*  This is app-level activity (what YOU did in this browser), not the  */
/*  on-chain event history that History/Leaderboard pull — those two    */
/*  stay separate and serve different questions.                        */
/* ------------------------------------------------------------------ */

const ACTIVITY_CATEGORIES = ["All", "Deposit", "Withdraw", "Transfer", "Bulk Transfer", "Swap", "Bridge", "Lending", "NFT Lock", "Command"];

function relativeTime(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function ActivityPage() {
  const [entries, setEntries] = useState(() => readLS(ACTIVITY_LOG_KEY, []));
  const [filter, setFilter] = useState("All");

  useEffect(() => {
    const onActivity = () => setEntries(readLS(ACTIVITY_LOG_KEY, []));
    activityListeners.push(onActivity);
    return () => {
      activityListeners = activityListeners.filter((fn) => fn !== onActivity);
    };
  }, []);

  const filtered = filter === "All" ? entries : entries.filter((e) => e.category === filter);

  const clearLog = () => {
    writeLS(ACTIVITY_LOG_KEY, []);
    setEntries([]);
  };

  return (
    <GlassCard className="p-6 max-w-2xl">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-[var(--text-primary)] text-lg font-semibold">Activity Centre</h2>
        {entries.length > 0 && (
          <button onClick={clearLog} className="text-[var(--text-muted)] hover:text-[var(--text-soft)] text-xs transition">
            Clear log
          </button>
        )}
      </div>
      <p className="text-[var(--text-muted)] text-xs mb-4">
        Everything that's happened in this browser — transfers, swaps, bridges, lending, NFT lock actions. Kept locally, most recent first.
      </p>

      <div className="flex flex-wrap gap-2 mb-5">
        {ACTIVITY_CATEGORIES.map((cat) => (
          <button
            key={cat}
            onClick={() => setFilter(cat)}
            className={`text-xs px-3 py-1.5 rounded-full border transition ${
              filter === cat
                ? "bg-cyan-500/20 border-cyan-400/40 text-cyan-200"
                : "bg-[var(--surface-subtle)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-strong)]"
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="text-[var(--text-faint)] text-sm py-8 text-center">
          {entries.length === 0 ? "Nothing here yet — actions you take across the app will show up here." : "Nothing in this category yet."}
        </p>
      ) : (
        <div className="space-y-2">
          {filtered.map((entry) => (
            <div key={entry.id} className="flex items-start justify-between gap-3 bg-[var(--surface-subtle)] rounded-lg px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      entry.tone === "ok" ? "bg-emerald-400" : "bg-rose-400"
                    }`}
                  />
                  <span className="text-[var(--text-primary)] text-sm font-medium truncate">{entry.title}</span>
                  <span className="text-[var(--text-faint)] text-[10px] uppercase tracking-wide shrink-0">{entry.category}</span>
                </div>
                {entry.message && <p className="text-[var(--text-secondary)] text-xs break-all">{entry.message}</p>}
              </div>
              <span className="text-[var(--text-faint)] text-xs shrink-0">{relativeTime(entry.timestamp)}</span>
            </div>
          ))}
        </div>
      )}
    </GlassCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Page: History — real on-chain Transfer events, not localStorage     */
/*  Native USDC transfers don't emit ERC-20 Transfer logs (it's the     */
/*  chain's native currency, not a token contract), so only EURC and    */
/*  cirBTC activity can be reconstructed this way. That's flagged in    */
/*  the UI rather than silently omitted.                                */
/* ------------------------------------------------------------------ */

function HistoryPage({ wallet }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [scanned, setScanned] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!wallet.provider || !wallet.address) return;
      setLoading(true);
      try {
        const latest = await withRpcRetry(() => wallet.provider.getBlockNumber());
        const fromBlock = Math.max(0, latest - RECENT_BLOCK_WINDOW);
        const found = [];
        for (const [symbol, addr] of Object.entries({ EURC: CONTRACTS.EURC, cirBTC: CONTRACTS.cirBTC })) {
          const contract = new ethers.Contract(addr, ERC20_ABI, wallet.provider);
          const outgoing = await withRpcRetry(() =>
            contract.queryFilter(contract.filters.Transfer(wallet.address, null), fromBlock, latest)
          );
          await sleep(350);
          const incoming = await withRpcRetry(() =>
            contract.queryFilter(contract.filters.Transfer(null, wallet.address), fromBlock, latest)
          );
          await sleep(350);
          for (const ev of [...outgoing, ...incoming]) {
            const sent = ev.args.from.toLowerCase() === wallet.address.toLowerCase();
            found.push({
              key: `${ev.transactionHash}-${ev.logIndex}`,
              token: symbol,
              direction: sent ? "Sent" : "Received",
              amount: ethers.formatUnits(ev.args.value, TOKEN_DECIMALS[symbol]),
              counterparty: sent ? ev.args.to : ev.args.from,
              txHash: ev.transactionHash,
              blockNumber: ev.blockNumber,
            });
          }
        }
        found.sort((a, b) => b.blockNumber - a.blockNumber);
        if (!cancelled) {
          setRows(found);
          setScanned({ fromBlock, toBlock: latest });
        }
      } catch (e) {
        console.error(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [wallet.provider, wallet.address]);

  return (
    <GlassCard className="p-6">
      <h2 className="text-[var(--text-primary)] text-lg font-semibold mb-1">History</h2>
      <p className="text-[var(--text-muted)] text-xs mb-4">
        Real on-chain EURC and cirBTC transfers for your address
        {scanned && ` — blocks ${scanned.fromBlock.toLocaleString()} to ${scanned.toBlock.toLocaleString()}`}.
        Native USDC transfers aren't shown here since they don't emit event logs; check the{" "}
        <a
          href={`${ARC_TESTNET.blockExplorerUrls[0]}/address/${wallet.address || ""}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-cyan-300 hover:text-cyan-200"
        >
          block explorer
        </a>{" "}
        for full activity.
      </p>
      {loading && rows.length === 0 && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      )}
      {!loading && rows.length === 0 && (
        <p className="text-[var(--text-muted)] text-sm">No EURC or cirBTC transfers found in the recent block range.</p>
      )}
      <div className="space-y-2">
        {rows.map((tx) => (
          <a
            key={tx.key}
            href={`${ARC_TESTNET.blockExplorerUrls[0]}/tx/${tx.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex justify-between items-center text-sm border-t border-[var(--border-subtle)] pt-2 pb-1 hover:bg-[var(--surface-subtle)] rounded px-1 -mx-1 transition"
          >
            <div className="text-[var(--text-strong)]">
              {tx.direction} {tx.amount} {tx.token}
              <span className="text-[var(--text-faint)] font-mono text-xs ml-2">
                {tx.direction === "Sent" ? "→" : "←"} {tx.counterparty.slice(0, 8)}…
              </span>
            </div>
            <Pill tone={tx.direction === "Sent" ? "warn" : "ok"}>{tx.direction}</Pill>
          </a>
        ))}
      </div>
    </GlassCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Page: Leaderboard — real on-chain activity ranking                  */
/*  Ranked by number of EURC/cirBTC transfers sent in the recent block  */
/*  window (not by combined dollar volume, since EURC and cirBTC aren't */
/*  directly comparable units without a live price feed this app        */
/*  doesn't have).                                                      */
/* ------------------------------------------------------------------ */

function LeaderboardPage({ wallet }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [scanned, setScanned] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!wallet.provider) return;
      setLoading(true);
      try {
        const latest = await withRpcRetry(() => wallet.provider.getBlockNumber());
        const fromBlock = Math.max(0, latest - RECENT_BLOCK_WINDOW);
        const totals = {}; // address(lower) -> { count, EURC, cirBTC }
        for (const [symbol, addr] of Object.entries({ EURC: CONTRACTS.EURC, cirBTC: CONTRACTS.cirBTC })) {
          const contract = new ethers.Contract(addr, ERC20_ABI, wallet.provider);
          const events = await withRpcRetry(() =>
            contract.queryFilter(contract.filters.Transfer(), fromBlock, latest)
          );
          await sleep(350);
          for (const ev of events) {
            const sender = ev.args.from.toLowerCase();
            if (!totals[sender]) totals[sender] = { address: ev.args.from, count: 0, EURC: 0, cirBTC: 0 };
            totals[sender].count += 1;
            totals[sender][symbol] += Number(ethers.formatUnits(ev.args.value, TOKEN_DECIMALS[symbol]));
          }
        }
        const ranked = Object.values(totals)
          .sort((a, b) => b.count - a.count)
          .slice(0, 10);
        if (!cancelled) {
          setRows(ranked);
          setScanned({ fromBlock, toBlock: latest });
        }
      } catch (e) {
        console.error(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [wallet.provider]);

  return (
    <GlassCard className="p-6">
      <h2 className="text-[var(--text-primary)] text-lg font-semibold mb-1">Leaderboard</h2>
      <p className="text-[var(--text-muted)] text-xs mb-4">
        Ranked by number of on-chain EURC/cirBTC transfers sent
        {scanned && ` — blocks ${scanned.fromBlock.toLocaleString()} to ${scanned.toBlock.toLocaleString()}`}.
        Recent activity only, not all-time.
      </p>
      {loading && rows.length === 0 && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      )}
      {!loading && rows.length === 0 && (
        <p className="text-[var(--text-muted)] text-sm">No transfer activity found in the recent block range.</p>
      )}
      {rows.map((r, i) => (
        <div
          key={r.address}
          className={`flex justify-between items-center text-sm border-t border-[var(--border-subtle)] pt-2 pb-1 ${
            wallet.address?.toLowerCase() === r.address.toLowerCase() ? "text-cyan-300" : "text-[var(--text-strong)]"
          }`}
        >
          <span className="font-mono">
            #{i + 1} {r.address.slice(0, 8)}…{r.address.slice(-4)}
          </span>
          <span className="text-xs text-right">
            {r.count} txns · {r.EURC.toFixed(2)} EURC · {r.cirBTC.toFixed(4)} cirBTC
          </span>
        </div>
      ))}
    </GlassCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Page: Wallet Profile                                                */
/* ------------------------------------------------------------------ */

function WalletProfilePage({ wallet }) {
  return (
    <GlassCard className="p-6 max-w-lg">
      <h2 className="text-[var(--text-primary)] text-lg font-semibold mb-4">Wallet Profile</h2>
      <p className="text-[var(--text-secondary)] text-xs">Address</p>
      <p className="text-[var(--text-primary)] font-mono text-sm mb-3 break-all">{wallet.address || "—"}</p>
      <p className="text-[var(--text-secondary)] text-xs">Network</p>
      <p className="text-[var(--text-primary)] text-sm mb-3">{wallet.chainId ?? "—"}</p>
      <p className="text-[var(--text-secondary)] text-xs">Wallet created</p>
      {wallet.isCircleWallet ? (
        <p className="text-[var(--text-primary)] text-sm mb-3">
          {wallet.createDate
            ? new Date(wallet.createDate).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
            : "—"}
        </p>
      ) : (
        <p className="text-[var(--text-muted)] text-sm mb-3">
          Not available — MetaMask/WalletConnect wallets are just key pairs with no registration event, so there's no "creation date" to report. This is only known for Circle email wallets, since Circle's own records include it.
        </p>
      )}
      <a
        href={`${ARC_TESTNET.blockExplorerUrls[0]}/address/${wallet.address}`}
        target="_blank"
        rel="noreferrer"
        className="text-cyan-300 text-sm"
      >
        View on Arcscan →
      </a>
    </GlassCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Login gate — shown before anything else in the app is reachable.    */
/*  Flow: tick "I am not a robot" -> pick any wallet -> sign a one-time */
/*  message to prove ownership -> app unlocks.                          */
/* ------------------------------------------------------------------ */

function QrCodeImage({ value }) {
  const [dataUrl, setDataUrl] = useState(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, { width: 240, margin: 1 })
      .then((url) => { if (!cancelled) setDataUrl(url); })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [value]);

  if (!dataUrl) return <Skeleton className="w-60 h-60 mx-auto" />;
  return <img src={dataUrl} alt="WalletConnect QR code" className="mx-auto rounded-lg" />;
}

/* ------------------------------------------------------------------ */
/*  Landing page — shown before LoginGate. Everything here is written  */
/*  to be true of what's actually live: no invented user counts, no    */
/*  fabricated testimonials, no compliance claims that don't apply to  */
/*  an unaudited testnet app. The in-app "testnet only, no real funds" */
/*  disclaimer carries through here rather than getting glossed over   */
/*  for the sake of a punchier landing page.                           */
/* ------------------------------------------------------------------ */

function ThemeToggleButton({ theme, toggleTheme }) {
  return (
    <button
      onClick={toggleTheme}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-soft)] hover:bg-[var(--surface-subtle)] transition"
    >
      {theme === "dark" ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}

const LANDING_FEATURES = [
  { label: "Deposit", glyph: "↓", grad: "from-cyan-400 to-cyan-600", desc: "Bring in testnet USDC/EURC via a real Paystack checkout — verified server-side, credited on-chain." },
  { label: "Withdraw", glyph: "↑", grad: "from-purple-400 to-purple-600", desc: "Move tokens out on-chain for real; the fiat payout leg is labeled as prototype." },
  { label: "Transfer", glyph: "→", grad: "from-emerald-400 to-emerald-600", desc: "Send USDC, EURC, or cirBTC to any address, one at a time." },
  { label: "Bulk Transfer", glyph: "⇉", grad: "from-emerald-400 to-teal-600", desc: "Same transfer, batched — pay several addresses in one pass." },
  { label: "Swap", glyph: "⇄", grad: "from-orange-400 to-orange-600", desc: "Token-to-token swaps via Circle App Kit, with a live fee quote instead of a guess." },
  { label: "Bridge", glyph: "⛓", grad: "from-cyan-400 to-purple-600", desc: "Real CCTP burn-and-mint between Arc, Ethereum Sepolia, Base Sepolia, and Avalanche Fuji." },
  { label: "Lending", glyph: "%", grad: "from-purple-400 to-pink-600", desc: "Deposit collateral, borrow, repay, and watch liquidation mechanics play out — on a custom Solidity pool." },
  { label: "NFT Lock", glyph: "⏱", grad: "from-amber-400 to-orange-600", desc: "Time-lock an NFT in a vault contract; get notified the moment it's unlockable." },
];

const LANDING_STEPS = [
  { n: 1, title: "Sign in", desc: "Email + PIN through Circle's Wallets (no seed phrase to lose), or connect MetaMask / WalletConnect if you'd rather hold your own keys." },
  { n: 2, title: "Fund it", desc: "Run a testnet deposit through the real Paystack flow, or bridge in USDC from Sepolia, Base Sepolia, or Fuji." },
  { n: 3, title: "Use every feature", desc: "Transfer, swap, bridge, lend, and lock — all on Arc Testnet, all tracked in the Activity Centre as you go." },
];

function LandingPage({ onLaunch, theme, toggleTheme }) {
  const scrollToFeatures = () => {
    document.getElementById("landing-features")?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="min-h-screen bg-[var(--bg-base)] bg-[radial-gradient(circle_at_20%_0%,var(--bg-grad-1),transparent_45%),radial-gradient(circle_at_80%_100%,var(--bg-grad-2),transparent_40%)]">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 sm:px-6 py-4">
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="Arclify" className="w-7 h-7" />
          <div className="leading-tight">
            <span className="block text-[var(--text-primary)] font-semibold tracking-tight">Arclify</span>
            <span className="block text-cyan-300/50 text-[10px]">Built on Arc</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <ThemeToggleButton theme={theme} toggleTheme={toggleTheme} />
          <PrimaryButton onClick={onLaunch} className="px-4! py-2! text-sm">
            Launch App
          </PrimaryButton>
        </div>
      </header>

      {/* Hero */}
      <section className="px-4 sm:px-6 pt-8 pb-16 max-w-3xl mx-auto text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[var(--border)] bg-[var(--surface-subtle)] text-cyan-300 text-xs mb-6">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
          Arc Testnet · Stablecoin DeFi Dashboard
        </div>
        <h1 className="text-[var(--text-primary)] text-4xl sm:text-5xl font-bold tracking-tight leading-tight mb-4">
          A full DeFi stack, built to actually try out
        </h1>
        <p className="text-[var(--text-secondary)] text-base sm:text-lg mb-8 max-w-xl mx-auto">
          Deposit, transfer, swap, bridge, lend, and lock — nine features, one dashboard,
          all running on real infrastructure against Arc Testnet. Nothing to buy, nothing at risk.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3 mb-6">
          <PrimaryButton onClick={onLaunch} className="px-6! py-3!">
            Launch App →
          </PrimaryButton>
          <button
            onClick={scrollToFeatures}
            className="px-6 py-3 rounded-xl font-medium text-sm border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--surface-subtle)] transition"
          >
            See what's inside
          </button>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[var(--text-muted)] text-xs">
          {["No KYC required", "Email + PIN or your own wallet", "Testnet — zero real funds at risk", "Contracts verified on Sourcify"].map((t) => (
            <span key={t} className="flex items-center gap-1.5">
              <span className="text-emerald-400">✓</span>{t}
            </span>
          ))}
        </div>
      </section>

      {/* What's actually live — facts, not invented stats */}
      <section className="px-4 sm:px-6 pb-16 max-w-4xl mx-auto">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { value: "9", label: "DeFi features" },
            { value: "3", label: "Testnet chains via CCTP" },
            { value: "3", label: "Verified contracts" },
            { value: "0", label: "Real funds at risk" },
          ].map((s) => (
            <GlassCard key={s.label} className="p-5 text-center">
              <p className="text-[var(--text-primary)] text-3xl font-bold tabular-nums">{s.value}</p>
              <p className="text-[var(--text-muted)] text-xs mt-1">{s.label}</p>
            </GlassCard>
          ))}
        </div>
      </section>

      {/* Feature grid */}
      <section id="landing-features" className="px-4 sm:px-6 pb-16 max-w-5xl mx-auto">
        <div className="text-center mb-10">
          <p className="text-cyan-300 text-xs font-semibold uppercase tracking-wide mb-2">Everything you need</p>
          <h2 className="text-[var(--text-primary)] text-3xl font-bold tracking-tight mb-3">One dashboard, nine features</h2>
          <p className="text-[var(--text-secondary)] text-sm max-w-lg mx-auto">
            Every feature below is wired to real Circle infrastructure and real deployed
            contracts — this isn't a mockup of a DeFi app, it's a working one on testnet.
          </p>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {LANDING_FEATURES.map((f) => (
            <GlassCard key={f.label} className="p-6">
              <div
                className={`w-10 h-10 rounded-xl bg-gradient-to-br ${f.grad} flex items-center justify-center text-sm font-bold text-[var(--text-primary)] mb-4`}
              >
                {f.glyph}
              </div>
              <h3 className="text-[var(--text-primary)] text-base font-semibold mb-1.5">{f.label}</h3>
              <p className="text-[var(--text-secondary)] text-xs leading-relaxed">{f.desc}</p>
            </GlassCard>
          ))}
        </div>
      </section>

      {/* Steps */}
      <section className="px-4 sm:px-6 pb-16 max-w-2xl mx-auto">
        <div className="text-center mb-10">
          <p className="text-cyan-300 text-xs font-semibold uppercase tracking-wide mb-2">Get started in minutes</p>
          <h2 className="text-[var(--text-primary)] text-3xl font-bold tracking-tight">Three steps, no forms to fill</h2>
        </div>
        <div className="space-y-6">
          {LANDING_STEPS.map((s) => (
            <div key={s.n} className="flex gap-4">
              <div className="w-9 h-9 shrink-0 rounded-full border border-cyan-400/40 bg-cyan-500/10 flex items-center justify-center text-cyan-300 text-sm font-semibold">
                {s.n}
              </div>
              <div>
                <h3 className="text-[var(--text-primary)] text-base font-semibold mb-1">{s.title}</h3>
                <p className="text-[var(--text-secondary)] text-sm">{s.desc}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="text-center mt-8">
          <PrimaryButton onClick={onLaunch} className="px-6! py-3!">
            Start Now — Free
          </PrimaryButton>
        </div>
      </section>

      {/* Transparency, not a fake trust badge wall */}
      <section className="px-4 sm:px-6 pb-16 max-w-3xl mx-auto">
        <GlassCard className="p-8">
          <p className="text-amber-300 text-xs font-semibold uppercase tracking-wide mb-2">Built in the open</p>
          <h2 className="text-[var(--text-primary)] text-2xl font-bold tracking-tight mb-4">What's real, and what to know before you use it</h2>
          <ul className="space-y-3 text-sm">
            <li className="flex gap-2 text-[var(--text-secondary)]">
              <span className="text-emerald-400 shrink-0">✓</span>
              All three smart contracts are deployed and independently verified on{" "}
              <a href="https://testnet.arcscan.app" target="_blank" rel="noopener noreferrer" className="text-cyan-300 hover:text-cyan-200 underline decoration-dotted">
                Sourcify / Arcscan
              </a>{" "}
              — you can read the exact code they run.
            </li>
            <li className="flex gap-2 text-[var(--text-secondary)]">
              <span className="text-emerald-400 shrink-0">✓</span>
              Circle Wallets are non-custodial — your PIN and security answers live with Circle's own hosted flow, not on Arclify's servers.
            </li>
            <li className="flex gap-2 text-[var(--text-secondary)]">
              <span className="text-amber-400 shrink-0">!</span>
              This is testnet only, unaudited software. No real funds should ever touch it — every token here is a faucet/testnet asset with no market value.
            </li>
            <li className="flex gap-2 text-[var(--text-secondary)]">
              <span className="text-amber-400 shrink-0">!</span>
              Swap and Deposit route through a shared signer/treasury wallet, not a per-user spend limit — fine on testnet, not how a production version would work.
            </li>
          </ul>
        </GlassCard>
      </section>

      {/* Final CTA */}
      <section className="px-4 sm:px-6 pb-16 max-w-2xl mx-auto text-center">
        <h2 className="text-[var(--text-primary)] text-2xl sm:text-3xl font-bold tracking-tight mb-3">
          Ready to see it running?
        </h2>
        <p className="text-[var(--text-secondary)] text-sm mb-6">
          No download, no KYC, no real money. Just sign in and start clicking around.
        </p>
        <PrimaryButton onClick={onLaunch} className="px-8! py-3!">
          Launch App →
        </PrimaryButton>
      </section>

      <ContactFooter />
    </div>
  );
}

function LoginGate({ wallet, auth, circleWallet, theme, toggleTheme }) {
  const [notRobot, setNotRobot] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [email, setEmail] = useState("");
  const busy = auth.status === "authenticating";
  const circleBusy = circleWallet.status === "working" || circleWallet.status === "pinChallenge";
  const injectedConnectors = wallet.connectors.filter((c) => c.kind === "injected");

  return (
    <div className="min-h-screen flex flex-col bg-[var(--bg-base)] bg-[radial-gradient(circle_at_20%_0%,var(--bg-grad-1),transparent_45%),radial-gradient(circle_at_80%_100%,var(--bg-grad-2),transparent_40%)]">
      <div className="flex justify-end p-4">
        <button
          onClick={toggleTheme}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-soft)] hover:bg-[var(--surface-subtle)] transition"
        >
          {theme === "dark" ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center p-6 gap-6 -mt-16">
        <GlassCard className="w-full max-w-md p-8">
          <div className="flex items-center justify-center gap-2 mb-1">
            <img src="/favicon.svg" alt="Arclify" className="w-9 h-9" />
            <span className="text-[var(--text-primary)] text-lg font-semibold tracking-tight">Arclify</span>
          </div>
          <p className="text-cyan-300/60 text-xs text-center mb-3">Our app is built on Arc</p>
          <p className="text-[var(--text-secondary)] text-sm text-center mb-6">
            Sign in with your wallet to open your Arc Testnet dashboard.
          </p>

          <label className="flex items-center gap-3 mb-5 px-4 py-3 rounded-xl border border-[var(--border)] bg-[var(--surface-subtle)] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={notRobot}
              onChange={(e) => setNotRobot(e.target.checked)}
              className="w-4 h-4 accent-cyan-400"
            />
            <span className="text-[var(--text-strong)] text-sm">I am not a robot</span>
          </label>

          {!showPicker ? (
            <PrimaryButton
              className="w-full"
              disabled={!notRobot}
              onClick={() => setShowPicker(true)}
            >
              Continue
            </PrimaryButton>
          ) : (
            <div className="space-y-2">
              {wallet.qrUri ? (
                <div className="text-center py-2">
                  <p className="text-[var(--text-secondary)] text-xs mb-3">
                    Scan with any WalletConnect-compatible wallet app
                  </p>
                  <QrCodeImage value={wallet.qrUri} />
                  <a
                    href={wallet.qrUri}
                    className="block mt-3 text-cyan-300 text-xs hover:text-cyan-200"
                  >
                    Or tap to open in a wallet app
                  </a>
                </div>
              ) : (
                <>
                  <p className="text-[var(--text-secondary)] text-xs mb-1">Choose a wallet</p>
                  {wallet.connectors.map((c) => (
                    <button
                      key={c.id}
                      disabled={busy}
                      onClick={() => auth.login(c.id)}
                      className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-[var(--border)] bg-[var(--surface-subtle)] hover:bg-[var(--surface)] transition text-left disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {c.icon ? (
                        <img src={c.icon} alt="" className="w-6 h-6 rounded" />
                      ) : (
                        <div className="w-6 h-6 rounded bg-gradient-to-br from-cyan-400 to-purple-600" />
                      )}
                      <span className="text-[var(--text-primary)] text-sm">{c.name}</span>
                    </button>
                  ))}
                  {injectedConnectors.length === 0 && (
                    <p className="text-[var(--text-muted)] text-xs pt-1">
                      No browser wallet extension detected — use WalletConnect above
                      to scan a QR code with any mobile wallet.
                    </p>
                  )}
                  {isMobileDevice() && injectedConnectors.length > 0 && (
                    <p className="text-[var(--text-muted)] text-xs pt-1">
                      On a phone, WalletConnect tends to be the more reliable choice
                      — an injected option like MetaMask can silently fail to return
                      after switching apps to approve.
                    </p>
                  )}

                  <div className="pt-2 mt-2 border-t border-[var(--border-subtle)]">
                    {!showEmailForm ? (
                      <button
                        onClick={() => setShowEmailForm(true)}
                        className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-[var(--border)] bg-[var(--surface-subtle)] hover:bg-[var(--surface)] transition text-left"
                      >
                        <div className="w-6 h-6 rounded bg-gradient-to-br from-emerald-400 to-teal-600 flex items-center justify-center text-xs text-[var(--text-primary)]">
                          ✉
                        </div>
                        <span className="text-[var(--text-primary)] text-sm">Sign in with Email</span>
                      </button>
                    ) : (
                      <div className="space-y-2">
                        <p className="text-[var(--text-secondary)] text-xs mb-1">
                          No wallet needed — you'll set a PIN to secure your account.
                        </p>
                        <input
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && circleWallet.loginWithEmail(email)}
                          placeholder="you@example.com"
                          disabled={circleBusy}
                          className="w-full bg-[var(--surface-subtle)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] text-sm"
                        />
                        <PrimaryButton
                          className="w-full"
                          disabled={circleBusy || !email.trim()}
                          onClick={() => circleWallet.loginWithEmail(email)}
                        >
                          {circleWallet.status === "pinChallenge"
                            ? "Set your PIN in the popup…"
                            : circleBusy
                            ? "Working…"
                            : "Continue with Email"}
                        </PrimaryButton>
                        {circleWallet.error && (
                          <p className="text-rose-300 text-xs">{circleWallet.error}</p>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {busy && (
            <p className="text-cyan-300 text-xs text-center mt-4">
              Confirm the connection, then sign the message in your wallet…
            </p>
          )}
          {(auth.error || wallet.error) && (
            <p className="text-rose-300 text-xs text-center mt-4">
              {auth.error || wallet.error}
            </p>
          )}
        </GlassCard>

        <div className="w-full max-w-md grid grid-cols-3 gap-3">
          {[
            { step: "1", title: "Connect", desc: "Pick any wallet — extension or mobile." },
            { step: "2", title: "Sign", desc: "Prove it's yours with a free signature." },
            { step: "3", title: "Explore", desc: "Send, swap, and lock on Arc Testnet." },
          ].map((s) => (
            <div key={s.step} className="text-center">
              <div className="mx-auto mb-2 w-7 h-7 rounded-full bg-[var(--surface-subtle)] border border-[var(--border)] flex items-center justify-center text-cyan-300 text-xs font-semibold">
                {s.step}
              </div>
              <p className="text-[var(--text-primary)] text-xs font-medium">{s.title}</p>
              <p className="text-[var(--text-muted)] text-[11px] mt-0.5 leading-snug">{s.desc}</p>
            </div>
          ))}
        </div>
      </div>
      <ContactFooter />
    </div>
  );
}

// Simple mobile detection — good enough to steer the UI hint, doesn't
// need to be bulletproof since it's advisory copy, not a hard gate.
function isMobileDevice() {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

const WELCOME_SEEN_KEY = "arclify_welcomed";

const OWNER_INFO = {
  name: "Salam Basit",
  xUrl: "https://x.com/callmebashrc",
  xHandle: "@callmebashrc",
  discord: "bash039630",
};

const WEB3_FACTS = [
  "The first-ever NFT, \"Quantum,\" was minted by Kevin McCoy back in 2014 — years before the term \"NFT\" even existed.",
  "Bitcoin's creator, Satoshi Nakamoto, is estimated to hold around 1 million BTC that has never moved.",
  "Ethereum's 2022 \"Merge\" cut the network's energy use by over 99% overnight by switching from mining to staking.",
  "A stablecoin like USDC aims to always equal $1 by holding real cash and short-term reserves behind every token issued.",
  "The Bitcoin whitepaper is only nine pages long, yet it launched an entire industry.",
  "Gas fees are named after the idea of \"fuel\" — every operation on a blockchain costs a small amount to computationally process.",
  "Wallets like MetaMask never actually store your crypto — they store the keys that prove it's yours on the blockchain.",
  "The word \"HODL\" came from a 2013 typo of \"hold\" in a Bitcoin forum post, and it's been crypto slang ever since.",
];

function WelcomeOverlay({ onDismiss }) {
  const fact = useMemo(
    () => WEB3_FACTS[Math.floor(Math.random() * WEB3_FACTS.length)],
    []
  );
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm">
      <GlassCard className="w-full max-w-sm p-7 text-center">
        <img src="/favicon.svg" alt="Arclify" className="w-10 h-10 mx-auto mb-4" />
        <p className="text-[var(--text-secondary)] text-sm mb-3">Did you know?</p>
        <p className="text-[var(--text-primary)] text-base leading-relaxed mb-6">{fact}</p>
        <PrimaryButton onClick={onDismiss} className="w-full">
          Continue
        </PrimaryButton>
      </GlassCard>
    </div>
  );
}

const TOUR_SEEN_KEY = "arclify_tour_seen";

const TOUR_STEPS = [
  { title: "Deposit", body: "Fund your wallet with Naira, Shillings, or Cedis — real Paystack checkout for NGN, converted straight to USDC/EURC." },
  { title: "Withdraw", body: "Cash out USDC/EURC — your tokens genuinely move on-chain, verifiable on Arcscan." },
  { title: "Transfer & Bulk Transfer", body: "Send native USDC, EURC, or cirBTC — one at a time or in a batch." },
  { title: "Swap", body: "Trade between stablecoins, routed through on-chain liquidity via Circle App Kit." },
  { title: "Bridge", body: "Move USDC in from Ethereum Sepolia, Base Sepolia, or Avalanche Fuji — a real CCTP burn-and-mint, not a wrapped asset." },
  { title: "Lending", body: "Deposit USDC as collateral, borrow EURC against it — a deployed, verified lending contract." },
  { title: "NFT Lock & Activity", body: "Time-lock an NFT in a vault with automatic unlock detection, and track everything you've done in the Activity Centre." },
];

function OnboardingTour({ onDismiss }) {
  const [step, setStep] = useState(0);
  const isLast = step === TOUR_STEPS.length - 1;
  const current = TOUR_STEPS[step];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm">
      <GlassCard className="w-full max-w-sm p-7">
        <div className="flex items-center gap-1.5 mb-5" role="progressbar" aria-valuenow={step + 1} aria-valuemin={1} aria-valuemax={TOUR_STEPS.length}>
          {TOUR_STEPS.map((_, i) => (
            <span
              key={i}
              className={`h-1 flex-1 rounded-full transition ${i <= step ? "bg-cyan-400" : "bg-[var(--surface)]"}`}
            />
          ))}
        </div>
        <p className="text-[var(--text-faint)] text-xs mb-1">Step {step + 1} of {TOUR_STEPS.length}</p>
        <h3 className="text-[var(--text-primary)] text-lg font-semibold mb-2">{current.title}</h3>
        <p className="text-[var(--text-secondary)] text-sm leading-relaxed mb-6">{current.body}</p>
        <div className="flex items-center justify-between gap-3">
          <button
            onClick={onDismiss}
            className="text-[var(--text-muted)] text-xs hover:text-[var(--text-soft)]"
          >
            Skip
          </button>
          <div className="flex gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                className="px-4 py-2 rounded-xl text-sm border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                Back
              </button>
            )}
            <PrimaryButton onClick={() => (isLast ? onDismiss() : setStep((s) => s + 1))}>
              {isLast ? "Get started" : "Next"}
            </PrimaryButton>
          </div>
        </div>
      </GlassCard>
    </div>
  );
}

function ContactFooter() {
  return (
    <footer className="px-4 sm:px-6 py-6 text-center border-t border-[var(--border-subtle)]">
      <div className="flex flex-wrap items-center justify-center gap-2 mb-3">
        <span className="text-[var(--text-faint)] text-[10px] uppercase tracking-wide mr-1">Built with</span>
        {["Circle App Kit", "Circle Wallets", "Circle CCTP", "Arc Testnet"].map((badge) => (
          <span
            key={badge}
            className="text-[10px] px-2.5 py-1 rounded-full border border-[var(--border)] bg-[var(--surface-subtle)] text-[var(--text-tertiary)]"
          >
            {badge}
          </span>
        ))}
      </div>
      <p className="text-[var(--text-faint)] text-xs">
        Built by {OWNER_INFO.name} ·{" "}
        <a
          href={OWNER_INFO.xUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--text-muted)] hover:text-cyan-300"
        >
          {OWNER_INFO.xHandle}
        </a>{" "}
        · Discord: {OWNER_INFO.discord}
      </p>
    </footer>
  );
}

/* ------------------------------------------------------------------ */
/*  App shell                                                           */
/* ------------------------------------------------------------------ */

// Background watcher for NFT Lock unlocks — runs regardless of which page
// is currently open, so a lock unlocking while the user is on Dashboard
// or mid-Swap still surfaces immediately rather than only being noticed
// on a manual visit to NFT Lock. Can't silently withdraw on its own (no
// wallet type here can sign without the user present — MetaMask needs a
// popup confirmation, Circle needs a PIN), so this notifies the moment a
// lock becomes eligible and lets one tap finish it.
function useNftLockAutoWatch(wallet, isLoggedIn) {
  const walletRef = useRef(wallet);
  walletRef.current = wallet;
  const notifiedRef = useRef(new Set());
  const withdrawingRef = useRef(new Set());

  useEffect(() => {
    if (!isLoggedIn || !wallet.address) return;
    let cancelled = false;

    async function checkLocks() {
      const lockIds = readLS(LS_LOCK_IDS_KEY, []);
      if (lockIds.length === 0) return;
      const vault = new ethers.Contract(NFT_LOCK_VAULT_ADDRESS, NFT_LOCK_ABI, readOnlyProvider);
      for (const id of lockIds) {
        if (cancelled) return;
        if (notifiedRef.current.has(id)) continue;
        try {
          const l = await withRpcRetry(() => vault.getLock(id));
          if (l.withdrawn) {
            notifiedRef.current.add(id); // already handled, nothing to notify about
            continue;
          }
          if (!l.canWithdraw) continue;

          notifiedRef.current.add(id);
          toast({
            tone: "ok",
            title: "NFT Lock unlocked",
            message: `Lock #${id} (token #${l.tokenId}) is ready to withdraw.`,
            action: {
              label: "Withdraw now",
              onClick: async () => {
                if (withdrawingRef.current.has(id)) return;
                withdrawingRef.current.add(id);
                try {
                  await performLockWithdraw(walletRef.current, id);
                  toast({ category: "NFT Lock", tone: "ok", title: "Withdrawn", message: `Lock #${id} withdrawn.` });
                } catch (e) {
                  toast({ category: "NFT Lock", tone: "bad", title: "Withdraw failed", message: e.shortMessage || e.message });
                } finally {
                  withdrawingRef.current.delete(id);
                }
              },
            },
          });
        } catch {
          // Read failed (RPC hiccup, unknown lockId, etc.) — skip for now,
          // it'll retry on the next poll cycle rather than erroring out.
        }
      }
    }

    checkLocks();
    const interval = setInterval(checkLocks, 20000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isLoggedIn, wallet.address, wallet.isCircleWallet]);
}

export default function ArcTestnetDApp() {
  const wallet = useWallet();
  const auth = useAuth(wallet);
  const circleWallet = useCircleWallet();
  const [page, setPage] = useState("Dashboard");
  const [showLanding, setShowLanding] = useState(true);
  // Session checks usually resolve in well under a second — showing
  // "Loading…" immediately for those just adds a flash of black screen
  // for no reason. Delaying the text by 400ms means fast checks go
  // straight to real content with nothing shown in between, while slower
  // ones (a cold backend) still get a visible "something's happening"
  // instead of looking frozen.
  const [showLoadingText, setShowLoadingText] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [showTour, setShowTour] = useState(false);

  // Theme is applied via a `data-theme` attribute on <html> rather than
  // prop-drilled through every page — every color in the app now reads
  // from CSS custom properties (see index.css), so toggling this one
  // attribute updates the whole app's palette at once, regardless of
  // component boundaries.
  const [theme, setTheme] = useState(() => readLS("arc_theme", "dark"));
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    writeLS("arc_theme", theme);
  }, [theme]);
  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  // Google Analytics — loads gtag.js dynamically rather than baking it
  // into index.html, so it's entirely optional and env-gated. No-ops
  // until VITE_GA_MEASUREMENT_ID is actually set.
  useEffect(() => {
    const measurementId = import.meta?.env?.VITE_GA_MEASUREMENT_ID;
    if (!measurementId || window.__gaLoaded) return;
    window.__gaLoaded = true;
    const script = document.createElement("script");
    script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
    script.async = true;
    document.head.appendChild(script);
    window.dataLayer = window.dataLayer || [];
    function gtag() { window.dataLayer.push(arguments); }
    window.gtag = gtag;
    gtag("js", new Date());
    gtag("config", measurementId);
  }, []);

  const isLoggedInViaCircle = circleWallet.status === "ready" && !!circleWallet.address;
  const isLoggedIn = auth.status === "authenticated" || isLoggedInViaCircle;

  const isCheckingSession = auth.status === "checking" || circleWallet.restoringSession;
  useEffect(() => {
    if (!isCheckingSession) {
      setShowLoadingText(false);
      return;
    }
    const t = setTimeout(() => setShowLoadingText(true), 400);
    return () => clearTimeout(t);
  }, [isCheckingSession]);

  // A single shape every page reads from, regardless of which login path
  // was used. Circle-wallet users get `provider: null` and `isCircleWallet:
  // true` — pages that need real signing (Transfer/Swap/NFT Lock) check
  // that flag to show a "coming soon" state instead of attempting an
  // ethers.js call that would fail (Phase 2 territory, not built yet).
  const effectiveWallet = isLoggedInViaCircle
    ? {
        address: circleWallet.address,
        provider: null,
        chainId: ARC_TESTNET.chainId,
        isOnArc: true,
        connecting: false,
        error: circleWallet.error,
        connectors: [],
        connect: () => {},
        disconnect: circleWallet.logout,
        qrUri: null,
        isCircleWallet: true,
        createDate: circleWallet.createDate,
        circleWalletsByChain: circleWallet.walletsByChain,
        circleCreateWallet: circleWallet.createWalletOnChain,
        circleBalance: circleWallet.balance,
        circleBalances: circleWallet.balances,
        refreshCircleBalance: circleWallet.refreshBalance,
        circleSendTransfer: circleWallet.sendTransfer,
        circleExecuteContract: circleWallet.executeContract,
      }
    : { ...wallet, isCircleWallet: false };

  useNftLockAutoWatch(effectiveWallet, isLoggedIn);

  // Show the welcome card exactly once, right after a successful sign-in —
  // never again after that, even across future logins on this browser.
  useEffect(() => {
    if (!isLoggedIn) return;
    if (localStorage.getItem(WELCOME_SEEN_KEY)) return;
    localStorage.setItem(WELCOME_SEEN_KEY, "1");
    setShowWelcome(true);
  }, [isLoggedIn]);

  const pageEl = useMemo(() => {
    switch (page) {
      case "Dashboard": return <DashboardPage wallet={effectiveWallet} setPage={setPage} />;
      case "Transfer": return <TransferPage wallet={effectiveWallet} />;
      case "Bulk Transfer": return <BulkTransferPage wallet={effectiveWallet} />;
      case "Agent Payroll": return <AgentPayrollPage wallet={effectiveWallet} />;
      case "Swap": return <SwapPage wallet={effectiveWallet} />;
      case "Bridge": return <BridgePage wallet={effectiveWallet} />;
      case "Lending": return <LendingPage wallet={effectiveWallet} />;
      case "ArclifyUSD": return <ArclifyUSDPage wallet={effectiveWallet} />;
      case "Deposit": return <DepositPage wallet={effectiveWallet} />;
      case "Withdraw": return <OffRampPage wallet={effectiveWallet} />;
      case "NFT Lock": return <NFTLockPage wallet={effectiveWallet} />;
      case "Activity": return <ActivityPage />;
      case "History": return <HistoryPage wallet={effectiveWallet} />;
      case "Leaderboard": return <LeaderboardPage wallet={effectiveWallet} />;
      case "Wallet Profile": return <WalletProfilePage wallet={effectiveWallet} />;
      default:
        return (
          <GlassCard className="p-6 max-w-lg text-center">
            <p className="text-[var(--text-primary)] text-lg font-semibold mb-2">Page not found</p>
            <p className="text-[var(--text-secondary)] text-sm mb-5">"{page}" isn't a page in Arclify.</p>
            <PrimaryButton onClick={() => setPage("Dashboard")}>Go to Dashboard</PrimaryButton>
          </GlassCard>
        );
    }
  }, [page, effectiveWallet]);

  if (isCheckingSession) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg-base)]">
        {showLoadingText && <p className="text-[var(--text-muted)] text-sm">Loading…</p>}
      </div>
    );
  }

  if (!isLoggedIn) {
    if (showLanding) {
      return <LandingPage onLaunch={() => setShowLanding(false)} theme={theme} toggleTheme={toggleTheme} />;
    }
    return <LoginGate wallet={wallet} auth={auth} circleWallet={circleWallet} theme={theme} toggleTheme={toggleTheme} />;
  }

  return (
    <div className="min-h-screen bg-[var(--bg-base)] bg-[radial-gradient(circle_at_20%_0%,var(--bg-grad-1),transparent_45%),radial-gradient(circle_at_80%_100%,var(--bg-grad-2),transparent_40%)]">
      <ToastViewport />
      <CommandBar wallet={effectiveWallet} onNavigate={setPage} />
      {showWelcome && (
        <WelcomeOverlay
          onDismiss={() => {
            setShowWelcome(false);
            if (!localStorage.getItem(TOUR_SEEN_KEY)) {
              localStorage.setItem(TOUR_SEEN_KEY, "1");
              setShowTour(true);
            }
          }}
        />
      )}
      {showTour && <OnboardingTour onDismiss={() => setShowTour(false)} />}
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 sm:px-6 py-4 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="Arclify" className="w-7 h-7" />
          <div className="leading-tight">
            <span className="block text-[var(--text-primary)] font-semibold tracking-tight">Arclify</span>
            <span className="block text-cyan-300/50 text-[10px]">Built on Arc</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isLoggedInViaCircle && <Pill tone="neutral">Email login</Pill>}
          <Pill tone={effectiveWallet.isOnArc ? "ok" : "warn"}>
            {effectiveWallet.address
              ? `${effectiveWallet.address.slice(0, 6)}…${effectiveWallet.address.slice(-4)}`
              : `${auth.sessionAddress?.slice(0, 6)}…${auth.sessionAddress?.slice(-4)}`}
          </Pill>
          {effectiveWallet.address && <CopyButton value={effectiveWallet.address} />}
          <button
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-soft)] hover:bg-[var(--surface-subtle)] transition"
          >
            {theme === "dark" ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
          <button
            onClick={() => { auth.logout(); circleWallet.logout(); }}
            className="text-[var(--text-muted)] text-xs hover:text-[var(--text-soft)]"
          >
            Sign out
          </button>
        </div>
      </header>

      {!isLoggedInViaCircle && !wallet.address && auth.sessionAddress && (
        <div className="px-4 sm:px-6 pt-3">
          <p className="text-amber-300 text-xs">
            Signed in as {auth.sessionAddress.slice(0, 6)}…{auth.sessionAddress.slice(-4)}, but your wallet isn't connected in this tab — reconnect it to send transactions.
          </p>
        </div>
      )}
      {effectiveWallet.error && (
        <div className="px-4 sm:px-6 pt-3">
          <p className="text-rose-300 text-xs">{effectiveWallet.error}</p>
        </div>
      )}

      <div className="flex flex-col sm:flex-row">
        {/* Horizontal scrollable pill nav on mobile; vertical sidebar from sm breakpoint up */}
        <nav className="flex sm:flex-col gap-1 overflow-x-auto sm:overflow-visible whitespace-nowrap sm:whitespace-normal p-3 sm:p-4 sm:w-48 sm:shrink-0 sm:space-y-1 border-b sm:border-b-0 border-[var(--border-subtle)]">
          {NAV_ITEMS.map((item) => (
            <button
              key={item}
              onClick={() => setPage(item)}
              className={`shrink-0 sm:w-full text-left px-3 py-2 rounded-lg text-sm transition ${
                page === item
                  ? "bg-[var(--surface)] text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-strong)] hover:bg-[var(--surface-subtle)]"
              }`}
            >
              {item}
            </button>
          ))}
        </nav>
        <main className="flex-1 p-4 sm:p-6 min-w-0">{pageEl}</main>
      </div>
      <ContactFooter />
    </div>
  );
}
