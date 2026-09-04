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
  { command: 'menu', description: 'فهرست دستورها به‌صورت دکمه' },
  { command: 'help', description: 'راهنمای کار با ربات' },
  { command: 'create_event', description: 'ساختن فعالیت تازه' },
  { command: 'discover', description: 'فعالیت‌های نزدیک شما' },
  { command: 'balance', description: 'موجودی سکه‌های شما' },
  { command: 'wallet', description: 'کیف پول و تراکنش‌ها' },
  { command: 'referral', description: 'کد معرفی و پاداش‌ها' },
  { command: 'gift', description: 'استفاده از کد هدیه' },
  { command: 'requests', description: 'درخواست‌هایی که داده‌اید' },
  { command: 'myevents', description: 'رویدادهایی که ساخته‌اید' },
  { command: 'reviews', description: 'نظرهایی که هنوز ننوشته‌اید' },
  { command: 'myreviews', description: 'نظرهایی که درباره شما نوشته‌اند' },
  { command: 'profile', description: 'نمایه و امتیاز اعتماد شما' },
  { command: 'trust', description: 'امتیاز اعتماد و تغییرهای آن' },
  { command: 'edit_profile', description: 'ویرایش نمایه' },
  /**
   * The interests, on their own (v0.8.1).
   *
   * A command of its own rather than "it is step seven of `/edit_profile`",
   * because it is the one field of a profile somebody comes back to change. The
   * name, the birth year and the city are set once; what you feel like doing
   * moves, and walking six questions to reach it is how a field stops being
   * edited. `EDIT_PROFILE` still owns the step — this opens the same wizard with
   * the other six `when`'d out, so there is one definition of what an interest
   * is and one place it is validated.
   */
  { command: 'interests', description: 'علاقه‌مندی‌های شما' },
  { command: 'terms', description: 'قوانین و حریم خصوصی' },
  { command: 'settings', description: 'تنظیمات اعلان‌ها و حریم خصوصی' },
  /**
   * Last on purpose. It is the command somebody looks for when everything above
   * it has failed them, and a menu is read top-down by people who are getting on
   * fine — but it has to be *in* the menu, because a user who cannot find how to
   * report a problem reports it by leaving.
   */
  { command: 'bug', description: 'گزارش مشکل و فرستادن تصویر' },
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

// ─────────────────────────────────────────────────────────────────────────────
// The command menu, as a hierarchy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The commands, grouped by what somebody is trying to *do*.
 *
 * ── Why a hierarchy and not one flat keyboard ───────────────────────────────
 *
 * There are nineteen commands. Nineteen inline buttons is a wall that has to be
 * scrolled and read in full before any of it can be acted on, which is the same
 * problem `/help` already has and the reason a user who has not memorised the
 * list never finds the command they want. Five groups of three to five is one
 * decision followed by another, and each decision fits on a screen.
 *
 * ── Why the groups are these groups ─────────────────────────────────────────
 *
 * By the question being asked, not by the subsystem answering it. «فعالیت‌ها»
 * holds everything about activities whether the user is hosting or attending,
 * because somebody looking for «فعالیت‌های من» is not thinking about which side
 * of the marketplace they are on. `/requests` and `/myevents` are the two halves
 * of the same question and sit together for that reason.
 *
 * `/help` and `/bug` are their own group and last: they are what somebody
 * reaches for when the other four groups have failed them, and a menu is read
 * top-down by people who are getting on fine.
 *
 * Every command in `BOT_COMMANDS` appears in exactly one group, and
 * `commands.test.ts` asserts it — a command that is dispatchable, advertised to
 * Telegram and absent from the menu is a command only its author can find.
 */
export interface CommandGroup {
  /** The stable key that rides in `callback_data`. Short: sixty-four bytes total. */
  key: string;
  /** What the button says at the top level. */
  label: string;
  /** One line under the group's own screen, so a tap is not a guess. */
  hint: string;
  commands: readonly string[];
}

export const COMMAND_GROUPS: readonly CommandGroup[] = [
  {
    key: 'ev',
    label: '🎟 فعالیت‌ها',
    hint: 'ساختن، پیدا کردن و اداره کردن فعالیت‌ها',
    commands: ['create_event', 'discover', 'myevents', 'requests'],
  },
  {
    key: 'ms',
    label: '⭐️ نظرها',
    hint: 'نظرهایی که مانده است و نظرهایی که درباره شما نوشته‌اند',
    commands: ['reviews', 'myreviews'],
  },
  {
    key: 'ec',
    label: '💰 سکه و پاداش',
    hint: 'موجودی، تراکنش‌ها، معرفی دوستان و کد هدیه',
    commands: ['balance', 'wallet', 'referral', 'gift'],
  },
  {
    key: 'ac',
    label: '👤 حساب من',
    hint: 'نمایه، امتیاز اعتماد، تنظیمات و قوانین',
    commands: ['profile', 'trust', 'edit_profile', 'interests', 'settings', 'terms'],
  },
  {
    key: 'hp',
    label: '🆘 راهنما و پشتیبانی',
    hint: 'اگر جایی گیر کردید یا چیزی درست کار نکرد',
    commands: ['menu', 'help', 'bug'],
  },
] as const;

/** The description `BOT_COMMANDS` gives a command, for the menu's own buttons. */
export function describeCommand(command: string): string | null {
  return BOT_COMMANDS.find((entry) => entry.command === command)?.description ?? null;
}

/** One group by its `callback_data` key, or null for a key this build does not know. */
export function commandGroupFor(key: string): CommandGroup | null {
  return COMMAND_GROUPS.find((group) => group.key === key) ?? null;
}
