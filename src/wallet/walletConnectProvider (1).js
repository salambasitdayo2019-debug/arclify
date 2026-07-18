import { EthereumProvider } from "@walletconnect/ethereum-provider";

const ARC_TESTNET_CHAIN_ID = 5042002;

let providerPromise = null;

/**
 * Lazily creates (and caches) the WalletConnect v2 EIP-1193 provider.
 * Calling `.connect()` on the resolved provider opens the WalletConnect
 * QR modal so any mobile wallet can scan in.
 *
 * Requires VITE_WALLETCONNECT_PROJECT_ID to be set — get a free project ID
 * at https://cloud.reown.com (formerly WalletConnect Cloud).
 */
export function getWalletConnectProvider() {
  if (!providerPromise) {
    const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID;
    if (!projectId) {
      return Promise.reject(
        new Error(
          "WalletConnect is not configured. Set VITE_WALLETCONNECT_PROJECT_ID in your frontend env."
        )
      );
    }
    providerPromise = EthereumProvider.init({
      projectId,
      chains: [ARC_TESTNET_CHAIN_ID],
      optionalChains: [1],
      // Disabled: WalletConnect's built-in QR modal depends on @reown/appkit
      // bundling correctly, which has proven unreliable through Vite/Vercel
      // builds. We render our own QR code from the 'display_uri' event
      // instead — see useWallet's connect() in ArcTestnetDApp.jsx.
      showQrModal: false,
      metadata: {
        name: "Arclify",
        description: "Arc Testnet DeFi dashboard",
        url: typeof window !== "undefined" ? window.location.origin : "https://arclify.app",
        icons: [
          typeof window !== "undefined"
            ? `${window.location.origin}/favicon.svg`
            : "",
        ],
      },
      rpcMap: {
        [ARC_TESTNET_CHAIN_ID]: "https://rpc.testnet.arc.network",
      },
    });
  }
  return providerPromise;
}
