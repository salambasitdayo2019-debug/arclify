import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { ethers } from "ethers";
import { useInjectedWallets } from "./wallet/eip6963";
import { getWalletConnectProvider } from "./wallet/walletConnectProvider";

/* ------------------------------------------------------------------ */
/*  Arc Testnet config                                                 */
/* ------------------------------------------------------------------ */

const ARC_TESTNET = {
  chainIdHex: "0x4CEF52", // 5042002
  chainId: 5042002,
  chainName: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: ["https://rpc.testnet.arc.network"],
  blockExplorerUrls: ["https://testnet.arcscan.app"],
};

const CONTRACTS = {
  USDC: "0x3600000000000000000000000000000000000000",
  EURC: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
  cirBTC: "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF",
};

// Circle stablecoins (USDC, EURC) always use 6 decimals — hardcoding this
// avoids an extra RPC round trip per token, which matters on Arc Testnet's
// rate-limited public RPC. cirBTC follows standard Bitcoin/WBTC precision
// (8 decimals), same as Circle's own reference docs.
const STABLECOIN_DECIMALS = 6;
const CIRBTC_DECIMALS = 8;
const TOKEN_DECIMALS = { EURC: STABLECOIN_DECIMALS, cirBTC: CIRBTC_DECIMALS };

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
async function withRpcRetry(fn, { retries = 3, baseDelayMs = 600 } = {}) {
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
      if (!isRateLimited || attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, baseDelayMs * (attempt + 1)));
    }
  }
  throw lastErr;
}

const API_BASE = import.meta?.env?.VITE_SWAP_API_BASE || "/api";
const SESSION_STORAGE_KEY = "arclify_session";

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

