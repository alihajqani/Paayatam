/**
 * The thin typed wrapper over Telegram's WebApp SDK (ADR-0003).
 *
 * The SDK is loosely typed and its surface changes between client versions, so
 * every quirk is isolated here rather than scattered through components. Two
 * consequences that matter:
 *
 *  - Nothing in `src/views` touches `window.Telegram` directly.
 *  - The app runs in an ordinary browser tab with no Telegram at all, which is
 *    the only way it is developable. `isAvailable` says which world we are in.
 */

export interface ThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
  header_bg_color?: string;
  accent_text_color?: string;
  destructive_text_color?: string;
  section_bg_color?: string;
  subtitle_text_color?: string;
}

interface MainButton {
  setText(text: string): void;
  show(): void;
  hide(): void;
  enable(): void;
  disable(): void;
  showProgress(leaveActive?: boolean): void;
  hideProgress(): void;
  onClick(handler: () => void): void;
  offClick(handler: () => void): void;
}

interface BackButton {
  show(): void;
  hide(): void;
  onClick(handler: () => void): void;
  offClick(handler: () => void): void;
}

interface HapticFeedback {
  impactOccurred(style: 'light' | 'medium' | 'heavy'): void;
  notificationOccurred(type: 'error' | 'success' | 'warning'): void;
  selectionChanged(): void;
}

interface TelegramWebApp {
  initData: string;
  /**
   * The unsigned half of the launch payload.
   *
   * **Unsigned, and therefore only ever used for navigation.** `initData` is what
   * the server verifies; nothing here is evidence of anything. `start_param` is
   * the `?startapp=` value the notification button carried, and the worst a
   * forged one can do is open a screen the user could have tapped to anyway.
   */
  initDataUnsafe?: { start_param?: string };
  colorScheme: 'light' | 'dark';
  themeParams: ThemeParams;
  viewportStableHeight?: number;
  MainButton: MainButton;
  BackButton: BackButton;
  HapticFeedback: HapticFeedback;
  ready(): void;
  expand(): void;
  /**
   * Hands the user back to the chat they opened the Mini App from — which for this
   * product is the bot, and therefore where their conversations are. Closing is how
   * you navigate to the bot without knowing its username: Telegram gives a WebApp no
   * way to ask, and hardcoding one would be a second place to change it.
   */
  close(): void;
  /**
   * Opens a `t.me` link inside Telegram rather than in a browser tab.
   *
   * `close()` gets the user back to *whatever chat they opened the Mini App
   * from*, which is the bot when they launched it from the bot and the channel
   * when they tapped a post's button. Report 6's whole complaint is the second
   * case: "go back to the bot and find the conversation" is not something to ask
   * of somebody who arrived from a channel. This lands them in the bot chat
   * whichever door they came in by.
   *
   * Optional in the type because older WebApp builds do not have it — the caller
   * falls back to `close()`, which is right more often than it is wrong.
   */
  openTelegramLink?: (url: string) => void;
  disableVerticalSwipes?: () => void;
  onEvent(event: string, handler: () => void): void;
  showAlert(message: string): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export const webApp: TelegramWebApp | undefined = window.Telegram?.WebApp;
export const isAvailable = webApp !== undefined;

/**
 * Fallbacks used when the app is opened outside Telegram — a browser tab during
 * development, or a client too old to send `themeParams`. They are also what the
 * contrast guard below falls back *to*, so they must be a legible pair on their
 * own.
 */
const FALLBACK_THEME: Required<ThemeParams> = {
  bg_color: '#ffffff',
  text_color: '#000000',
  hint_color: '#707579',
  link_color: '#3390ec',
  button_color: '#3390ec',
  button_text_color: '#ffffff',
  secondary_bg_color: '#f4f4f5',
  header_bg_color: '#ffffff',
  accent_text_color: '#3390ec',
  destructive_text_color: '#e53935',
  section_bg_color: '#ffffff',
  subtitle_text_color: '#707579',
};

function relativeLuminance(hex: string): number | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match?.[1]) return null;

  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(match[1]!.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

/** WCAG contrast ratio, or null if either colour is not a plain hex triplet. */
export function contrastRatio(a: string, b: string): number | null {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  if (first === null || second === null) return null;

  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Maps `themeParams` onto CSS custom properties, once.
 *
 * Everything visual reads these variables, so the app follows the user's Telegram
 * theme — including custom themes we have never seen — with no dark-mode code of
 * our own (ADR-0003).
 *
 * That generosity has a limit the ADR calls out: a user's custom theme can pair
 * unreadable colours. When body text against the background falls below WCAG AA,
 * the two are replaced with a safe pair. The rest of the palette is left alone —
 * a garish accent is the user's choice; unreadable body text is a bug.
 */
export function applyTheme(params: ThemeParams = webApp?.themeParams ?? {}): void {
  const theme: Required<ThemeParams> = { ...FALLBACK_THEME, ...stripEmpty(params) };

  const ratio = contrastRatio(theme.bg_color, theme.text_color);
  if (ratio !== null && ratio < 4.5) {
    theme.bg_color = FALLBACK_THEME.bg_color;
    theme.text_color = FALLBACK_THEME.text_color;
    theme.hint_color = FALLBACK_THEME.hint_color;
  }

  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme)) {
    if (value) root.style.setProperty(`--tg-theme-${key.replaceAll('_', '-')}`, value);
  }
}

