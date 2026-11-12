import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

import { cloudflare } from "@cloudflare/vite-plugin";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png', 'en.hilali.txt'],
      manifest: {
        name: 'The Quran — A Space for Reflection',
        short_name: 'Quran Reader',
        description: 'A quiet, offline-friendly reader for Quran translations.',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#f8f6ef',
        theme_color: '#f8f6ef',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,txt,webmanifest}'],
        cleanupOutdatedCaches: true,
      },
    }),
    cloudflare(),
  ],
})
