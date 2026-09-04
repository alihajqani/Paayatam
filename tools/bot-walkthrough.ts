import {
  apply,
  createEventWizard,
  editProfileWizard,
  firstStep,
  nextStep,
  progressOf,
  stepByKey,
  type CreateEventForm,
  type WizardDefinition,
  type WizardDeps,
  type WizardInput,
} from '@payetam/domain';
import {
  TEMPLATES,
  calendarKeyboard,
  isoDay,
  render,
  renderStep,
  renderSummary,
  tehranToday,
  type Choice,
  type InlineKeyboard,
} from '@payetam/telegram';

/**
 * Walk a wizard and print every screen exactly as Telegram would receive it.
 *
 *   pnpm bot-walkthrough
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The manual test the release process asks for is `make tunnel` + `make webhook`
 * and a human typing into Telegram. **That cannot be run against this checkout:**
 * the `TELEGRAM_BOT_TOKEN` in `.env` is the *production* bot — `set-webhook.sh
 * --info` reports its webhook registered at `app.paayatam.online` — so
 * `make webhook` would re-point the live bot at a local tunnel and deliver real
 * users' messages to a laptop. A failed `setWebhook` also deletes the previous
 * one, which would leave production deaf. Testing that way needs a **separate
 * bot from BotFather**, which is a human action.
 *
 * This is the substitute, and it is honest about what it covers: it drives the
 * real step machine with the real renderer and prints the exact `text` and
 * keyboard each screen produces. It verifies the Jalali calendar, the paging,
 * the summary, the Persian, and the progress line. It does **not** verify how
 * Telegram draws any of it, or that a thumb lands where it should.
 *
 * Nothing here touches a database or a network. It is safe to run anywhere.
 */

/** Fixed so a run is comparable to the last one. */
const NOW = new Date('2026-08-29T09:00:00.000Z');

/** Thirty real city names, so the pager is exercised the way Tehran province will. */
const CITY_NAMES = [
  'تهران',
  'شهریار',
  'اسلامشهر',
  'ملارد',
  'قدس',
  'پاکدشت',
  'ورامین',
  'ری',
  'دماوند',
  'فیروزکوه',
  'پردیس',
  'بومهن',
  'رودهن',
  'لواسان',
  'شمشک',
  'باقرشهر',
  'کهریزک',
  'چهاردانگه',
  'صباشهر',
  'وحیدیه',
  'اندیشه',
  'نصیرشهر',
  'گلستان',
  'حسن‌آباد',
  'قرچک',
  'جوادآباد',
  'آبسرد',
  'کیلان',
  'ارجمند',
  'شریف‌آباد',
];

function id(n: number): string {
  return `0199aa11-2b3c-7d4e-8f90-1a2b3c4d5e${String(n).padStart(2, '0')}`;
}

/** Enough of a catalog to walk the flow, shaped like the real one. */
const deps: WizardDeps = {
  categories: () =>
    Promise.resolve([
      { value: id(1), label: 'ورزش و طبیعت' },
      { value: id(2), label: 'کافه و بازی' },
      { value: `${id(3)}.L`, label: 'سایر' },
    ]),
  provinces: () =>
    Promise.resolve([
      { value: id(10), label: 'تهران' },
      { value: id(11), label: 'البرز' },
      { value: id(12), label: 'اصفهان' },
    ]),
  citiesOf: () =>
    Promise.resolve(
      // Thirty, so the pager appears — the real Tehran province has more.
      // Real ids and real-looking names, so the pager and the labels read as
      // they will in production.
      CITY_NAMES.map((label, i) => ({ value: id(20 + i), label })),
    ),
  districtsOf: () =>
    Promise.resolve([
      { value: id(200), label: 'منطقه ۱' },
      { value: id(201), label: 'منطقه ۲' },
    ]),
  // Enough to see the multi-select tick, page and count without a database.
  interests: () =>
    Promise.resolve([
      { value: id(60), label: 'کوه‌نوردی' },
      { value: id(61), label: 'بازی رومیزی' },
      { value: id(62), label: 'کافه‌گردی' },
      { value: id(63), label: 'دویدن' },
      { value: id(64), label: 'عکاسی' },
    ]),
};

function drawKeyboard(keyboard: InlineKeyboard): string {
  return keyboard.map((row) => '    [ ' + row.map((b) => b.text).join(' | ') + ' ]').join('\n');
}

function screen(title: string, text: string, keyboard: InlineKeyboard): void {
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`▸ ${title}`);
  console.log('─'.repeat(72));
  console.log(text);
  if (keyboard.length > 0) console.log(drawKeyboard(keyboard));
}

/**
 * Walk one wizard, answering each step from the script.
 *
 * Generic over the form so both wizards fit without a cast: `apply` and
 * `nextStep` are already generic, and the only thing this needs from `F` is that
 * it be an object it can spread a patch into.
 */
