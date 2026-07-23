import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ethers } from "ethers";
import QRCode from "qrcode";
import { W3SSdk } from "@circle-fin/w3s-pw-web-sdk";
import { useInjectedWallets } from "./wallet/eip6963";
import { getWalletConnectProvider } from "./wallet/walletConnectProvider";

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

const LS_KEYS = {
  txs: "arc_txs",
  bulk: "arc_bulk",
  nftLocks: "arc_nft_locks",
};

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
      try {
        const { token, address, connectorId } = JSON.parse(raw);
        const res = await fetch(`${API_BASE}/auth/session`, {
          headers: { Authorization: `Bearer ${token}` },
        });
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
      } catch {
        localStorage.removeItem(SESSION_STORAGE_KEY);
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

  const getSdk = useCallback(() => {
    if (!sdkRef.current) {
      sdkRef.current = new W3SSdk({ appSettings: { appId: CIRCLE_APP_ID } });
    }
    return sdkRef.current;
  }, []);

  const loadWalletAndBalance = useCallback(async (userToken) => {
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
          reject(new Error(err?.message || "Wallet setup was cancelled or failed."));
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
      loadWalletAndBalance(session.userToken)
        .then((w) => setStatus(w ? "ready" : "idle"))
        .catch(() => {
          localStorage.removeItem(CIRCLE_SESSION_STORAGE_KEY);
          setStatus("idle");
        });
    } catch {
      localStorage.removeItem(CIRCLE_SESSION_STORAGE_KEY);
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
          reject(new Error(err?.message || "Transfer was cancelled or failed."));
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
  // targetWalletId/targetBlockchain default to the Arc wallet — every
  // existing caller (NFT Lock) keeps working unchanged. Bridge is the
  // first caller that needs to target a DIFFERENT chain's wallet (the
  // source chain, for approve/burn), and Circle validates that the
  // blockchain field matches whatever wallet is actually being used —
  // so both have to travel together, not just the wallet id.
  const executeContract = useCallback(async ({ contractAddress, abiFunctionSignature, abiParameters, targetWalletId, targetBlockchain }) => {
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
        blockchain: targetBlockchain,
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
          reject(new Error(err?.message || "Transaction was cancelled or failed."));
          return;
        }
        resolve();
      });
    });

    // The SDK callback doesn't hand back a txHash, so poll Circle's own
    // transaction list for the most recent transaction against this
    // contract and wait for it to reach a state that has a txHash.
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const listRes = await fetch(`${API_BASE}/circle/transactions?userToken=${encodeURIComponent(userToken)}`);
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
    className={`rounded-2xl border border-purple-500/20 bg-white/5 backdrop-blur-xl shadow-[0_0_40px_-15px_rgba(168,85,247,0.35)] ${className}`}
  >
    {children}
  </div>
);

const PrimaryButton = ({ children, disabled, ...props }) => (
  <button
    disabled={disabled}
    className={`px-5 py-2.5 rounded-xl font-medium text-sm transition border
      ${
        disabled
          ? "bg-white/10 text-white/50 border-white/15 cursor-not-allowed"
          : "bg-gradient-to-r from-cyan-500 to-purple-600 text-white border-transparent hover:brightness-110 active:scale-[0.98]"
      }`}
    {...props}
  >
    {children}
  </button>
);

