import { isVersionMismatch, resolveVersion } from '@payetam/shared';
import { request } from '@/api/client';

/**
 * Which release this bundle is, and which one the server is (M22 phase 10).
 *
 * Two different facts, and the difference is the reason this module exists rather
 * than a string in a template.
 *
 * `APP_VERSION` is compiled in: `docker/Dockerfile` passes `PAYETAM_VERSION` as a
 * build arg and Vite substitutes it, so it describes the JavaScript actually
 * running in front of the user. That is not necessarily the release that is
 * deployed. A Telegram WebView caches a bundle hard and reopens it without asking
 * anyone, so the app on a user's screen the day after a deploy is routinely the
 * previous one talking to the current API — which is exactly the state that makes
 * a bug report unreproducible, and exactly the state a support conversation needs
 * to be able to see.
 */
export const APP_VERSION = resolveVersion(import.meta.env.VITE_APP_VERSION);

/**
 * The release the API says it is, or `null` if it did not answer.
 *
 * Never throws. Every caller here is decorating a screen with a version line, and
 * a version line is not worth an error state — an offline client shows the bundle
 * version alone, which is still the answer to the question people actually ask.
 */
export async function fetchServerVersion(): Promise<string | null> {
  try {
    const body = await request<{ version: string }>('/version');
    return resolveVersion(body.version);
  } catch {
    return null;
  }
}

/** Whether the bundle on screen and the release on the server disagree. */
export function isStaleBundle(serverVersion: string | null): boolean {
  return isVersionMismatch(APP_VERSION, serverVersion);
}
