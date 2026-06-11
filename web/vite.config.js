import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// base is set at deploy time to the repo name for GitHub Pages (e.g. '/nsp-attendance/')
export default defineConfig({
  base: process.env.PWA_BASE || '/',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'NSP Attendance',
        short_name: 'Attendance',
        description: 'NSP Enterprises attendance — live floor, alerts, downloads, manual punch',
        theme_color: '#c0392b',
        background_color: '#ffffff',
        display: 'standalone',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
});
