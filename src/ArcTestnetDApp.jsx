import React, { useState, useEffect, useCallback, useMemo } from "react";
import { ethers } from "ethers";

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
};

// Tokens actually swappable on Arc Testnet (thin liquidity — see App Kit FAQ)
const SWAP_SUPPORTED_TESTNET_TOKENS = ["USDC", "EURC", "cirBTC"];

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 amount) returns (bool)",
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

function useWallet() {
  const [address, setAddress] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [provider, setProvider] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);

  const switchToArc = useCallback(async () => {
    if (!window.ethereum) return;
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: ARC_TESTNET.chainIdHex }],
      });
    } catch (switchErr) {
      // 4902 = chain not added yet
      if (switchErr.code === 4902) {
        await window.ethereum.request({
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
      } else {
        throw switchErr;
      }
    }
  }, []);

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      setError("No injected wallet found. Install MetaMask to continue.");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      // Mirrors App Kit's createEthersAdapterFromProvider({ provider: window.ethereum })
      const browserProvider = new ethers.BrowserProvider(window.ethereum);
      const accounts = await browserProvider.send("eth_requestAccounts", []);
      await switchToArc();
      const network = await browserProvider.getNetwork();
      setProvider(browserProvider);
      setAddress(accounts[0]);
      setChainId(Number(network.chainId));
    } catch (e) {
      setError(e.message || "Failed to connect wallet.");
    } finally {
      setConnecting(false);
    }
  }, [switchToArc]);

  const disconnect = useCallback(() => {
    setAddress(null);
    setProvider(null);
    setChainId(null);
  }, []);

  useEffect(() => {
    if (!window.ethereum) return;
    const onAccountsChanged = (accounts) => {
      if (accounts.length === 0) disconnect();
      else setAddress(accounts[0]);
    };
    const onChainChanged = (hex) => setChainId(parseInt(hex, 16));
    window.ethereum.on?.("accountsChanged", onAccountsChanged);
    window.ethereum.on?.("chainChanged", onChainChanged);
    return () => {
      window.ethereum.removeListener?.("accountsChanged", onAccountsChanged);
      window.ethereum.removeListener?.("chainChanged", onChainChanged);
    };
  }, [disconnect]);

  return {
    address,
    chainId,
    provider,
    connecting,
    error,
    connect,
    disconnect,
    isOnArc: chainId === ARC_TESTNET.chainId,
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
  const [balances, setBalances] = useState({ USDC: "—", EURC: "—" });

  useEffect(() => {
    async function loadBalances() {
      if (!wallet.provider || !wallet.address) return;
      try {
        const usdc = new ethers.Contract(CONTRACTS.USDC, ERC20_ABI, wallet.provider);
        const eurc = new ethers.Contract(CONTRACTS.EURC, ERC20_ABI, wallet.provider);
        const [uBal, uDec, eBal, eDec] = await Promise.all([
          usdc.balanceOf(wallet.address),
          usdc.decimals(),
          eurc.balanceOf(wallet.address),
          eurc.decimals(),
        ]);
        setBalances({
          USDC: ethers.formatUnits(uBal, uDec),
          EURC: ethers.formatUnits(eBal, eDec),
        });
      } catch {
        setBalances({ USDC: "0.00", EURC: "0.00" });
      }
    }
    loadBalances();
  }, [wallet.provider, wallet.address]);

  return (
    <div className="grid md:grid-cols-3 gap-4">
      <GlassCard className="p-6 md:col-span-2">
        <p className="text-white/50 text-sm mb-1">Connected as</p>
        <p className="text-white font-mono text-sm break-all">
          {wallet.address ?? "Not connected"}
        </p>
        <div className="mt-4 flex items-center gap-2">
          <Pill tone={wallet.isOnArc ? "ok" : "warn"}>
            {wallet.isOnArc ? "Arc Testnet (5042002)" : "Wrong network"}
          </Pill>
        </div>
      </GlassCard>
      <GlassCard className="p-6">
        <p className="text-white/50 text-sm mb-3">Balances</p>
        <div className="flex justify-between text-white text-sm mb-2">
          <span>USDC</span>
          <span className="font-mono">{balances.USDC}</span>
        </div>
        <div className="flex justify-between text-white text-sm">
          <span>EURC</span>
          <span className="font-mono">{balances.EURC}</span>
        </div>
      </GlassCard>
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
      const contract = new ethers.Contract(CONTRACTS[token], ERC20_ABI, signer);
      const decimals = await contract.decimals();
      const tx = await contract.transfer(to, ethers.parseUnits(amount, decimals));
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
    const contract = new ethers.Contract(CONTRACTS[token], ERC20_ABI, signer);
    const decimals = await contract.decimals();
    const results = [];
    for (const row of rows) {
      if (!ethers.isAddress(row.to) || !row.amount) continue;
      try {
        const tx = await contract.transfer(row.to, ethers.parseUnits(row.amount, decimals));
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

const SWAP_API_BASE = import.meta?.env?.VITE_SWAP_API_BASE || "/api";

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

function NFTLockPage() {
  const [locks, setLocks] = useState(() => readLS(LS_KEYS.nftLocks, []));
  const [tokenId, setTokenId] = useState("");
  const [duration, setDuration] = useState("7");

  const lockNft = () => {
    if (!tokenId) return;
    const next = [
      {
        id: crypto.randomUUID(),
        tokenId,
        lockedAt: Date.now(),
        unlockAt: Date.now() + Number(duration) * 86400000,
      },
      ...locks,
    ];
    setLocks(next);
    writeLS(LS_KEYS.nftLocks, next);
    setTokenId("");
  };

  return (
    <GlassCard className="p-6 max-w-lg">
      <h2 className="text-white text-lg font-semibold mb-1">NFT Lock</h2>
      <p className="text-white/40 text-xs mb-4">Simulated locally — no on-chain NFT-lock capability in App Kit.</p>
      <div className="flex gap-2 mb-4">
        <input
          value={tokenId}
          onChange={(e) => setTokenId(e.target.value)}
          placeholder="Token ID"
          className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white"
        />
        <select
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white"
        >
          <option value="7">7 days</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
        </select>
        <PrimaryButton onClick={lockNft}>Lock</PrimaryButton>
      </div>
      <div className="space-y-2">
        {locks.map((l) => (
          <div key={l.id} className="flex justify-between text-sm text-white/70 border-t border-white/5 pt-2">
            <span>#{l.tokenId}</span>
            <span>{new Date(l.unlockAt).toLocaleDateString()}</span>
          </div>
        ))}
      </div>
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
/*  App shell                                                           */
/* ------------------------------------------------------------------ */

export default function ArcTestnetDApp() {
  const wallet = useWallet();
  const [page, setPage] = useState("Dashboard");

  const pageEl = useMemo(() => {
    switch (page) {
      case "Dashboard": return <DashboardPage wallet={wallet} />;
      case "Transfer": return <TransferPage wallet={wallet} />;
      case "Bulk Transfer": return <BulkTransferPage wallet={wallet} />;
      case "Swap": return <SwapPage wallet={wallet} />;
      case "NFT Lock": return <NFTLockPage />;
      case "History": return <HistoryPage />;
      case "Leaderboard": return <LeaderboardPage wallet={wallet} />;
      case "Wallet Profile": return <WalletProfilePage wallet={wallet} />;
      default: return null;
    }
  }, [page, wallet]);

  return (
    <div className="min-h-screen bg-[#0B0A16] bg-[radial-gradient(circle_at_20%_0%,rgba(124,58,237,0.25),transparent_45%),radial-gradient(circle_at_80%_100%,rgba(34,211,238,0.15),transparent_40%)]">
      <header className="flex items-center justify-between px-6 py-4 border-b border-white/5">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-cyan-400 to-purple-600" />
          <span className="text-white font-semibold tracking-tight">Arclify</span>
        </div>
        {wallet.address ? (
          <div className="flex items-center gap-2">
            <Pill tone={wallet.isOnArc ? "ok" : "warn"}>
              {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
            </Pill>
            <button onClick={wallet.disconnect} className="text-white/40 text-xs">Disconnect</button>
          </div>
        ) : (
          <PrimaryButton onClick={wallet.connect} disabled={wallet.connecting}>
            {wallet.connecting ? "Connecting…" : "Connect Wallet"}
          </PrimaryButton>
        )}
      </header>

      {wallet.error && (
        <div className="px-6 pt-3">
          <p className="text-rose-300 text-xs">{wallet.error}</p>
        </div>
      )}

      <div className="flex">
        <nav className="w-48 shrink-0 p-4 space-y-1">
          {NAV_ITEMS.map((item) => (
            <button
              key={item}
              onClick={() => setPage(item)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition ${
                page === item
                  ? "bg-white/10 text-white"
                  : "text-white/50 hover:text-white/80 hover:bg-white/5"
              }`}
            >
              {item}
            </button>
          ))}
        </nav>
        <main className="flex-1 p-6">{pageEl}</main>
      </div>
    </div>
  );
}
