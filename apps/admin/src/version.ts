import { isVersionMismatch, resolveVersion } from '@payetam/shared';
import { request } from '@/api/client';

/**
 * Which release the panel is, and which one the API is (M22 phase 10).
 *
 * `APP_VERSION` is compiled in by `docker/Dockerfile` from `PAYETAM_VERSION` —
 * the same value that tags the image — so it describes the bundle in the browser.
 * `fetchServerVersion()` asks the API which release *it* is running.
 *
 * Both, and not just the first, because the operator reading this line is often
 * reading it during a deploy, and "has the API rolled yet?" is the question. The
 * two roll separately: nginx serves a new bundle the moment its container is up,
 * while the API is a second container with its own start-up and its own migration
 * step in front of it. A minute where the panel is ahead of the API is a normal
 * state, and one worth being able to see rather than guess at.
 */
export const APP_VERSION = resolveVersion(import.meta.env.VITE_APP_VERSION);

/**
 * The release the API reports, or `null` if it did not answer.
 *
 * Never throws, and never on a signed-out session — `request()` treats a 401 as a
 * session event and signs the operator out, which would be an absurd consequence
 * of a version line. The only caller renders inside the signed-in shell.
 */
export async function fetchServerVersion(): Promise<string | null> {
  try {
    const body = await request<{ version: string }>('/version');
    return resolveVersion(body.version);
  } catch {
    return null;
  }
}

/** Whether the bundle in this tab and the release on the API disagree. */
export function isServerAhead(serverVersion: string | null): boolean {
  return isVersionMismatch(APP_VERSION, serverVersion);
}