async function walk<F>(
  label: string,
  definition: WizardDefinition<F>,
  /**
   * One answer per step, or **several** for a multi-select.
   *
   * An array is how a `multi` step is scripted: each entry is a tap, the screen
   * is redrawn between them with the ticks updated, and the step is left the way
   * «تمام» leaves it. Modelling that here rather than answering once is the
   * difference between a walkthrough and a walkthrough that lies — the real
   * machine holds a `multi` step until `done`, and a driver that advanced on the
   * first tap would print a screen nobody will ever see.
   */
  answers: Record<string, WizardInput | WizardInput[]>,
  /**
   * What the caller seeds the draft with, as `ConversationService.start` does.
   *
   * `/interests` opens `EDIT_PROFILE` with `onlyInterests`, which `when`s the six
   * ordinary steps out — so without this the second walk below would open on the
   * display name and print a form nobody asked for.
   */
  initial: Partial<F> = {},
): Promise<F> {
  console.log(`\n\n${'═'.repeat(72)}\n  ${label}\n${'═'.repeat(72)}`);

  let form: F = Object.assign({}, definition.empty(), initial);
  let step = firstStep(definition, form);

  while (step !== null) {
    const current = step;
    const earliest = tehranToday(NOW);

    /** Draw the step as it stands right now — twice over, for a multi-select. */
    const draw = async (): Promise<void> => {
      const choices: Choice[] = current.load === undefined ? [] : await current.load(form, deps);
      const { position, total } = progressOf(definition, current.key, form);

      const drawn = renderStep({
        prompt: current.prompt(form),
        ui: current.ui,
        stepKey: current.key,
        choices,
        // What is already ticked, so the walkthrough shows the ✅ the user sees.
        ...(current.selectedOf !== undefined ? { selected: current.selectedOf(form) } : {}),
        page: 0,
        anchor: earliest,
        earliest,
        position,
        total,
        canGoBack: position > 1,
        optional: current.optional === true,
        cancellable: current.cancellable !== false,
      });
      screen(
        `${label} · step "${current.key}" (${String(position)}/${String(total)})`,
        drawn.text,
        drawn.keyboard,
      );
    };

    await draw();

    const scripted = answers[current.key];
    if (scripted === undefined) {
      console.log(`\n    ⟶ no scripted answer for "${current.key}"; stopping this walk.`);
      return form;
    }

    /**
     * A `multi` step takes every tap before it moves; every other kind takes one.
     *
     * The redraw between taps is the point: it is what shows the tick arriving
     * and the «تمام» counter going up, which is the whole of what this step looks
     * like and is exactly what a one-answer driver would hide.
     */
    const taps = Array.isArray(scripted) ? scripted : [scripted];
    for (const answer of taps) {
      console.log(`\n    ⟵ answering: ${JSON.stringify(answer)}`);

      const result = apply(current, answer, form);
      if (!result.ok) {
        console.log(`    ✗ REFUSED: ${result.error}`);
        return form;
      }
      // `Object.assign` rather than a spread: `F` is unconstrained here so the two
      // real forms fit without a cast at either call site, and TypeScript will not
      // spread an unconstrained generic.
      form = Object.assign({}, form, result.patch);

      if (current.ui === 'multi') await draw();
    }

    if (current.ui === 'multi') console.log('\n    ⟵ «تمام»');
    step = nextStep(definition, current.key, form);
  }
  return form;
}

