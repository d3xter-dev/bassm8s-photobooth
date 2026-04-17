import tailwindcss from "@tailwindcss/vite";

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2024-11-01',
  ssr: false,

  future: {
    compatibilityVersion: 4
  },

  css: ['~/assets/css/main.css'],

  vite: {
    plugins: [
      tailwindcss(),
    ],
    /** Bun-only built-in; Vite cannot resolve it when analyzing the server graph. */
    ssr: {
      external: ['bun:ffi'],
    },
  },

  runtimeConfig: {
    // Keys within public are also exposed to the client
    public: {
      // Public runtime config
    },
    // Server-only environment variables
    telegram: {
      token: '',
      /** Target chat or channel for photo uploads (e.g. supergroup id). */
      chatId: '',
    },
    camera: {
      type: '',
      /** Base URL of the Bun canon-bridge (HTTP). Default matches CANON_BRIDGE_PORT. */
      canonBridgeUrl: '',
      /** Spawn `bun server/camera/canon/canon-bridge.ts` when type is canon */
      canonBridgeAutostart: true,
      canonBridgePort: 31337,
      /** Zero-based EDSDK camera index */
      canonCameraIndex: 0,
      /** Optional: override path to EDSDK binary (default: server/vendor/esdk/macos/EDSDK.framework/...) */
      edsdkMacosDylibPath: '',
      /** Optional: override server/vendor/esdk root */
      edsdkVendorRoot: '',
    }
  },

  nitro: {
    serverAssets: [{
      baseName: 'assets',
      dir: './assets'
    }],
    rollupConfig: {
      external: ['bun:ffi'],
    },
    experimental: {
      websocket: true,
    },
  },

  devtools: { enabled: false },
  modules: [
    '@nuxt/eslint',
    '@nuxt/fonts',
    '@nuxt/image',
  ]
})