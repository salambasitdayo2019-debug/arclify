import { useEffect, useState } from "react";

/**
 * Discovers every EIP-6963 compliant wallet extension installed in the
 * browser (MetaMask, Coinbase Wallet, Rabby, Brave, OKX, Rainbow, Trust,
 * etc.) without hard-coding any single one of them.
 *
 * Falls back to legacy `window.ethereum` for older wallets that don't yet
 * announce themselves via EIP-6963.
 */
export function useInjectedWallets() {
  const [providers, setProviders] = useState([]);

  useEffect(() => {
    function onAnnounce(event) {
      const detail = event.detail;
      if (!detail?.info?.uuid || !detail?.provider) return;
      setProviders((prev) => {
        if (prev.some((p) => p.info.uuid === detail.info.uuid)) return prev;
        return [...prev, detail];
      });
    }

    window.addEventListener("eip6963:announceProvider", onAnnounce);
    // Ask every installed wallet to (re-)announce itself
    window.dispatchEvent(new Event("eip6963:requestProvider"));

    // Give EIP-6963 wallets a moment to respond; if none did and a legacy
    // `window.ethereum` exists, offer that as a single fallback option.
    const fallbackTimer = setTimeout(() => {
      setProviders((prev) => {
        if (prev.length > 0 || !window.ethereum) return prev;
        return [
          {
            info: {
              uuid: "legacy-injected",
              name: window.ethereum.isMetaMask ? "MetaMask" : "Browser Wallet",
              icon: "",
              rdns: "legacy.injected",
            },
            provider: window.ethereum,
          },
        ];
      });
    }, 350);

    return () => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      clearTimeout(fallbackTimer);
    };
  }, []);

  return providers;
}