async function main(): Promise<void> {
  const today = tehranToday(NOW);
  const day = isoDay(new Date(today.getTime() + 14 * 86_400_000));

  // ── 1. The consent gate ───────────────────────────────────────────────────
  console.log(
    `\n\n${'═'.repeat(72)}\n  CONSENT GATE — what a new user meets first\n${'═'.repeat(72)}`,
  );
  const gate = renderStep({
    prompt:
      'برای استفاده از پایه‌تم، لازم است قوانین و سیاست حریم خصوصی را بپذیرید.\n\n' +
      '• قوانین\n  نسخهٔ ۱ — شرایط استفاده از سرویس\n' +
      '• حریم خصوصی\n  نسخهٔ ۱ — چه داده‌هایی نگه داشته می‌شود',
    ui: 'confirm',
    stepKey: 'review',
    actions: [[{ text: '✅ می‌پذیرم', callbackData: 'wz:agree:' }]],
    position: 1,
    total: 1,
    canGoBack: false,
    optional: false,
    cancellable: false,
  });
  screen('consent · step "review"', gate.text, gate.keyboard);

  // ── 2. The calendar on its own, both months ──────────────────────────────
  console.log(
    `\n\n${'═'.repeat(72)}\n  JALALI CALENDAR — this month, and the next\n${'═'.repeat(72)}`,
  );
  screen('calendar · current month', '', calendarKeyboard('day', today, today));
  const nextMonth = new Date(today.getTime() + 32 * 86_400_000);
  screen('calendar · next month', '', calendarKeyboard('day', nextMonth, today));

  // ── 3. The create flow, fast path ────────────────────────────────────────
  const form = await walk<CreateEventForm>('CREATE EVENT (fast path)', createEventWizard, {
    title: { kind: 'text', value: 'کوهنوردی صبح جمعه — درکه' },
    desc: { kind: 'text', value: 'از دربند تا شیرپلا، صبح زود راه می‌افتیم. کفش مناسب بیاورید.' },
    cat: { kind: 'callback', action: 'cat', value: id(1) },
    prov: { kind: 'callback', action: 'prov', value: id(10) },
    city: { kind: 'callback', action: 'city', value: id(20) },
    dist: { kind: 'callback', action: 'skip', value: '' },
    day: { kind: 'callback', action: 'day', value: day },
    hour: { kind: 'callback', action: 'hour', value: '8' },
    dur: { kind: 'callback', action: 'dur', value: '4' },
    cap: { kind: 'callback', action: 'cap', value: '6' },
    cost: { kind: 'callback', action: 'cost', value: 'FREE' },
  });

  /**
   * The field list `BotService.summaryLines` builds, mirrored here.
   *
   * Mirrored rather than called: that method needs the catalog and a Nest
   * container, and this tool deliberately touches neither. If the two drift, the
   * integration test is what catches it — this is here so the transcript shows
   * what a host actually reviews.
   */
  const summary = renderSummary(
    [
      { label: 'نام', value: form.title ?? '' },
      { label: 'دسته', value: 'ورزش و طبیعت' },
      { label: 'مکان', value: `${CITY_NAMES[0] ?? ''} — منطقه ۱` },
      { label: 'زمان', value: '۲۲ شهریور ۱۴۰۵ — ساعت ۰۸:۰۰' },
      { label: 'مدت', value: '۴ ساعت' },
      { label: 'ظرفیت', value: '۶ نفر' },
      { label: 'هزینه', value: 'رایگان' },
      {
        label: 'توضیح',
        value: typeof form.description === 'string' ? form.description : '',
      },
    ],
    true,
  );
  screen('create event · summary', summary.text, summary.keyboard);

  // ── 4. A refusal, rendered in place ──────────────────────────────────────
  console.log(
    `\n\n${'═'.repeat(72)}\n  A REFUSAL — shown above the question, in the same message\n${'═'.repeat(72)}`,
  );
  const titleStep = stepByKey(createEventWizard, 'title');
  const refusal = apply(titleStep!, { kind: 'text', value: 'ab' }, {});
  const refused = renderStep({
    prompt: titleStep!.prompt({}),
    ui: 'text',
    stepKey: 'title',
    ...(refusal.ok ? {} : { error: refusal.error }),
    position: 1,
    total: 11,
    canGoBack: false,
    optional: false,
  });
  screen(
    'create event · step "title" after a two-character answer',
    refused.text,
    refused.keyboard,
  );

  // ── 5. Edit profile ──────────────────────────────────────────────────────
  await walk('EDIT PROFILE', editProfileWizard, {
    name: { kind: 'text', value: 'علی' },
    gender: { kind: 'callback', action: 'gender', value: 'MALE' },
    birth: { kind: 'text', value: '۱۳۷۰' },
    prov: { kind: 'callback', action: 'prov', value: id(10) },
    city: { kind: 'callback', action: 'city', value: id(20) },
    bio: { kind: 'text', value: 'کوهنورد و کتاب‌خوان.' },
    // Two taps and then a third that removes the first, so the walkthrough shows
    // the tick arriving, the counter moving, and the same button undoing itself.
    tags: [
      { kind: 'callback', action: 'tags', value: id(60) },
      { kind: 'callback', action: 'tags', value: id(61) },
      { kind: 'callback', action: 'tags', value: id(60) },
    ],
  });

  // ── 5b. The interests on their own, the way `/interests` opens them ──────
  await walk(
    'INTERESTS (the /interests form)',
    editProfileWizard,
    { tags: [{ kind: 'callback', action: 'tags', value: id(62) }] },
    // Seeded exactly as `startProfileWizard` seeds it: the flag that hides the
    // other six steps, and the interests the profile already claims — so the
    // keyboard opens with them ticked rather than blank.
    { onlyInterests: true, interestIds: [id(60)] },
  );

  // ── 6. What the notification templates emit ──────────────────────────────
  console.log(
    `\n\n${'═'.repeat(72)}\n  TEMPLATES — as the worker will send them\n${'═'.repeat(72)}`,
  );
  for (const key of [
    TEMPLATES.BOT_CONSENT_ACCEPTED,
    TEMPLATES.BOT_EVENT_CREATED,
    TEMPLATES.BOT_HELP,
  ]) {
    const message = render(key, { title: 'کوهنوردی صبح جمعه — درکه' });
    screen(`template ${key}`, message?.text ?? '(nothing)', message?.keyboard ?? []);
  }

  console.log(`\n${'─'.repeat(72)}\nWalkthrough complete.\n`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
