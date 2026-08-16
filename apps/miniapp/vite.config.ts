import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Source, not `dist`. The frontend validates with the same zod schemas the
      // backend validates with (ADR-0003), and pointing at the built output would
      // mean the Mini App silently used yesterday's contracts until someone
      // remembered to run `tsc -b`.
      '@payetam/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    // Telegram loads the Mini App over https from its own WebView, so during
    // development the API is reached through this proxy rather than by hardcoding
    // an origin that only works on one machine.
    proxy: {
      '/api': {
        target: process.env['VITE_API_ORIGIN'] ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    // The bundle is downloaded over Iranian mobile networks (ADR-0003). Keep the
    // ceiling low enough that a careless dependency shows up as a build warning.
    chunkSizeWarningLimit: 300,
  },
});