const Pill = ({ tone = "neutral", children }) => {
  const tones = {
    neutral: "bg-white/10 text-white/70",
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
  <div className={`animate-pulse rounded-md bg-white/10 ${className}`} />
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
      className={`inline-flex items-center gap-1 text-white/40 hover:text-white/80 transition ${className}`}
    >
      {copied ? (
        <span className="text-emerald-300 text-xs">Copied!</span>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
    neutral: "border-white/10 bg-[#161226]/90",
  };

  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-[calc(100%-2rem)] max-w-sm">
      {items.map((t) => (
        <div
          key={t.id}
          className={`rounded-xl border ${toneStyles[t.tone] || toneStyles.neutral} backdrop-blur-xl px-4 py-3 shadow-lg animate-[fadeIn_0.15s_ease-out]`}
        >
          {t.title && <p className="text-white text-sm font-medium mb-0.5">{t.title}</p>}
          {t.message && <p className="text-white/60 text-xs break-all">{t.message}</p>}
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
        className="fixed bottom-4 left-4 z-40 w-12 h-12 rounded-full bg-gradient-to-br from-cyan-400 to-purple-600 flex items-center justify-center text-white text-lg shadow-lg hover:scale-105 transition"
        title="Quick command"
      >
        ⚡
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <GlassCard className="w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-white text-base font-semibold">Quick command</h3>
              <button onClick={reset} className="text-white/40 hover:text-white/70 text-sm">✕</button>
            </div>
            <p className="text-white/40 text-xs mb-3">
              Type an instruction in plain English — no need to open the matching page.
            </p>

            <input
              autoFocus
              value={text}
              onChange={(e) => { setText(e.target.value); setParsed(null); setError(null); }}
              onKeyDown={(e) => e.key === "Enter" && (parsed ? runCommand() : handleParse())}
              placeholder="send 20 USDC to 0x..."
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm mb-3"
            />

            {!parsed && (
              <PrimaryButton onClick={handleParse} className="w-full mb-1" disabled={!text.trim()}>
                Parse command
              </PrimaryButton>
            )}

            {parsed && (
              <div className="mb-3 px-3 py-3 rounded-lg border border-cyan-500/30 bg-cyan-950/30">
                <p className="text-white/50 text-xs mb-1">This will:</p>
                <p className="text-white text-sm font-medium mb-3">{describeCommand(parsed)}</p>
                <div className="flex gap-2">
                  <PrimaryButton onClick={runCommand} disabled={running} className="flex-1">
                    {running ? "Running…" : "Confirm"}
                  </PrimaryButton>
                  <button
                    onClick={() => setParsed(null)}
                    disabled={running}
                    className="px-4 py-2 rounded-lg text-white/60 text-sm border border-white/10 hover:bg-white/5"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {error && <p className="text-rose-300 text-xs mb-3">{error}</p>}

            <div className="border-t border-white/5 pt-3">
              <p className="text-white/40 text-xs mb-2">Try phrases like:</p>
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
  "Transfer",
  "Bulk Transfer",
  "Swap",
  "Bridge",
  "Lending",
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

function DashboardPage({ wallet }) {
  const [balances, setBalances] = useState({ USDC: "—", EURC: "—", cirBTC: "—" });
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

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

      if (!cancelled) setLoading(false);
    }
    loadBalances();
    return () => {
      cancelled = true;
    };
  }, [wallet.provider, wallet.address, wallet.isCircleWallet, wallet.circleBalance, wallet.circleBalances, refreshKey]);

  const usdcNum = Number(balances.USDC);
  const hasBalances = balances.USDC !== "—" && !Number.isNaN(usdcNum);
  // Rough combined total for the hero figure — USDC 1:1, EURC/cirBTC show
  // separately in their own units below since they aren't real USD
  // conversions (especially cirBTC, whose BTC price isn't tracked here).
  const total = hasBalances ? usdcNum : null;

  return (
    <div className="space-y-5">
      {/* Hero total balance — big and unmissable, bank-app style */}
      <GlassCard className="p-8 md:p-10">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <p className="text-white/50 text-sm mb-2">Total balance</p>
            {total === null ? (
              <Skeleton className="h-12 sm:h-14 md:h-16 w-64 max-w-full" />
            ) : (
              <p className="text-white text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight tabular-nums break-all">
                {`$${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              </p>
            )}
            <p className="text-white/30 text-xs mt-2">Your USDC balance (1 USDC ≈ $1)</p>
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
                className="text-white/40 text-xs hover:text-white/70 disabled:opacity-40 disabled:cursor-not-allowed underline decoration-dotted"
              >
                {loading ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            <div className="flex items-center gap-2 justify-end">
              <p className="text-white/40 font-mono text-xs break-all">
                {wallet.address ?? "Not connected"}
              </p>
              <CopyButton value={wallet.address} />
            </div>
          </div>
        </div>
      </GlassCard>

      {/* Individual token cards */}
      <div className="grid sm:grid-cols-3 gap-4">
        <GlassCard className="p-6">
          <div className="flex items-center justify-between mb-5">
            <span className="text-white/50 text-sm font-medium">USDC</span>
            <span className="w-9 h-9 rounded-full bg-gradient-to-br from-cyan-400 to-cyan-600 flex items-center justify-center text-xs font-bold text-white">
              $
            </span>
          </div>
          {balances.USDC === "—" ? (
            <Skeleton className="h-9 w-28" />
          ) : (
            <p className="text-white text-3xl font-semibold tabular-nums">{balances.USDC}</p>
          )}
        </GlassCard>
        <GlassCard className="p-6">
          <div className="flex items-center justify-between mb-5">
            <span className="text-white/50 text-sm font-medium">EURC</span>
            <span className="w-9 h-9 rounded-full bg-gradient-to-br from-purple-400 to-purple-600 flex items-center justify-center text-xs font-bold text-white">
              €
            </span>
          </div>
          {balances.EURC === "—" ? (
            <Skeleton className="h-9 w-28" />
          ) : (
            <p className="text-white text-3xl font-semibold tabular-nums">{balances.EURC}</p>
          )}
        </GlassCard>
        <GlassCard className="p-6">
          <div className="flex items-center justify-between mb-5">
            <span className="text-white/50 text-sm font-medium">cirBTC</span>
            <span className="w-9 h-9 rounded-full bg-gradient-to-br from-orange-400 to-orange-600 flex items-center justify-center text-xs font-bold text-white">
              ₿
            </span>
          </div>
          {balances.cirBTC === "—" ? (
            <Skeleton className="h-9 w-28" />
          ) : (
            <p className="text-white text-3xl font-semibold tabular-nums">{balances.cirBTC}</p>
          )}
        </GlassCard>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page: Transfer (real on-chain ERC-20 transfer via connected wallet) */
/* ------------------------------------------------------------------ */

function CirclePhase2Notice({ feature }) {
  return (
    <GlassCard className="p-6 max-w-lg">
      <h2 className="text-white text-lg font-semibold mb-2">{feature}</h2>
      <p className="text-white/50 text-sm">
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
      <h2 className="text-white text-lg font-semibold mb-4">Transfer</h2>
      {wallet.isCircleWallet && (
        <p className="text-cyan-300/70 text-xs mb-3">
          Circle Wallet: sending USDC, EURC, or cirBTC — you'll confirm with your PIN.
        </p>
      )}
      <label className="text-white/50 text-xs">Token</label>
      <select
        value={token}
        onChange={(e) => setToken(e.target.value)}
        className="w-full mt-1 mb-3 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white"
      >
        <option value="USDC">USDC</option>
        <option value="EURC">EURC</option>
        <option value="cirBTC">cirBTC</option>
      </select>
      <label className="text-white/50 text-xs">Recipient address</label>
      <input
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="0x..."
        className="w-full mt-1 mb-3 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white font-mono text-sm"
      />
      <label className="text-white/50 text-xs">Amount</label>
      <input
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="0.00"
        className="w-full mt-1 mb-4 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white"
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
      <h2 className="text-white text-lg font-semibold mb-4">Bulk Transfer</h2>
      <select
        value={token}
        onChange={(e) => setToken(e.target.value)}
        className="mb-3 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white"
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
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white font-mono text-sm"
          />
          <input
            value={row.amount}
            onChange={(e) => updateRow(i, "amount", e.target.value)}
            placeholder="Amount"
            className="w-28 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white"
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
        <div className="mt-4 space-y-1 text-xs font-mono text-white/70">
          {log.map((l, i) => (
            <p key={i}>{l}</p>
          ))}
        </div>
      )}
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
      <h2 className="text-white text-lg font-semibold mb-1">Swap</h2>
      <p className="text-white/40 text-xs mb-4">
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
          <label className="text-white/50 text-xs">From</label>
          <select
            value={tokenIn}
            onChange={(e) => setTokenIn(e.target.value)}
            className="w-full mt-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white"
          >
            {tokenOptions.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="flex-1">
          <label className="text-white/50 text-xs">To</label>
          <select
            value={tokenOut}
            onChange={(e) => setTokenOut(e.target.value)}
            className="w-full mt-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white"
          >
            {tokenOptions.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      </div>

      <label className="text-white/50 text-xs">Amount in</label>
      <input
        value={amountIn}
        onChange={(e) => setAmountIn(e.target.value)}
        placeholder="0.00"
        className="w-full mt-1 mb-3 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white"
      />

      <label className="text-white/50 text-xs">Slippage (bps)</label>
      <input
        type="number"
        value={slippageBps}
        onChange={(e) => setSlippageBps(Number(e.target.value))}
        className="w-full mt-1 mb-4 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white"
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
        <div className="mt-4 text-sm text-white/70 space-y-1">
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
      targetBlockchain: source.circleBlockchain,
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
      targetBlockchain: source.circleBlockchain,
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
      <h2 className="text-white text-lg font-semibold mb-1">Bridge</h2>
      <p className="text-white/40 text-xs mb-4">
        Move USDC in from another testnet via Circle's CCTP — a real burn on
        the source chain and a fresh native mint on Arc, not a wrapped
        token.{" "}
        {wallet.isCircleWallet
          ? "Each step is a separate PIN confirmation."
          : "Your wallet will prompt you to switch networks twice (source chain to burn, Arc to mint)."}
      </p>

      <label className="text-white/50 text-xs">From</label>
      <select
        value={sourceKey}
        onChange={(e) => setSourceKey(e.target.value)}
        disabled={busy}
        className="w-full mt-1 mb-4 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
      >
        {Object.entries(BRIDGE_SOURCE_CHAINS).map(([key, cfg]) => (
          <option key={key} value={key}>{cfg.label}</option>
        ))}
      </select>

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
          <label className="text-white/50 text-xs">Amount (USDC on {source.label})</label>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            disabled={busy}
            className="w-full mt-1 mb-4 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white"
          />

          <PrimaryButton disabled={busy} onClick={runBridge}>
            {busy ? "Bridging…" : "Bridge to Arc Testnet"}
          </PrimaryButton>
        </>
      )}

      {log.length > 0 && (
        <div className="mt-4 space-y-1">
          {log.map((line, i) => (
            <p key={i} className="text-white/60 text-xs font-mono">{line}</p>
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
      <h2 className="text-white text-lg font-semibold mb-1">Lending</h2>
      <p className="text-white/40 text-xs mb-4">
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

      {account && (
        <div className="grid grid-cols-2 gap-3 mb-5 text-sm">
          <div className="bg-white/5 rounded-lg p-3">
            <p className="text-white/40 text-xs">Your collateral</p>
            <p className="text-white font-medium">{Number(account.collateral).toFixed(4)} USDC</p>
          </div>
          <div className="bg-white/5 rounded-lg p-3">
            <p className="text-white/40 text-xs">Your debt</p>
            <p className="text-white font-medium">{Number(account.debt).toFixed(4)} EURC</p>
          </div>
          <div className="bg-white/5 rounded-lg p-3">
            <p className="text-white/40 text-xs">Max borrowable</p>
            <p className="text-white font-medium">{Number(account.maxBorrowable).toFixed(4)} EURC</p>
          </div>
          <div className="bg-white/5 rounded-lg p-3">
            <p className="text-white/40 text-xs">Pool liquidity</p>
            <p className="text-white font-medium">{Number(account.availableLiquidity).toFixed(2)} EURC</p>
          </div>
        </div>
      )}

      {account?.liquidatable && (
        <p className="mb-4 text-xs text-rose-300 bg-rose-950/40 border border-rose-500/30 rounded-lg p-3">
          Your position is eligible for liquidation — your debt has exceeded the safe threshold. Repay some debt now to avoid losing your collateral.
        </p>
      )}

      {poolInfo && (
        <p className="text-white/30 text-[11px] mb-5">
          Rate: 1 USDC = {poolInfo.exchangeRate.toFixed(4)} EURC · Max LTV {poolInfo.collateralFactorBps / 100}% · Liquidation at {poolInfo.liquidationThresholdBps / 100}% · {poolInfo.interestRateBps / 100}% APR
        </p>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-white/50 text-xs">Deposit collateral (USDC)</label>
          <input
            value={depositAmount}
            onChange={(e) => setDepositAmount(e.target.value)}
            placeholder="0.00"
            disabled={busy}
            className="w-full mt-1 mb-2 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
          />
          <PrimaryButton disabled={busy} onClick={handleDeposit}>Deposit</PrimaryButton>
        </div>
        <div>
          <label className="text-white/50 text-xs">Withdraw collateral (USDC)</label>
          <input
            value={withdrawAmount}
            onChange={(e) => setWithdrawAmount(e.target.value)}
            placeholder="0.00"
            disabled={busy}
            className="w-full mt-1 mb-2 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
          />
          <PrimaryButton disabled={busy} onClick={handleWithdraw}>Withdraw</PrimaryButton>
        </div>
        <div>
          <label className="text-white/50 text-xs">Borrow (EURC)</label>
          <input
            value={borrowAmount}
            onChange={(e) => setBorrowAmount(e.target.value)}
            placeholder="0.00"
            disabled={busy}
            className="w-full mt-1 mb-2 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
          />
          <PrimaryButton disabled={busy} onClick={handleBorrow}>Borrow</PrimaryButton>
        </div>
        <div>
          <label className="text-white/50 text-xs">Repay (EURC)</label>
          <input
            value={repayAmount}
            onChange={(e) => setRepayAmount(e.target.value)}
            placeholder="0.00"
            disabled={busy}
            className="w-full mt-1 mb-2 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
          />
          <PrimaryButton disabled={busy} onClick={handleRepay}>Repay</PrimaryButton>
        </div>
      </div>

      <div className="mt-6 pt-5 border-t border-white/10">
        <p className="text-white/40 text-xs mb-2">
          Fund the pool — adds EURC that anyone can borrow against their collateral. No individual yield tracking yet for suppliers (known limitation for this first version).
        </p>
        <div className="flex gap-2">
          <input
            value={fundAmount}
            onChange={(e) => setFundAmount(e.target.value)}
            placeholder="0.00"
            disabled={busy}
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
          />
          <PrimaryButton disabled={busy} onClick={handleFundPool}>Fund Pool</PrimaryButton>
        </div>
      </div>
    </GlassCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Page: NFT Lock (simulated — no App Kit capability covers this)      */
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
      <h2 className="text-white text-lg font-semibold mb-1">NFT Lock</h2>
      <p className="text-white/40 text-xs mb-4">
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
          <p className="text-white/50 text-xs mb-2">Unlocked NFTs you own — ready to lock</p>
          <div className="flex items-center gap-2 mb-3">
            <select
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
            >
              <option value="test2min">2 minutes (testing)</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
            </select>
          </div>
          <div className="space-y-2">
            {mintedIds.map((id) => (
              <div key={id} className="flex justify-between items-center text-sm text-white/80 border-t border-white/5 pt-2">
                <span>Token #{id}</span>
                <PrimaryButton disabled={busy} onClick={() => lockNft(id)}>Lock</PrimaryButton>
              </div>
            ))}
          </div>
        </div>
      )}

      {lockIds.length > 0 && (
        <div className="mt-5">
          <p className="text-white/50 text-xs mb-2">Your locks</p>
          <div className="space-y-2">
            {lockIds.map((id) => {
              const d = lockDetails[id];
              return (
                <div key={id} className="flex justify-between items-center text-sm border-t border-white/5 pt-2">
                  <span className="text-white/80">
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
                    <Pill tone="neutral">Loading…</Pill>
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

const ACTIVITY_CATEGORIES = ["All", "Transfer", "Bulk Transfer", "Swap", "Bridge", "Lending", "NFT Lock", "Command"];

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
        <h2 className="text-white text-lg font-semibold">Activity Centre</h2>
        {entries.length > 0 && (
          <button onClick={clearLog} className="text-white/40 hover:text-white/70 text-xs transition">
            Clear log
          </button>
        )}
      </div>
      <p className="text-white/40 text-xs mb-4">
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
                : "bg-white/5 border-white/10 text-white/50 hover:text-white/80"
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="text-white/30 text-sm py-8 text-center">
          {entries.length === 0 ? "Nothing here yet — actions you take across the app will show up here." : "Nothing in this category yet."}
        </p>
      ) : (
        <div className="space-y-2">
          {filtered.map((entry) => (
            <div key={entry.id} className="flex items-start justify-between gap-3 bg-white/5 rounded-lg px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      entry.tone === "ok" ? "bg-emerald-400" : "bg-rose-400"
                    }`}
                  />
                  <span className="text-white text-sm font-medium truncate">{entry.title}</span>
                  <span className="text-white/30 text-[10px] uppercase tracking-wide shrink-0">{entry.category}</span>
                </div>
                {entry.message && <p className="text-white/50 text-xs break-all">{entry.message}</p>}
              </div>
              <span className="text-white/30 text-xs shrink-0">{relativeTime(entry.timestamp)}</span>
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
      <h2 className="text-white text-lg font-semibold mb-1">History</h2>
      <p className="text-white/40 text-xs mb-4">
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
        <p className="text-white/40 text-sm">No EURC or cirBTC transfers found in the recent block range.</p>
      )}
      <div className="space-y-2">
        {rows.map((tx) => (
          <a
            key={tx.key}
            href={`${ARC_TESTNET.blockExplorerUrls[0]}/tx/${tx.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex justify-between items-center text-sm border-t border-white/5 pt-2 pb-1 hover:bg-white/5 rounded px-1 -mx-1 transition"
          >
            <div className="text-white/80">
              {tx.direction} {tx.amount} {tx.token}
              <span className="text-white/30 font-mono text-xs ml-2">
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
      <h2 className="text-white text-lg font-semibold mb-1">Leaderboard</h2>
      <p className="text-white/40 text-xs mb-4">
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
        <p className="text-white/40 text-sm">No transfer activity found in the recent block range.</p>
      )}
      {rows.map((r, i) => (
        <div
          key={r.address}
          className={`flex justify-between items-center text-sm border-t border-white/5 pt-2 pb-1 ${
            wallet.address?.toLowerCase() === r.address.toLowerCase() ? "text-cyan-300" : "text-white/80"
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
      <h2 className="text-white text-lg font-semibold mb-4">Wallet Profile</h2>
      <p className="text-white/50 text-xs">Address</p>
      <p className="text-white font-mono text-sm mb-3 break-all">{wallet.address || "—"}</p>
      <p className="text-white/50 text-xs">Network</p>
      <p className="text-white text-sm mb-3">{wallet.chainId ?? "—"}</p>
      <p className="text-white/50 text-xs">Wallet created</p>
      {wallet.isCircleWallet ? (
        <p className="text-white text-sm mb-3">
          {wallet.createDate
            ? new Date(wallet.createDate).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
            : "—"}
        </p>
      ) : (
        <p className="text-white/40 text-sm mb-3">
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

function LoginGate({ wallet, auth, circleWallet }) {
  const [notRobot, setNotRobot] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [email, setEmail] = useState("");
  const busy = auth.status === "authenticating";
  const circleBusy = circleWallet.status === "working" || circleWallet.status === "pinChallenge";
  const injectedConnectors = wallet.connectors.filter((c) => c.kind === "injected");

  return (
    <div className="min-h-screen flex flex-col bg-[#0B0A16] bg-[radial-gradient(circle_at_20%_0%,rgba(124,58,237,0.25),transparent_45%),radial-gradient(circle_at_80%_100%,rgba(34,211,238,0.15),transparent_40%)]">
      <div className="flex-1 flex flex-col items-center justify-center p-6 gap-6">
        <GlassCard className="w-full max-w-md p-8">
          <div className="flex items-center justify-center gap-2 mb-1">
            <img src="/favicon.svg" alt="Arclify" className="w-9 h-9" />
            <span className="text-white text-lg font-semibold tracking-tight">Arclify</span>
          </div>
          <p className="text-cyan-300/60 text-xs text-center mb-3">Our app is built on Arc</p>
          <p className="text-white/50 text-sm text-center mb-6">
            Sign in with your wallet to open your Arc Testnet dashboard.
          </p>

          <label className="flex items-center gap-3 mb-5 px-4 py-3 rounded-xl border border-white/10 bg-white/5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={notRobot}
              onChange={(e) => setNotRobot(e.target.checked)}
              className="w-4 h-4 accent-cyan-400"
            />
            <span className="text-white/80 text-sm">I am not a robot</span>
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
                  <p className="text-white/50 text-xs mb-3">
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
                  <p className="text-white/50 text-xs mb-1">Choose a wallet</p>
                  {wallet.connectors.map((c) => (
                    <button
                      key={c.id}
                      disabled={busy}
                      onClick={() => auth.login(c.id)}
                      className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 transition text-left disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {c.icon ? (
                        <img src={c.icon} alt="" className="w-6 h-6 rounded" />
                      ) : (
                        <div className="w-6 h-6 rounded bg-gradient-to-br from-cyan-400 to-purple-600" />
                      )}
                      <span className="text-white text-sm">{c.name}</span>
                    </button>
                  ))}
                  {injectedConnectors.length === 0 && (
                    <p className="text-white/40 text-xs pt-1">
                      No browser wallet extension detected — use WalletConnect above
                      to scan a QR code with any mobile wallet.
                    </p>
                  )}
                  {isMobileDevice() && injectedConnectors.length > 0 && (
                    <p className="text-white/40 text-xs pt-1">
                      On a phone, WalletConnect tends to be the more reliable choice
                      — an injected option like MetaMask can silently fail to return
                      after switching apps to approve.
                    </p>
                  )}

                  <div className="pt-2 mt-2 border-t border-white/5">
                    {!showEmailForm ? (
                      <button
                        onClick={() => setShowEmailForm(true)}
                        className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 transition text-left"
                      >
                        <div className="w-6 h-6 rounded bg-gradient-to-br from-emerald-400 to-teal-600 flex items-center justify-center text-xs text-white">
                          ✉
                        </div>
                        <span className="text-white text-sm">Sign in with Email</span>
                      </button>
                    ) : (
                      <div className="space-y-2">
                        <p className="text-white/50 text-xs mb-1">
                          No wallet needed — you'll set a PIN to secure your account.
                        </p>
                        <input
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && circleWallet.loginWithEmail(email)}
                          placeholder="you@example.com"
                          disabled={circleBusy}
                          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
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
              <div className="mx-auto mb-2 w-7 h-7 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-cyan-300 text-xs font-semibold">
                {s.step}
              </div>
              <p className="text-white text-xs font-medium">{s.title}</p>
              <p className="text-white/40 text-[11px] mt-0.5 leading-snug">{s.desc}</p>
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
        <p className="text-white/50 text-sm mb-3">Did you know?</p>
        <p className="text-white text-base leading-relaxed mb-6">{fact}</p>
        <PrimaryButton onClick={onDismiss} className="w-full">
          Continue
        </PrimaryButton>
      </GlassCard>
    </div>
  );
}

function ContactFooter() {
  return (
    <footer className="px-4 sm:px-6 py-5 text-center border-t border-white/5">
      <p className="text-white/30 text-xs">
        Built by {OWNER_INFO.name} ·{" "}
        <a
          href={OWNER_INFO.xUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-white/40 hover:text-cyan-300"
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
  const [showWelcome, setShowWelcome] = useState(false);

  const isLoggedInViaCircle = circleWallet.status === "ready" && !!circleWallet.address;
  const isLoggedIn = auth.status === "authenticated" || isLoggedInViaCircle;

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
      case "Dashboard": return <DashboardPage wallet={effectiveWallet} />;
      case "Transfer": return <TransferPage wallet={effectiveWallet} />;
      case "Bulk Transfer": return <BulkTransferPage wallet={effectiveWallet} />;
      case "Swap": return <SwapPage wallet={effectiveWallet} />;
      case "Bridge": return <BridgePage wallet={effectiveWallet} />;
      case "Lending": return <LendingPage wallet={effectiveWallet} />;
      case "NFT Lock": return <NFTLockPage wallet={effectiveWallet} />;
      case "Activity": return <ActivityPage />;
      case "History": return <HistoryPage wallet={effectiveWallet} />;
      case "Leaderboard": return <LeaderboardPage wallet={effectiveWallet} />;
      case "Wallet Profile": return <WalletProfilePage wallet={effectiveWallet} />;
      default: return null;
    }
  }, [page, effectiveWallet]);

  if (auth.status === "checking") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0B0A16]">
        <p className="text-white/40 text-sm">Loading…</p>
      </div>
    );
  }

  if (!isLoggedIn) {
    return <LoginGate wallet={wallet} auth={auth} circleWallet={circleWallet} />;
  }

  return (
    <div className="min-h-screen bg-[#0B0A16] bg-[radial-gradient(circle_at_20%_0%,rgba(124,58,237,0.25),transparent_45%),radial-gradient(circle_at_80%_100%,rgba(34,211,238,0.15),transparent_40%)]">
      <ToastViewport />
      <CommandBar wallet={effectiveWallet} onNavigate={setPage} />
      {showWelcome && <WelcomeOverlay onDismiss={() => setShowWelcome(false)} />}
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 sm:px-6 py-4 border-b border-white/5">
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="Arclify" className="w-7 h-7" />
          <div className="leading-tight">
            <span className="block text-white font-semibold tracking-tight">Arclify</span>
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
            onClick={() => { auth.logout(); circleWallet.logout(); }}
            className="text-white/40 text-xs hover:text-white/70"
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
        <nav className="flex sm:flex-col gap-1 overflow-x-auto sm:overflow-visible whitespace-nowrap sm:whitespace-normal p-3 sm:p-4 sm:w-48 sm:shrink-0 sm:space-y-1 border-b sm:border-b-0 border-white/5">
          {NAV_ITEMS.map((item) => (
            <button
              key={item}
              onClick={() => setPage(item)}
              className={`shrink-0 sm:w-full text-left px-3 py-2 rounded-lg text-sm transition ${
                page === item
                  ? "bg-white/10 text-white"
                  : "text-white/50 hover:text-white/80 hover:bg-white/5"
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
