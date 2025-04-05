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
  },

  runtimeConfig: {
    // Keys within public are also exposed to the client
    public: {
      // Public runtime config
    },
    // Server-only environment variables
    telegram: {
      token: process.env.TELEGRAM_BOT_TOKEN ?? '',
    }
  },

  nitro: {
    serverAssets: [{
      baseName: 'assets',
      dir: './assets'
    }]
  },

  devtools: { enabled: false },
  modules: [
    '@nuxt/eslint',
    '@nuxt/fonts',
    '@nuxt/image',
  ]
})