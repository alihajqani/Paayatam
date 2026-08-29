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

const BOT = 'paayatambot';

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
  answers: Record<string, WizardInput>,
): Promise<F> {
  console.log(`\n\n${'═'.repeat(72)}\n  ${label}\n${'═'.repeat(72)}`);

  let form: F = definition.empty();
  let step = firstStep(definition, form);

  while (step !== null) {
    const choices: Choice[] = step.load === undefined ? [] : await step.load(form, deps);
    const { position, total } = progressOf(definition, step.key, form);
    const earliest = tehranToday(NOW);

    const drawn = renderStep({
      prompt: step.prompt(form),
      ui: step.ui,
      stepKey: step.key,
      choices,
      page: 0,
      anchor: earliest,
      earliest,
      position,
      total,
      canGoBack: position > 1,
      optional: step.optional === true,
      cancellable: step.cancellable !== false,
    });
    screen(
      `${label} · step "${step.key}" (${String(position)}/${String(total)})`,
      drawn.text,
      drawn.keyboard,
    );

    const answer = answers[step.key];
    if (answer === undefined) {
      console.log(`\n    ⟶ no scripted answer for "${step.key}"; stopping this walk.`);
      return form;
    }
    console.log(`\n    ⟵ answering: ${JSON.stringify(answer)}`);

    const result = apply(step, answer, form);
    if (!result.ok) {
      console.log(`    ✗ REFUSED: ${result.error}`);
      return form;
    }
    // `Object.assign` rather than a spread: `F` is unconstrained here so the two
    // real forms fit without a cast at either call site, and TypeScript will not
    // spread an unconstrained generic.
    form = Object.assign({}, form, result.patch);
    step = nextStep(definition, step.key, form);
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
  });

  // ── 6. What the notification templates emit ──────────────────────────────
  console.log(
    `\n\n${'═'.repeat(72)}\n  TEMPLATES — as the worker will send them\n${'═'.repeat(72)}`,
  );
  for (const key of [
    TEMPLATES.BOT_CONSENT_ACCEPTED,
    TEMPLATES.BOT_EVENT_CREATED,
    TEMPLATES.BOT_HELP,
  ]) {
    const message = render(key, { title: 'کوهنوردی صبح جمعه — درکه' }, BOT);
    screen(`template ${key}`, message?.text ?? '(nothing)', message?.keyboard ?? []);
  }

  console.log(`\n${'─'.repeat(72)}\nWalkthrough complete.\n`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
