/**
 * The founding-team events (plan §9 M17: *"20–30 founding-team events"*).
 *
 * A marketplace with no supply is a marketplace nobody comes back to. The first
 * person who opens the Mini App has to find something worth joining, and nothing in
 * the product creates that — so it is seeded, by the founding team, as their own
 * events.
 *
 * **The hosts are real accounts, and in production the script refuses to invent
 * them.** `FOUNDING_TEAM_TELEGRAM_IDS` supplies the Telegram ids of people who have
 * actually started the bot. That is not ceremony: a seeded event with a fabricated
 * host is an event whose join requests nobody can accept, and the first real user's
 * first action on the platform would go unanswered for twenty-four hours and then
 * expire. Every one of these events must have somebody who can say yes.
 *
 * In development the script does invent hosts, because there is nobody to be real.
 *
 * **These bypass the per-host quota** (§11: 5/day, 3 concurrent active), which is
 * deliberate and is the one product rule this script breaks. The quota is an
 * anti-spam control aimed at user-submitted content; a founding team of four cannot
 * hold twenty-five concurrent events between them, and the alternative — inventing
 * ten hosts to satisfy an arithmetic constraint — would put us back to events nobody
 * can accept. Written directly for the same reason moderation is not re-run over
 * them: this text is authored, reviewed and committed to a repository, not submitted.
 *
 * Idempotent by title per host: re-running updates the row rather than creating a
 * second copy, so a partially failed run is fixed by running it again.
 */
import { normalize } from '@payetam/domain';
import type { PrismaClient } from '@payetam/db';
import { openSeed } from './seed-guard';

/**
 * One founding host, as a placeholder identity for development.
 *
 * Display names only — no bios worth inventing, and a seeded bio is a seeded bio
 * whichever way it reads. In production these are matched to
 * `FOUNDING_TEAM_TELEGRAM_IDS` in order.
 */
const FOUNDING_HOSTS = [
  { displayName: 'تیم پایه‌تَم', district: 'district-6' },
  { displayName: 'نگار', district: 'district-3' },
  { displayName: 'سهیل', district: 'district-2' },
  { displayName: 'مریم', district: 'district-7' },
];

interface SeedEvent {
  host: number;
  title: string;
  description: string;
  category: 'cafe-boardgames' | 'outdoor';
  district: string;
  /** Days from now; the hour is set below. */
  inDays: number;
  startHour: number;
  durationHours: number;
  capacity: number;
  costType: 'FREE' | 'SPLIT' | 'FIXED';
  costAmount?: number;
  costNote?: string;
  rules?: string;
  /** Absent means anyone; the schema has no `ANY` member, null is how it is said. */
  genderPreference?: 'FEMALE_ONLY' | 'MALE_ONLY';
  minAge?: number;
  maxAge?: number;
}

/**
 * Twenty-five events across the two categories launch enables.
 *
 * Spread deliberately rather than uniformly: the first week is dense because a new
 * user needs something to join *this week*, and the tail exists so discovery's
 * time-proximity weighting has something to sort. Capacities are small — four to
 * eight — because that is what the product is for, and because a full event
 * exercising the waitlist within days of launch is a better demonstration than an
 * empty one for twenty.
 *
 * A handful are `FEMALE_ONLY`, which is a real need in this market rather than a
 * feature demo, and two carry age ranges so those filters are exercised by real rows
 * before a user meets them.
 */
