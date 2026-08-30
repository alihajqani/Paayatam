/**
 * Every command the bot answers, in the order a new user should meet them.
 *
 * ── Why this list exists ─────────────────────────────────────────────────────
 *
 * It was three lists. The `switch` in `BotService.onCommand` decided what a
 * command *did*, the `BOT_HELP` template said what commands *were*, and Telegram
 * itself knew of none of them — `setMyCommands` was never called, so the "/"
 * autocomplete and the blue Menu button were empty and every command was
 * invisible unless you had already read `/help`, which was itself only findable
 * by guessing. A command nobody can discover is a command nobody uses.
 *
 * Now it is one list: `BOT_HELP` renders from it, `tools/set-bot-commands.ts`
 * registers it with Telegram, and adding an entry updates the menu, the help and
 * the documentation together. The `switch` stays the authority on behaviour —
 * a list cannot dispatch — but `commands.test.ts` asserts the two agree, so a
 * command advertised in the menu cannot answer «این فرمان را نمی‌شناسم».
 *
 * ── The constraints Telegram imposes ─────────────────────────────────────────
 *
 * `command` must be 1–32 characters of lowercase latin, digits and underscore;
 * `description` 3–256 characters. Both are checked by `commands.test.ts` rather
 * than trusted, because the failure mode is a `setMyCommands` that rejects the
 * whole array — so one bad entry publishes none of them.
 *
 * `/start` is deliberately **not** here. Telegram gives every bot a Start button
 * of its own, and listing it again spends the first line of a short menu on the
 * one action the client already offers.
 */
export interface BotCommand {
  /** Without the slash, as `setMyCommands` wants it. */
  command: string;
  /** Persian, imperative-free, and short enough to read in the menu. */
  description: string;
}

export const BOT_COMMANDS: readonly BotCommand[] = [
  { command: 'help', description: 'راهنمای کار با ربات' },
  { command: 'create_event', description: 'ساختن فعالیت تازه' },
  { command: 'discover', description: 'فعالیت‌های نزدیک شما' },
  { command: 'balance', description: 'موجودی سکه‌های شما' },
  { command: 'wallet', description: 'کیف پول و تراکنش‌ها' },
  { command: 'referral', description: 'کد معرفی و پاداش‌ها' },
  { command: 'gift', description: 'استفاده از کد هدیه' },
  { command: 'requests', description: 'درخواست‌هایی که داده‌اید' },
  { command: 'myevents', description: 'رویدادهایی که ساخته‌اید' },
  { command: 'chats', description: 'گفتگوهای باز شما' },
  { command: 'reviews', description: 'نظرهایی که هنوز ننوشته‌اید' },
  { command: 'myreviews', description: 'نظرهایی که درباره شما نوشته‌اند' },
  { command: 'profile', description: 'نمایه و امتیاز اعتماد شما' },
  { command: 'trust', description: 'امتیاز اعتماد و تغییرهای آن' },
  { command: 'edit_event', description: 'ویرایش فعالیت' },
  { command: 'edit_profile', description: 'ویرایش نمایه' },
  { command: 'terms', description: 'قوانین و حریم خصوصی' },
  { command: 'settings', description: 'تنظیمات اعلان‌ها و حریم خصوصی' },
] as const;

/**
 * The command list as `/help` prints it.
 *
 * Rendered rather than written out, so the help text cannot fall behind the menu
 * — which is the drift that made this module worth having.
 */
export function helpCommandLines(): string {
  return BOT_COMMANDS.map((c) => `<b>/${c.command}</b> — ${c.description}`).join('\n');
}
