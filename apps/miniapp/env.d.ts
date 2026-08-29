/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

interface ImportMetaEnv {
  /** Origin of the API. Empty in development, where Vite proxies `/api`. */
  readonly VITE_API_BASE_URL?: string;
  /**
   * The release this bundle was built from (M22 phase 10).
   *
   * Compiled in, because a Vite build is static files and has no environment to
   * read at runtime — `docker/Dockerfile` passes `PAYETAM_VERSION` in as a build
   * arg. Unset in development, and `resolveVersion()` turns that into `local`.
   */
  readonly VITE_APP_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