const EVENTS: SeedEvent[] = [
  {
    host: 0,
    title: 'شب بازی رومیزی در کافه',
    description:
      'یک دورهمی دوستانه برای بازی‌های رومیزی. اگر تازه‌کار هستید هم نگران نباشید، قواعد را با هم مرور می‌کنیم. بازی‌ها را خودمان می‌آوریم.',
    category: 'cafe-boardgames',
    district: 'district-6',
    inDays: 2,
    startHour: 18,
    durationHours: 3,
    capacity: 6,
    costType: 'SPLIT',
    costNote: 'هزینهٔ سفارش هر نفر با خودش',
  },
  {
    host: 1,
    title: 'صبحانه و شطرنج',
    description:
      'یک صبح آرام با صبحانه و چند دست شطرنج. سطح بازی مهم نیست؛ هدف گپ زدن و آشنایی است.',
    category: 'cafe-boardgames',
    district: 'district-3',
    inDays: 3,
    startHour: 9,
    durationHours: 2,
    capacity: 4,
    costType: 'SPLIT',
    costNote: 'صبحانه به‌صورت دنگی حساب می‌شود',
  },
  {
    host: 2,
    title: 'پیاده‌روی صبحگاهی در پارک ملت',
    description:
      'یک پیاده‌روی سبک حدود یک ساعت و نیم، بعد هم یک قهوه. کفش راحت بیاورید. سرعت گروه با کندترین نفر تنظیم می‌شود.',
    category: 'outdoor',
    district: 'district-3',
    inDays: 1,
    startHour: 7,
    durationHours: 2,
    capacity: 8,
    costType: 'FREE',
  },
  {
    host: 3,
    title: 'کوه‌پیمایی دربند تا شیرپلا',
    description:
      'مسیر شناخته‌شده و نه‌چندان سخت، اما به آمادگی متوسط نیاز دارد. آب و خوراکی سبک همراه داشته باشید. اگر هوا بد باشد لغو می‌کنیم و اطلاع می‌دهیم.',
    category: 'outdoor',
    district: 'district-1',
    inDays: 5,
    startHour: 6,
    durationHours: 6,
    capacity: 8,
    costType: 'FREE',
    rules: 'تجربهٔ حداقل یک مسیر کوهستانی لازم است.',
  },
  {
    host: 1,
    title: 'شب بازی مافیا',
    description:
      'مافیا با گروه کوچک و راوی باتجربه. اگر بار اولتان است، نقش‌ها را قبل از شروع توضیح می‌دهیم.',
    category: 'cafe-boardgames',
    district: 'district-2',
    inDays: 4,
    startHour: 20,
    durationHours: 3,
    capacity: 8,
    costType: 'FIXED',
    costAmount: 150_000,
    costNote: 'شامل ورودی کافه و یک نوشیدنی',
  },
  {
    host: 0,
    title: 'دورهمی بازی کارتی برای بانوان',
    description: 'یک بعدازظهر آرام با بازی‌های کارتی، مخصوص بانوان. فضای کافه دنج و کم‌صدا است.',
    category: 'cafe-boardgames',
    district: 'district-6',
    inDays: 6,
    startHour: 16,
    durationHours: 3,
    capacity: 6,
    costType: 'SPLIT',
    genderPreference: 'FEMALE_ONLY',
  },
  {
    host: 2,
    title: 'دوچرخه‌سواری دور بوستان چیتگر',
    description:
      'یک دور کامل بوستان با سرعت ملایم. دوچرخه را خودتان بیاورید یا در محل کرایه کنید. کلاه ایمنی الزامی است.',
    category: 'outdoor',
    district: 'district-22',
    inDays: 7,
    startHour: 8,
    durationHours: 3,
    capacity: 6,
    costType: 'FREE',
    rules: 'کلاه ایمنی الزامی است.',
  },
  {
    host: 3,
    title: 'قهوه و گفتگو دربارهٔ کتاب',
    description:
      'هر کس یک کتابی که این ماه خوانده می‌آورد و ده دقیقه دربارهٔ آن حرف می‌زند. نه نقد ادبی، فقط پیشنهاد دادن به هم.',
    category: 'cafe-boardgames',
    district: 'district-7',
    inDays: 8,
    startHour: 17,
    durationHours: 2,
    capacity: 6,
    costType: 'SPLIT',
  },
  {
    host: 0,
    title: 'عکاسی عصرگاهی در باغ کتاب',
    description:
      'یک قدم‌زدن دو ساعته با دوربین یا گوشی. کسی به کسی درس نمی‌دهد، فقط با هم عکس می‌گیریم و آخرش نشان هم می‌دهیم.',
    category: 'outdoor',
    district: 'district-3',
    inDays: 9,
    startHour: 16,
    durationHours: 2,
    capacity: 8,
    costType: 'FREE',
  },
  {
    host: 1,
    title: 'شب بازی‌های استراتژیک',
    description:
      'بازی‌های سنگین‌تر و طولانی‌تر برای کسانی که حوصلهٔ یاد گرفتن قواعد را دارند. یک بازی، کل شب.',
    category: 'cafe-boardgames',
    district: 'district-2',
    inDays: 10,
    startHour: 18,
    durationHours: 4,
    capacity: 4,
    costType: 'SPLIT',
    rules: 'لطفاً سر وقت بیایید؛ بازی بعد از شروع قابل اضافه شدن نیست.',
  },
  {
    host: 2,
    title: 'پیاده‌روی شهری در بازار تهران',
    description:
      'یک مسیر پیاده در بازار و سرای‌های قدیمی، حدود سه ساعت با ایستگاه‌های کوتاه. پیاده‌روی زیاد دارد.',
    category: 'outdoor',
    district: 'district-1',
    inDays: 11,
    startHour: 10,
    durationHours: 3,
    capacity: 8,
    costType: 'FREE',
  },
  {
    host: 3,
    title: 'صبحانه و بازی رومیزی سبک',
    description: 'بازی‌های کوتاه و ساده، مناسب کسی که تا حالا بازی رومیزی نکرده. صبح جمعه.',
    category: 'cafe-boardgames',
    district: 'district-7',
    inDays: 12,
    startHour: 9,
    durationHours: 2,
    capacity: 6,
    costType: 'SPLIT',
  },
  {
    host: 0,
    title: 'کوه‌پیمایی سبک توچال، ایستگاه یک تا سه',
    description:
      'مسیر ملایم و مناسب کسی که تازه شروع کرده. سرعت گروه پایین است و ایستگاه استراحت زیاد دارد.',
    category: 'outdoor',
    district: 'district-1',
    inDays: 13,
    startHour: 7,
    durationHours: 4,
    capacity: 8,
    costType: 'FREE',
  },
  {
    host: 1,
    title: 'شب بازی برای آقایان',
    description: 'دورهمی بازی رومیزی، مخصوص آقایان. فضای کافه شلوغ‌تر و پرانرژی‌تر است.',
    category: 'cafe-boardgames',
    district: 'district-2',
    inDays: 14,
    startHour: 19,
    durationHours: 3,
    capacity: 6,
    costType: 'SPLIT',
    genderPreference: 'MALE_ONLY',
  },
  {
    host: 2,
    title: 'دویدن گروهی در پارک نیاوران',
    description:
      'پنج کیلومتر با سرعت گفتگو — یعنی آن‌قدر آرام که بتوانید حرف بزنید. بعدش صبحانه اختیاری.',
    category: 'outdoor',
    district: 'district-1',
    inDays: 15,
    startHour: 7,
    durationHours: 2,
    capacity: 8,
    costType: 'FREE',
  },
  {
    host: 3,
    title: 'کافه‌گردی و بازی دو نفره',
    description: 'بازی‌های دو نفره، چرخشی. هر نیم ساعت حریف عوض می‌شود، پس با همه بازی می‌کنید.',
    category: 'cafe-boardgames',
    district: 'district-6',
    inDays: 16,
    startHour: 17,
    durationHours: 3,
    capacity: 8,
    costType: 'SPLIT',
  },
  {
    host: 0,
    title: 'پیاده‌روی و عکاسی در پارک آب و آتش',
    description: 'غروب، پل طبیعت و کمی عکاسی. مسیر کوتاه است و برای همه مناسب.',
    category: 'outdoor',
    district: 'district-3',
    inDays: 17,
    startHour: 17,
    durationHours: 2,
    capacity: 8,
    costType: 'FREE',
  },
  {
    host: 1,
    title: 'شب معما و بازی حدس',
    description: 'بازی‌های حدس و معما، تیمی. سریع، پرسروصدا و مناسب آشنا شدن.',
    category: 'cafe-boardgames',
    district: 'district-2',
    inDays: 18,
    startHour: 19,
    durationHours: 2,
    capacity: 8,
    costType: 'FIXED',
    costAmount: 120_000,
    costNote: 'ورودی کافه',
  },
  {
    host: 2,
    title: 'کوه‌پیمایی کلکچال',
    description:
      'مسیر متوسط با شیب یکنواخت. آمادگی جسمانی متوسط لازم است و کل مسیر حدود پنج ساعت طول می‌کشد.',
    category: 'outdoor',
    district: 'district-1',
    inDays: 19,
    startHour: 6,
    durationHours: 5,
    capacity: 6,
    costType: 'FREE',
    rules: 'کفش کوه الزامی است.',
  },
  {
    host: 3,
    title: 'دورهمی بازی رومیزی برای بانوان',
    description: 'گروه کوچک، بازی‌های متوسط، فضای آرام. مخصوص بانوان.',
    category: 'cafe-boardgames',
    district: 'district-7',
    inDays: 20,
    startHour: 16,
    durationHours: 3,
    capacity: 6,
    costType: 'SPLIT',
    genderPreference: 'FEMALE_ONLY',
  },
  {
    host: 0,
    title: 'پیاده‌روی در دارآباد',
    description: 'مسیر سبک کنار رودخانه، حدود دو ساعت. مناسب کسی که تجربهٔ کوه ندارد.',
    category: 'outdoor',
    district: 'district-1',
    inDays: 21,
    startHour: 8,
    durationHours: 3,
    capacity: 8,
    costType: 'FREE',
  },
  {
    host: 1,
    title: 'شب بازی رومیزی برای جوان‌ترها',
    description: 'دورهمی بازی رومیزی با گروه هم‌سن. بازی‌ها سریع و سبک هستند.',
    category: 'cafe-boardgames',
    district: 'district-6',
    inDays: 22,
    startHour: 18,
    durationHours: 3,
    capacity: 8,
    costType: 'SPLIT',
    minAge: 18,
    maxAge: 27,
  },
  {
    host: 2,
    title: 'قهوهٔ عصر و گفتگوی آزاد',
    description:
      'بدون برنامه و بدون بازی. فقط چند نفر، یک میز و گفتگو. اگر دنبال آشنایی آرام هستید، همین است.',
    category: 'cafe-boardgames',
    district: 'district-2',
    inDays: 23,
    startHour: 17,
    durationHours: 2,
    capacity: 5,
    costType: 'SPLIT',
  },
  {
    host: 3,
    title: 'دوچرخه‌سواری صبحگاهی در پارک ولایت',
    description: 'یک ساعت و نیم دوچرخه با سرعت ملایم، بعد صبحانه. دوچرخه با خودتان.',
    category: 'outdoor',
    district: 'district-22',
    inDays: 24,
    startHour: 7,
    durationHours: 2,
    capacity: 6,
    costType: 'FREE',
  },
  {
    host: 0,
    title: 'شب بازی رومیزی، دورهٔ باتجربه‌ها',
    description:
      'برای کسانی که چند بار بازی رومیزی کرده‌اند. بازی سنگین است و توضیح قواعد طول می‌کشد.',
    category: 'cafe-boardgames',
    district: 'district-6',
    inDays: 26,
    startHour: 18,
    durationHours: 4,
    capacity: 5,
    costType: 'SPLIT',
    minAge: 25,
  },
];

