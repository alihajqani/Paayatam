import { escapeHtml } from './escape';
import { MAIN_MENU_LABEL, menuPathFor } from './keyboards';

/**
 * «📍 پایه‌تَم در شیراز باز شد!» — sent once, to everybody who named the city,
 * when an operator first opens it (plan 17).
 *
 * The promise it keeps was printed under every closed city's queue number —
 * «به‌محض باز شدن، همین‌جا خبرتان می‌کنیم» — for as long as those cities had
 * queues, and nothing sent it.
 *
 * A campaign body, so it is HTML and plain text only: no buttons (a broadcast
 * carries none), and a path named by the labels that are actually drawn rather
 * than a command somebody has to know. The city name is escaped because an
 * operator typed it.
 */
export function cityLaunchAnnouncement(cityNameFa: string): string {
  const city = escapeHtml(cityNameFa);
  const path = menuPathFor('discover') ?? 'رویدادها';
  return (
    `<b>📍 پایه‌تَم در ${city} باز شد!</b>\n\n` +
    `از امروز می‌توانید رویدادهای ${city} را ببینید، به آن‌ها بپیوندید ` +
    `یا خودتان رویدادی بسازید.\n\n` +
    `«${escapeHtml(MAIN_MENU_LABEL)}» ← «${escapeHtml(path)}»`
  );
}
