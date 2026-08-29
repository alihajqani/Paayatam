/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

interface ImportMetaEnv {
  /**
   * Origin of the admin API. **Empty in every environment that works.**
   *
   * The admin session is a cookie scoped to `/admin`, and the API sets no CORS
   * headers at all — so the panel and the API have to be the same origin. In
   * development that is Vite's proxy below; in production it is nginx serving this
   * bundle and proxying `/admin/v1` to the API. This variable exists for the one
   * case neither covers, and pointing it at a different origin will fail on the
   * cookie rather than on the fetch (ADR-0010).
   */
  readonly VITE_ADMIN_API_BASE_URL?: string;
  /**
   * The release this bundle was built from (M22 phase 10).
   *
   * Compiled in by `docker/Dockerfile` from `PAYETAM_VERSION`, for the same
   * reason the Mini App's is: static files have no environment to read. Unset in
   * development, which `resolveVersion()` reports as `local`.
   */
  readonly VITE_APP_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