function stripEmpty(params: ThemeParams): ThemeParams {
  return Object.fromEntries(Object.entries(params).filter(([, value]) => Boolean(value)));
}

/**
 * Startup: announce readiness, take the full height, and stop a vertical drag
 * inside the app from being read as "close the Mini App".
 */
export function initTelegram(): void {
  applyTheme();
  if (!webApp) return;

  webApp.ready();
  webApp.expand();
  webApp.disableVerticalSwipes?.();
  webApp.onEvent('themeChanged', () => {
    applyTheme();
  });
}

/**
 * Take the user to the bot's chat, wherever they opened the app from (report 6).
 *
 * `openTelegramLink` when the client has it, `close()` otherwise. The fallback is
 * not a degradation for most users: somebody who launched the Mini App from the
 * bot is returned to the bot by closing it. It is only wrong for somebody who
 * arrived from a channel post, and that is exactly who the link form is for.
 *
 * An empty `botUsername` — a deployment that never configured one — closes
 * rather than opening `https://t.me/`, which is a link to nothing.
 */
/**
 * Where a `?startapp=` deep link wants to land, as a route path.
 *
 * ── What was broken ──────────────────────────────────────────────────────────
 *
 * Every «باز کردن برنامه» button in every notification has carried a payload
 * since M13 — `openAppButton` builds `https://t.me/<bot>?startapp=<target>` and
 * the templates pass `home`, `wallet`, `my-requests`, `reviews/pending`. Nothing
 * ever read it back. Telegram delivers it as `initDataUnsafe.start_param`, the
 * Mini App never looked, and so **every one of those buttons opened the splash**
 * and left the user to navigate to the thing the message was about. The review
 * reminder is the clearest loss: it names a pending review and then lands two
 * taps away from it.
 *
 * `openAppButton` encodes `/` as `_`, because Telegram restricts `startapp` to
 * `A-Za-z0-9_-`. This reverses that.
 *
 * ── Why an allowlist rather than a path ──────────────────────────────────────
 *
 * The payload is attacker-supplied — anyone can send anyone a `?startapp=`
 * link. Treating it as a route would let a stranger choose which screen someone
 * else's app opens on, including `/events/<id>/edit`. A fixed set of
 * destinations cannot name a resource, so the worst a forged link achieves is a
 * screen the user could have reached from the home page.
 */
export const DEEP_LINKS: Record<string, string> = {
  home: '/home',
  wallet: '/wallet',
  discover: '/discover',
  reviews: '/reviews',
  'reviews/pending': '/reviews',
  'my-requests': '/my-requests',
  'my-events': '/my-events',
  /**
   * `/profile/edit`, not `/profile`.
   *
   * `/profile` is the onboarding step and is in `ONBOARDING_PATHS`, so the router
   * sends a *finished* user straight back to `/home` — a deep link to it would
   * bounce for everybody who has completed onboarding, which is everybody who
   * could have tapped the button. `/profile/edit` is the product screen, declared
   * outside the funnel for exactly this reason.
   */
  'profile/edit': '/profile/edit',
};

export function deepLinkTarget(): string | null {
  const raw = webApp?.initDataUnsafe?.start_param;
  if (raw === undefined || raw === '') return null;

  return DEEP_LINKS[raw.replaceAll('_', '/')] ?? null;
}

export function openBotChat(botUsername: string): void {
  const url = botUsername === '' ? null : `https://t.me/${botUsername}`;
  if (url !== null && webApp?.openTelegramLink !== undefined) {
    webApp.openTelegramLink(url);
    return;
  }
  webApp?.close();
}

export function haptic(kind: 'success' | 'error' | 'selection'): void {
  if (!webApp) return;
  if (kind === 'selection') webApp.HapticFeedback.selectionChanged();
  else webApp.HapticFeedback.notificationOccurred(kind);
}
