import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

/**
 * The admin panel's build (M19, ADR-0016 §6).
 *
 * Two differences from the Mini App's config, and both come from the same fact:
 * **this bundle authenticates with a cookie.**
 *
 *  - The proxy covers `/admin`, not `/api`. That is the whole admin surface, and
 *    proxying it makes the panel and the API the *same origin* in development —
 *    which is required rather than convenient: the session cookie is scoped to
 *    `/admin` and the API sets no CORS headers, so a cross-origin panel would be
 *    signed out on every request with no useful error.
 *  - There is no `allowedHosts` list. The Mini App needs one because Telegram
 *    loads it through a tunnel; the panel is opened by a person in a browser and
 *    has no reason to be publicly reachable at all.
 */
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Source, not `dist` — the panel validates with the same zod schemas the
      // backend validates with (ADR-0003), and pointing at built output would mean
      // it silently used yesterday's contracts.
      '@payetam/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    // 5173 is the Mini App's. Both run under `make dev`.
    port: 5174,
    proxy: {
      '/admin': {
        target: process.env['VITE_API_ORIGIN'] ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 5174,
    proxy: {
      '/admin': {
        target: process.env['VITE_API_ORIGIN'] ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    // Higher than the Mini App's 300 kB: this one is opened on a desk over a fixed
    // line, and it carries data tables rather than a phone-sized funnel. Still a
    // ceiling, so a careless dependency shows up as a warning rather than as a
    // slow first paint for somebody working a queue.
    chunkSizeWarningLimit: 600,
  },
});