async function main(): Promise<void> {
  const { prisma, finish } = await openSeed(
    'seed.events',
    `This creates ${String(EVENTS.length)} published events hosted by the founding team.`,
  );

  const hostUserIds = await resolveHosts(prisma);
  const cityId = await activeTehranId(prisma);
  const categoryIdBySlug = await categoryIds(prisma);
  const districtIdBySlug = await districtIds(prisma, cityId);

  const now = new Date();
  let created = 0;
  let updated = 0;

  for (const seed of EVENTS) {
    const hostUserId = hostUserIds[seed.host];
    const categoryId = categoryIdBySlug.get(seed.category);
    if (hostUserId === undefined || categoryId === undefined) {
      throw new Error(`event "${seed.title}" references a host or category that does not exist`);
    }

    const startsAt = at(now, seed.inDays, seed.startHour);
    const data = {
      hostUserId,
      title: seed.title,
      description: seed.description,
      // The same normalizer the API uses (ADR-0012), so a seeded event is findable by
      // the same ي/ك and half-space variants a hosted one is. Writing the row without
      // it would produce events that exist and cannot be searched.
      titleNormalized: normalize(seed.title),
      descriptionNormalized: normalize(seed.description),
      categoryId,
      cityId,
      districtId: districtIdBySlug.get(seed.district) ?? null,
      startsAt,
      endsAt: new Date(startsAt.getTime() + seed.durationHours * 3_600_000),
      capacity: seed.capacity,
      costType: seed.costType,
      costAmount: seed.costAmount ?? null,
      costNote: seed.costNote ?? null,
      rules: seed.rules ?? null,
      genderPreference: seed.genderPreference ?? null,
      minAge: seed.minAge ?? null,
      maxAge: seed.maxAge ?? null,
      status: 'PUBLISHED' as const,
      // APPROVED without re-running auto-moderation: this text was authored, reviewed
      // and committed, which is a stronger check than a blacklist pass.
      moderationStatus: 'APPROVED' as const,
      publishedAt: now,
    };

    const existing = await prisma.event.findFirst({
      where: { hostUserId, title: seed.title },
      select: { id: true },
    });

    if (existing) {
      await prisma.event.update({ where: { id: existing.id }, data });
      updated += 1;
    } else {
      await prisma.event.create({ data });
      created += 1;
    }
  }

  console.log(
    `${String(created)} events created, ${String(updated)} updated ` +
      `across ${String(hostUserIds.length)} founding hosts`,
  );

  await finish({ eventsCreated: created, eventsUpdated: updated, hosts: hostUserIds.length });
}

