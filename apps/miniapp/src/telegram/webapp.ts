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
  colorScheme: 'light' | 'dark';
  themeParams: ThemeParams;
  viewportStableHeight?: number;
  MainButton: MainButton;
  BackButton: BackButton;
  HapticFeedback: HapticFeedback;
  ready(): void;
  expand(): void;
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

export function haptic(kind: 'success' | 'error' | 'selection'): void {
  if (!webApp) return;
  if (kind === 'selection') webApp.HapticFeedback.selectionChanged();
  else webApp.HapticFeedback.notificationOccurred(kind);
}