/* ------------------------------------------------------------------ */
/*  LocalStorage-backed simulation layer                               */
/*  (Dashboard / History / Leaderboard / NFT Lock / Bulk Transfer      */
/*   still run on a local mock ledger — Circle App Kit has no          */
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
          await raw.connect();
        }
        const browserProvider = new ethers.BrowserProvider(raw);
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
    className={`px-5 py-2.5 rounded-xl font-medium text-sm transition
      ${
        disabled
          ? "bg-white/5 text-white/30 cursor-not-allowed"
          : "bg-gradient-to-r from-cyan-500 to-purple-600 text-white hover:brightness-110 active:scale-[0.98]"
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

const NAV_ITEMS = [
  "Dashboard",
  "Transfer",
  "Bulk Transfer",
  "Swap",
  "NFT Lock",
  "History",
  "Leaderboard",
  "Wallet Profile",
];

/* ------------------------------------------------------------------ */
/*  Page: Dashboard                                                    */
/* ------------------------------------------------------------------ */

function DashboardPage({ wallet }) {
  const [balances, setBalances] = useState({ USDC: "—", EURC: "—", cirBTC: "—" });

  useEffect(() => {
    let cancelled = false;
    async function loadBalances() {
      if (!wallet.provider || !wallet.address) return;
      const eurc = new ethers.Contract(CONTRACTS.EURC, ERC20_ABI, wallet.provider);
      const cirbtc = new ethers.Contract(CONTRACTS.cirBTC, ERC20_ABI, wallet.provider);

      // Each balance is fetched (and can fail) independently — one bad
      // token shouldn't blank out the ones that succeeded.
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

      try {
        const eBal = await withRpcRetry(() => eurc.balanceOf(wallet.address));
        if (!cancelled) {
          setBalances((b) => ({ ...b, EURC: ethers.formatUnits(eBal, TOKEN_DECIMALS.EURC) }));
        }
      } catch {
        if (!cancelled) setBalances((b) => ({ ...b, EURC: "0.00" }));
      }

      try {
        const bBal = await withRpcRetry(() => cirbtc.balanceOf(wallet.address));
        if (!cancelled) {
          setBalances((b) => ({ ...b, cirBTC: ethers.formatUnits(bBal, TOKEN_DECIMALS.cirBTC) }));
        }
      } catch {
        if (!cancelled) setBalances((b) => ({ ...b, cirBTC: "0.00" }));
      }
    }
    loadBalances();
    return () => {
      cancelled = true;
    };
  }, [wallet.provider, wallet.address]);

  const usdcNum = Number(balances.USDC);
  const eurcNum = Number(balances.EURC);
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
            <p className="text-white text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight tabular-nums break-all">
              {total === null ? "—" : `$${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            </p>
            <p className="text-white/30 text-xs mt-2">Your USDC balance (1 USDC ≈ $1)</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <Pill tone={wallet.isOnArc ? "ok" : "warn"}>
              {wallet.isOnArc ? "Arc Testnet · 5042002" : "Wrong network"}
            </Pill>
            <p className="text-white/40 font-mono text-xs break-all text-right">
              {wallet.address ?? "Not connected"}
            </p>
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
          <p className="text-white text-3xl font-semibold tabular-nums">
            {balances.USDC}
          </p>
        </GlassCard>
        <GlassCard className="p-6">
          <div className="flex items-center justify-between mb-5">
            <span className="text-white/50 text-sm font-medium">EURC</span>
            <span className="w-9 h-9 rounded-full bg-gradient-to-br from-purple-400 to-purple-600 flex items-center justify-center text-xs font-bold text-white">
              €
            </span>
          </div>
          <p className="text-white text-3xl font-semibold tabular-nums">
            {balances.EURC}
          </p>
        </GlassCard>
        <GlassCard className="p-6">
          <div className="flex items-center justify-between mb-5">
            <span className="text-white/50 text-sm font-medium">cirBTC</span>
            <span className="w-9 h-9 rounded-full bg-gradient-to-br from-orange-400 to-orange-600 flex items-center justify-center text-xs font-bold text-white">
              ₿
            </span>
          </div>
          <p className="text-white text-3xl font-semibold tabular-nums">
            {balances.cirBTC}
          </p>
        </GlassCard>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page: Transfer (real on-chain ERC-20 transfer via connected wallet) */
/* ------------------------------------------------------------------ */

function TransferPage({ wallet }) {
  const [token, setToken] = useState("USDC");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState(null);

  const handleSend = useCallback(async () => {
    if (!wallet.provider || !wallet.address) {
      setStatus({ tone: "bad", msg: "Connect your wallet first." });
      return;
    }
    if (!ethers.isAddress(to) || !amount) {
      setStatus({ tone: "bad", msg: "Enter a valid address and amount." });
      return;
    }
    setStatus({ tone: "neutral", msg: "Confirm in wallet…" });
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
      setStatus({ tone: "warn", msg: `Submitted: ${tx.hash}` });
      await tx.wait();
      pushTx({ type: "Transfer", token, to, amount, txHash: tx.hash, status: "confirmed" });
      setStatus({ tone: "ok", msg: `Confirmed: ${tx.hash}` });
    } catch (e) {
      setStatus({ tone: "bad", msg: e.shortMessage || e.message });
    }
  }, [wallet, token, to, amount]);

  return (
    <GlassCard className="p-6 max-w-lg">
      <h2 className="text-white text-lg font-semibold mb-4">Transfer</h2>
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
      <PrimaryButton onClick={handleSend}>Send</PrimaryButton>
      {status && (
        <p className="mt-3 text-xs text-white/70 break-all">{status.msg}</p>
      )}
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
      setLog(["Connect your wallet first."]);
      return;
    }
    const signer = await wallet.provider.getSigner();
    const isNative = token === NATIVE_TOKEN_SYMBOL;
    const contract = isNative ? null : new ethers.Contract(CONTRACTS[token], ERC20_ABI, signer);
    const decimals = isNative ? NATIVE_BALANCE_DECIMALS : TOKEN_DECIMALS[token];
    const results = [];
    for (const row of rows) {
      if (!ethers.isAddress(row.to) || !row.amount) continue;
      try {
        const tx = isNative
          ? await signer.sendTransaction({ to: row.to, value: ethers.parseUnits(row.amount, decimals) })
          : await contract.transfer(row.to, ethers.parseUnits(row.amount, decimals));
        await tx.wait();
        results.push(`✓ ${row.amount} ${token} → ${row.to.slice(0, 10)}… (${tx.hash.slice(0, 10)}…)`);
      } catch (e) {
        results.push(`✗ ${row.to.slice(0, 10)}… failed: ${e.shortMessage || e.message}`);
      }
    }
    writeLS(LS_KEYS.bulk, [{ id: crypto.randomUUID(), token, rows, timestamp: Date.now() }, ...readLS(LS_KEYS.bulk, [])]);
    setLog(results);
  }, [wallet, rows, token]);

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

  const tokenOptions = SWAP_SUPPORTED_TESTNET_TOKENS;

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
    } catch (e) {
      setErrorMsg(e.message);
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
  const [status, setStatus] = useState(null);

  const getContracts = useCallback(async () => {
    const signer = await wallet.provider.getSigner();
    const nft = new ethers.Contract(NFT_CONTRACT_ADDRESS, NFT_ABI, signer);
    const vault = new ethers.Contract(NFT_LOCK_VAULT_ADDRESS, NFT_LOCK_ABI, signer);
    return { nft, vault };
  }, [wallet.provider]);

  // Pull live status for every lock this browser knows about
  useEffect(() => {
    async function loadLockDetails() {
      if (!wallet.provider || lockIds.length === 0) return;
      const vault = new ethers.Contract(NFT_LOCK_VAULT_ADDRESS, NFT_LOCK_ABI, wallet.provider);
      const entries = await Promise.all(
        lockIds.map(async (id) => {
          try {
            const l = await vault.getLock(id);
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
    if (!wallet.provider) {
      setStatus({ tone: "bad", msg: "Connect your wallet first." });
      return;
    }
    setBusy(true);
    setStatus({ tone: "neutral", msg: "Confirm mint in wallet…" });
    try {
      const { nft } = await getContracts();
      const tx = await nft.mint();
      const receipt = await tx.wait();
      const transferEvent = receipt.logs
        .map((log) => { try { return nft.interface.parseLog(log); } catch { return null; } })
        .find((parsed) => parsed?.name === "Transfer");
      const newTokenId = transferEvent?.args?.tokenId?.toString();
      const next = [newTokenId, ...mintedIds];
      setMintedIds(next);
      writeLS(LS_MINTED_KEY, next);
      setStatus({ tone: "ok", msg: `Minted token #${newTokenId}` });
    } catch (e) {
      setStatus({ tone: "bad", msg: e.shortMessage || e.message });
    } finally {
      setBusy(false);
    }
  }, [wallet.provider, mintedIds, getContracts]);

  const lockNft = useCallback(async (tokenId) => {
    setBusy(true);
    setStatus({ tone: "neutral", msg: "Approving, then locking…" });
    try {
      const { nft, vault } = await getContracts();
      const approveTx = await nft.approve(NFT_LOCK_VAULT_ADDRESS, tokenId);
      await approveTx.wait();

      const unlockAt = Math.floor(Date.now() / 1000) + Number(duration) * 86400;
      const lockTx = await vault.lock(NFT_CONTRACT_ADDRESS, tokenId, unlockAt);
      const receipt = await lockTx.wait();
      const lockedEvent = receipt.logs
        .map((log) => { try { return vault.interface.parseLog(log); } catch { return null; } })
        .find((parsed) => parsed?.name === "Locked");
      const newLockId = lockedEvent?.args?.lockId?.toString();

      const nextLockIds = [newLockId, ...lockIds];
      setLockIds(nextLockIds);
      writeLS(LS_LOCK_IDS_KEY, nextLockIds);

      const nextMinted = mintedIds.filter((id) => id !== tokenId);
      setMintedIds(nextMinted);
      writeLS(LS_MINTED_KEY, nextMinted);

      setStatus({ tone: "ok", msg: `Locked token #${tokenId} until unlock time.` });
    } catch (e) {
      setStatus({ tone: "bad", msg: e.shortMessage || e.message });
    } finally {
      setBusy(false);
    }
  }, [getContracts, duration, lockIds, mintedIds]);

  const withdrawLock = useCallback(async (lockId) => {
    setBusy(true);
    setStatus({ tone: "neutral", msg: "Withdrawing…" });
    try {
      const { vault } = await getContracts();
      const tx = await vault.withdraw(lockId);
      await tx.wait();
      setStatus({ tone: "ok", msg: `Withdrawn lock #${lockId}.` });
      setLockDetails((prev) => ({ ...prev, [lockId]: { ...prev[lockId], withdrawn: true } }));
    } catch (e) {
      setStatus({ tone: "bad", msg: e.shortMessage || e.message });
    } finally {
      setBusy(false);
    }
  }, [getContracts]);

  return (
    <GlassCard className="p-6 max-w-lg">
      <h2 className="text-white text-lg font-semibold mb-1">NFT Lock</h2>
      <p className="text-white/40 text-xs mb-4">
        Real on-chain lock via a custom vault contract on Arc Testnet. Mint a free test NFT, then lock it for a chosen duration.
      </p>

      <PrimaryButton disabled={busy} onClick={mintNft}>
        {busy ? "Working…" : "Mint test NFT"}
      </PrimaryButton>

      {status && <p className="mt-3 text-xs text-white/70 break-all">{status.msg}</p>}

      {mintedIds.length > 0 && (
        <div className="mt-5">
          <p className="text-white/50 text-xs mb-2">Unlocked NFTs you own — ready to lock</p>
          <div className="flex items-center gap-2 mb-3">
            <select
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
            >
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
/*  Page: History                                                       */
/* ------------------------------------------------------------------ */

function HistoryPage() {
  const [txs] = useState(() => readLS(LS_KEYS.txs, []));
  return (
    <GlassCard className="p-6">
      <h2 className="text-white text-lg font-semibold mb-4">History</h2>
      <div className="space-y-2">
        {txs.length === 0 && <p className="text-white/40 text-sm">No transactions yet.</p>}
        {txs.map((tx) => (
          <div key={tx.id} className="flex justify-between items-center text-sm border-t border-white/5 pt-2">
            <div className="text-white/80">
              {tx.type} {tx.token || tx.tokenIn} {tx.amount || tx.amountIn}
            </div>
            <Pill tone={tx.status === "confirmed" ? "ok" : "warn"}>{tx.status}</Pill>
          </div>
        ))}
      </div>
    </GlassCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Page: Leaderboard (simulated ranking by local tx volume)            */
/* ------------------------------------------------------------------ */

function LeaderboardPage({ wallet }) {
  const txs = readLS(LS_KEYS.txs, []);
  const total = txs.reduce((s, t) => s + Number(t.amount || t.amountIn || 0), 0);
  const rows = [{ address: wallet.address || "you", volume: total }];

  return (
    <GlassCard className="p-6">
      <h2 className="text-white text-lg font-semibold mb-4">Leaderboard</h2>
      <p className="text-white/40 text-xs mb-4">Based on locally recorded activity for this browser.</p>
      {rows.map((r, i) => (
        <div key={i} className="flex justify-between text-sm text-white/80 border-t border-white/5 pt-2">
          <span className="font-mono">{r.address?.slice(0, 12)}…</span>
          <span>{r.volume.toFixed(2)}</span>
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

function LoginGate({ wallet, auth }) {
  const [notRobot, setNotRobot] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const busy = auth.status === "authenticating";
  const injectedConnectors = wallet.connectors.filter((c) => c.kind === "injected");

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-[#0B0A16] bg-[radial-gradient(circle_at_20%_0%,rgba(124,58,237,0.25),transparent_45%),radial-gradient(circle_at_80%_100%,rgba(34,211,238,0.15),transparent_40%)]">
      <GlassCard className="w-full max-w-md p-8">
        <div className="flex items-center justify-center gap-2 mb-2">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-cyan-400 to-purple-600" />
          <span className="text-white text-lg font-semibold tracking-tight">Arclify</span>
        </div>
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
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  App shell                                                           */
/* ------------------------------------------------------------------ */

export default function ArcTestnetDApp() {
  const wallet = useWallet();
  const auth = useAuth(wallet);
  const [page, setPage] = useState("Dashboard");

  const pageEl = useMemo(() => {
    switch (page) {
      case "Dashboard": return <DashboardPage wallet={wallet} />;
      case "Transfer": return <TransferPage wallet={wallet} />;
      case "Bulk Transfer": return <BulkTransferPage wallet={wallet} />;
      case "Swap": return <SwapPage wallet={wallet} />;
      case "NFT Lock": return <NFTLockPage wallet={wallet} />;
      case "History": return <HistoryPage />;
      case "Leaderboard": return <LeaderboardPage wallet={wallet} />;
      case "Wallet Profile": return <WalletProfilePage wallet={wallet} />;
      default: return null;
    }
  }, [page, wallet]);

  if (auth.status === "checking") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0B0A16]">
        <p className="text-white/40 text-sm">Loading…</p>
      </div>
    );
  }

  if (auth.status !== "authenticated") {
    return <LoginGate wallet={wallet} auth={auth} />;
  }

  return (
    <div className="min-h-screen bg-[#0B0A16] bg-[radial-gradient(circle_at_20%_0%,rgba(124,58,237,0.25),transparent_45%),radial-gradient(circle_at_80%_100%,rgba(34,211,238,0.15),transparent_40%)]">
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 sm:px-6 py-4 border-b border-white/5">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-cyan-400 to-purple-600" />
          <span className="text-white font-semibold tracking-tight">Arclify</span>
        </div>
        <div className="flex items-center gap-2">
          <Pill tone={wallet.isOnArc ? "ok" : "warn"}>
            {wallet.address
              ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`
              : `${auth.sessionAddress?.slice(0, 6)}…${auth.sessionAddress?.slice(-4)}`}
          </Pill>
          <button onClick={auth.logout} className="text-white/40 text-xs hover:text-white/70">
            Sign out
          </button>
        </div>
      </header>

      {!wallet.address && auth.sessionAddress && (
        <div className="px-4 sm:px-6 pt-3">
          <p className="text-amber-300 text-xs">
            Signed in as {auth.sessionAddress.slice(0, 6)}…{auth.sessionAddress.slice(-4)}, but your wallet isn't connected in this tab — reconnect it to send transactions.
          </p>
        </div>
      )}
      {wallet.error && (
        <div className="px-4 sm:px-6 pt-3">
          <p className="text-rose-300 text-xs">{wallet.error}</p>
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
    </div>
  );
}
