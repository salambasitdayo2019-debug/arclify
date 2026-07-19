import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // Circle's Web SDK (@circle-fin/w3s-pw-web-sdk) and some of its
    // dependencies rely on Node.js core modules (util, stream, events,
    // buffer, process) that don't exist in a browser. Vite doesn't
    // polyfill these automatically the way older bundlers did, so
    // without this, the app crashes with errors like
    // "i.inherits is not a function" the moment that SDK loads.
    nodePolyfills({
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
  ],
})
