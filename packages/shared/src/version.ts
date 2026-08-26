/**
 * The release string, and what to do when it is not one (M22 phase 10).
 *
 * Three places want to say which build they are: the API answers `GET
 * /api/v1/version`, and each of the two bundles renders what it was compiled
 * with. All three get the value from the environment — `PAYETAM_VERSION` on the
 * server, `VITE_APP_VERSION` baked into the bundle at build time — and the
 * environment is exactly where a release tag goes missing: an unset variable, an
 * empty string a shell expanded to nothing, a `${PAYETAM_VERSION}` that Compose
 * never substituted.
 *
 * So this is the one function that decides what a version *is*, and every surface
 * calls it rather than trusting what it was handed. Two reasons for that beyond
 * tidiness:
 *
 *  - **It is rendered, and it is returned to anyone.** `/api/v1/version` is
 *    public. A release string is a tag; anything that is not shaped like a tag is
 *    a misconfiguration, and `local` is the honest answer to "which release is
 *    this" when nobody said.
 *  - **A support conversation depends on it.** "What does the bottom of your
 *    screen say" only works if the answer is either a real tag or an obviously
 *    fake one. A blank, a `${…}` or a stray path is the answer that wastes the
 *    next twenty minutes.
 */

/** What an unset, empty or malformed version resolves to — the compose default. */
export const UNKNOWN_VERSION = 'local';

/**
 * Long enough for `v0.3.0-rc.1+build.42` and a 40-character commit sha, short
 * enough that nothing else fits.
 */
const MAX_LENGTH = 48;

/**
 * A tag: alphanumeric to start, then the punctuation semver and git tags use.
 *
 * Deliberately no slash, no whitespace, no `$`, no `{`. Those are the characters
 * that appear when a variable was not substituted or a path leaked in.
 */
const TAG = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** The release string this build is, or `local` when nothing usable was set. */
export function resolveVersion(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return UNKNOWN_VERSION;

  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LENGTH) return UNKNOWN_VERSION;

  return TAG.test(trimmed) ? trimmed : UNKNOWN_VERSION;
}

/**
 * Whether the bundle in the browser and the release on the server disagree.
 *
 * They can, and the case is not exotic: a Telegram WebView caches a bundle hard,
 * so the screen in front of a user after a deploy is routinely the previous
 * release talking to the current API. Worth a quiet line telling them to reopen
 * the app; not worth a modal, and never worth blocking on.
 *
 * `local` on either side is not a disagreement — it means one of them did not
 * know, which is the normal state in development and says nothing about the other.
 */
export function isVersionMismatch(bundle: string, server: string | null | undefined): boolean {
  if (!server) return false;
  if (bundle === UNKNOWN_VERSION || server === UNKNOWN_VERSION) return false;
  return bundle !== server;
}