/**
 * The founding hosts.
 *
 * In production, `FOUNDING_TEAM_TELEGRAM_IDS` must name accounts that have already
 * started the bot — the script looks them up and refuses if any is missing, rather
 * than creating a user row for a Telegram id that has never sent a message. A
 * fabricated host cannot accept a join request, and the first real user's first
 * action would expire unanswered.
 *
 * In development it creates placeholders, because there is nobody to be real.
 */
async function resolveHosts(prisma: PrismaClient): Promise<string[]> {
  const configured = (process.env['FOUNDING_TEAM_TELEGRAM_IDS'] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  if (process.env['NODE_ENV'] === 'production' && configured.length === 0) {
    console.error(
      'FOUNDING_TEAM_TELEGRAM_IDS is not set.\n' +
        'Founding-team events must be hosted by real accounts that have started the bot —\n' +
        'an event whose host does not exist is an event nobody can accept a request for.',
    );
    process.exit(1);
  }

  if (configured.length > 0) return linkExistingHosts(prisma, configured);

  const cityId = await activeTehranId(prisma);
  const districtIdBySlug = await districtIds(prisma, cityId);
  const hostUserIds: string[] = [];

  for (const [index, host] of FOUNDING_HOSTS.entries()) {
    // A high, fixed range so a placeholder can never collide with a real Telegram id
    // in a database that has both.
    const telegramUserId = BigInt(900_000_000_000 + index);
    const existing = await prisma.telegramAccount.findUnique({
      where: { telegramUserId },
      select: { userId: true },
    });

    if (existing) {
      hostUserIds.push(existing.userId);
      continue;
    }

    const user = await prisma.user.create({
      data: {
        onboardingState: 'PROFILE_COMPLETE',
        telegramAccount: { create: { telegramUserId } },
        profile: {
          create: {
            displayName: host.displayName,
            cityId,
            districtId: districtIdBySlug.get(host.district) ?? null,
            birthYear: 1992,
            completedAt: new Date(),
          },
        },
      },
      select: { id: true },
    });
    hostUserIds.push(user.id);
  }

  console.log(`${String(hostUserIds.length)} placeholder founding hosts (development only)`);
  return hostUserIds;
}

/** Look up real accounts by Telegram id, refusing any that has not onboarded. */
async function linkExistingHosts(prisma: PrismaClient, ids: string[]): Promise<string[]> {
  const hostUserIds: string[] = [];

  for (const raw of ids) {
    let telegramUserId: bigint;
    try {
      telegramUserId = BigInt(raw);
    } catch {
      console.error(`FOUNDING_TEAM_TELEGRAM_IDS contains "${raw}", which is not a number.`);
      process.exit(1);
    }

    const account = await prisma.telegramAccount.findUnique({
      where: { telegramUserId },
      select: { userId: true, user: { select: { onboardingState: true } } },
    });

    if (!account) {
      console.error(
        `No account for Telegram id in FOUNDING_TEAM_TELEGRAM_IDS.\n` +
          'That person has to start the bot and complete their profile first.',
      );
      process.exit(1);
    }
    if (account.user.onboardingState !== 'PROFILE_COMPLETE') {
      console.error(
        'A founding host has not completed their profile.\n' +
          'An incomplete host cannot be shown on an event card.',
      );
      process.exit(1);
    }
    hostUserIds.push(account.userId);
  }

  console.log(`${String(hostUserIds.length)} founding hosts resolved from Telegram ids`);
  return hostUserIds;
}

async function activeTehranId(prisma: PrismaClient): Promise<string> {
  const city = await prisma.city.findUnique({ where: { slug: 'tehran' }, select: { id: true } });
  if (!city) {
    console.error('Tehran is not in the catalog. Run `pnpm seed:catalog` first.');
    process.exit(1);
  }
  return city.id;
}

async function categoryIds(prisma: PrismaClient): Promise<Map<string, string>> {
  const rows = await prisma.category.findMany({ select: { slug: true, id: true } });
  return new Map(rows.map((row) => [row.slug, row.id]));
}

async function districtIds(prisma: PrismaClient, cityId: string): Promise<Map<string, string>> {
  const rows = await prisma.district.findMany({
    where: { cityId },
    select: { slug: true, id: true },
  });
  return new Map(rows.map((row) => [row.slug, row.id]));
}

/**
 * `inDays` from now at `hour` **Tehran time**.
 *
 * The offset is written out rather than taken from `Intl`, because this is the one
 * place a seed can get a whole day wrong: an event stamped at 18:00 UTC is 21:30 in
 * Tehran, which turns "شب بازی" into a listing that starts after midnight. Iran
 * abolished DST in 2022, so +03:30 is fixed (ADR-0008).
 */
function at(now: Date, inDays: number, hour: number): Date {
  const day = new Date(now.getTime() + inDays * 24 * 3_600_000);
  const tehranMidnightUtc = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
    -3,
    -30,
  );
  return new Date(tehranMidnightUtc + hour * 3_600_000);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
