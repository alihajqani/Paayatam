import { ALL_DAY_PARTS, type DayPart } from './seed-variety';

/**
 * A curated bank of believable Persian event text for marketing seed events
 * (see docs/superpowers/specs/2026-09-18-marketing-seed-events-design.md and
 * 2026-09-19-seed-event-floor-and-purge-design.md).
 *
 * Two layers. Each catalogue category (by `slug`, which is stable — `nameFa` may
 * be renamed) has a few concrete topics, so a city's feed reads as different
 * evenings rather than one template with the category name swapped in. A
 * category the bank does not know — the catalogue is admin-editable — falls back
 * to generic templates over its name, so nothing here can make a new category
 * unusable.
 *
 * Every topic says which parts of the day it makes sense in: a sunrise walk is
 * not offered at 19:30. Nothing here names a venue, a price, a date or a day of
 * the week — the event row carries the date, and text that disagreed with it
 * would be the first thing a reader noticed.
 *
 * `random` is injected (same shape as `Math.random`) so the picker is a pure,
 * deterministically-testable function.
 */

export interface SeedContent {
  title: string;
  description: string;
  /** When the topic makes sense; the caller draws a start inside these. */
  parts: readonly DayPart[];
}

interface Topic {
  title: string;
  about: string;
  parts?: readonly DayPart[];
}

const MORNING: readonly DayPart[] = ['MORNING'];
const MORNING_OR_AFTERNOON: readonly DayPart[] = ['MORNING', 'AFTERNOON'];
const AFTERNOON_OR_EVENING: readonly DayPart[] = ['AFTERNOON', 'EVENING'];
const AFTERNOON: readonly DayPart[] = ['AFTERNOON'];
const EVENING: readonly DayPart[] = ['EVENING'];

const TOPICS_BY_SLUG: ReadonlyMap<string, readonly Topic[]> = new Map([
  [
    'cafe-boardgames',
    [
      {
        title: 'شب بازی‌های رومیزی',
        about:
          'چند بازی گروهی ساده روی میز می‌آید و قوانین را همان‌جا یاد می‌دهیم. تازه‌کار بودن مشکلی ندارد.',
        parts: EVENING,
      },
      {
        title: 'دورهمی بازی‌های کارتی',
        about:
          'از بازی‌های کارتی سبک تا بازی‌های داستان‌گو. هر کس بخواهد می‌تواند بازی مورد علاقه‌اش را هم بیاورد.',
        parts: AFTERNOON_OR_EVENING,
      },
      {
        title: 'قهوه و بازی‌های فکری',
        about: 'یک عصر آرام با قهوه، معما و بازی‌های استراتژیک دو تا شش نفره.',
        parts: AFTERNOON,
      },
      {
        title: 'شب معما و بازی گروهی',
        about:
          'بازی‌های حدس‌زدنی و معماهای تیمی. جمع را چند تیم می‌کنیم و رقابتی دوستانه راه می‌اندازیم.',
        parts: EVENING,
      },
    ],
  ],
  [
    'outdoor',
    [
      {
        title: 'کوهپیمایی سبک',
        about:
          'مسیری آسان و مناسب کسانی که تازه شروع کرده‌اند. کفش راحت و یک بطری آب همراه داشته باشید.',
        parts: MORNING,
      },
      {
        title: 'پیک‌نیک در پارک',
        about: 'هر کس یک خوراکی می‌آورد و فرش را با هم پهن می‌کنیم. بازی و گپ هم داریم.',
        parts: MORNING_OR_AFTERNOON,
      },
      {
        title: 'طلوع‌گردی و صبحانه بیرون',
        about: 'صبح زود کمی قدم می‌زنیم و بعد با هم صبحانه می‌خوریم.',
        parts: MORNING,
      },
      {
        title: 'گشت عکاسی در طبیعت',
        about: 'با هر دوربینی، حتی موبایل. هدف دیدن و عکس گرفتن است، نه مسابقه.',
        parts: MORNING_OR_AFTERNOON,
      },
    ],
  ],
  [
    'sports',
    [
      {
        title: 'والیبال دوستانه',
        about: 'دو تیم می‌شویم و بازی می‌کنیم. سطح مهم نیست، خوش گذشتن مهم است.',
        parts: AFTERNOON_OR_EVENING,
      },
      {
        title: 'بدمینتون گروهی',
        about: 'چند زمین و چرخش بازیکن‌ها. همه بازی می‌کنند و کسی بیرون نمی‌ماند.',
        parts: AFTERNOON_OR_EVENING,
      },
      {
        title: 'دویدن سبک صبحگاهی',
        about: 'با سرعتی راحت می‌دویم تا همه بتوانند همراه شوند. آخرش هم یک چای.',
        parts: MORNING,
      },
      {
        title: 'یوگای گروهی در فضای باز',
        about: 'حرکت‌های مقدماتی و آرام، مناسب کسانی که تجربه ندارند. زیرانداز خودتان را بیاورید.',
        parts: MORNING_OR_AFTERNOON,
      },
    ],
  ],
  [
    'learning',
    [
      {
        title: 'کارگاه مقدماتی عکاسی با موبایل',
        about:
          'نکته‌های ساده‌ی نور و قاب‌بندی را با هم تمرین می‌کنیم و عکس‌های همدیگر را می‌بینیم.',
        parts: MORNING_OR_AFTERNOON,
      },
      {
        title: 'جلسه‌ی کتاب‌خوانی',
        about: 'هر کس از کتابی که این روزها می‌خواند می‌گوید. لازم نیست کتاب مشترکی خوانده باشید.',
        parts: AFTERNOON_OR_EVENING,
      },
      {
        title: 'تمرین مکالمه‌ی انگلیسی',
        about: 'گپی ساده و بدون قضاوت برای روان‌تر شدن زبان، در سطح مبتدی تا متوسط.',
        parts: AFTERNOON_OR_EVENING,
      },
      {
        title: 'کارگاه خوشنویسی مقدماتی',
        about: 'با قلم‌نی و مرکب آشنا می‌شویم و چند حرف را با هم تمرین می‌کنیم.',
        parts: MORNING_OR_AFTERNOON,
      },
    ],
  ],
  [
    'cafe-hopping',
    [
      {
        title: 'کافه‌گردی در محله',
        about: 'دو سه کافه‌ی نزدیک هم را پیاده می‌رویم و در هر کدام یک نوشیدنی می‌خوریم.',
        parts: AFTERNOON_OR_EVENING,
      },
      {
        title: 'امتحان کردن کافه‌های تازه',
        about: 'کافه‌هایی که هنوز نرفته‌ایم. هر کس پیشنهاد خودش را می‌گوید.',
        parts: AFTERNOON_OR_EVENING,
      },
      {
        title: 'قهوه‌ی تخصصی و گپ',
        about: 'یک ساعت قهوه‌ی خوب و حرف زدن درباره‌ی هر چیزی جز کار.',
        parts: MORNING_OR_AFTERNOON,
      },
    ],
  ],
  [
    'walking',
    [
      {
        title: 'پیاده‌روی عصرگاهی',
        about: 'یک ساعت پیاده‌روی آرام و گپ. سرعت را با کندترین نفر تنظیم می‌کنیم.',
        parts: AFTERNOON_OR_EVENING,
      },
      {
        title: 'قدم زدن در محله‌های قدیمی',
        about: 'کوچه‌های قدیمی را با هم می‌گردیم و از داستان‌هایشان می‌گوییم.',
        parts: MORNING_OR_AFTERNOON,
      },
      {
        title: 'پیاده‌روی و گپ درباره‌ی فیلم',
        about: 'در راه از فیلم‌هایی می‌گوییم که اخیراً دیده‌ایم.',
        parts: AFTERNOON_OR_EVENING,
      },
    ],
  ],
  [
    'museum',
    [
      {
        title: 'بازدید گروهی از یک گالری',
        about: 'نقاشی و عکس را با هم می‌بینیم و بعد از آن کمی درباره‌شان حرف می‌زنیم.',
        parts: MORNING_OR_AFTERNOON,
      },
      {
        title: 'گشت در موزه',
        about: 'بازدیدی بی‌عجله و بدون راهنما. هر کس از بخش مورد علاقه‌اش می‌گوید.',
        parts: MORNING_OR_AFTERNOON,
      },
      {
        title: 'نمایشگاه و یک چای بعدش',
        about: 'نمایشگاه را می‌بینیم و بعد برای گپ می‌نشینیم.',
        parts: AFTERNOON,
      },
    ],
  ],
  [
    'shopping',
    [
      {
        title: 'گشت در بازارچه‌ی صنایع دستی',
        about: 'فقط برای دیدن و پیدا کردن چیزهای خاص. خرید کردن اجباری نیست.',
        parts: MORNING_OR_AFTERNOON,
      },
      {
        title: 'کتاب‌گردی و گپ',
        about: 'چند کتاب‌فروشی را می‌گردیم و کتاب‌های مورد علاقه‌مان را به هم معرفی می‌کنیم.',
        parts: AFTERNOON,
      },
      {
        title: 'بازارچه و یک چای بعدش',
        about: 'گشتی در بازارچه و بعد چای و گپ.',
        parts: MORNING_OR_AFTERNOON,
      },
    ],
  ],
  [
    'food-tour',
    [
      {
        title: 'غذاگردی در چند خیابان',
        about:
          'چند جای کوچک و خوب را امتحان می‌کنیم. از هر جا یک پرس کوچک می‌گیریم و بین همه تقسیم می‌کنیم.',
        parts: AFTERNOON_OR_EVENING,
      },
      {
        title: 'امتحان غذاهای محلی',
        about: 'غذاهایی را امتحان می‌کنیم که در روزهای عادی کمتر سراغشان می‌رویم.',
        parts: AFTERNOON_OR_EVENING,
      },
      {
        title: 'صبحانه‌ی سنتی',
        about: 'صبحانه‌ای بی‌عجله با نان و پنیر و چای، مثل صبح‌های قدیم.',
        parts: MORNING,
      },
      {
        title: 'شیرینی‌گردی و چای',
        about: 'چند قنادی و شیرینی‌فروشی را می‌گردیم و از هر جا یک چیز کوچک امتحان می‌کنیم.',
        parts: AFTERNOON,
      },
    ],
  ],
  [
    'cinema-theatre',
    [
      {
        title: 'فیلم‌دیدن دسته‌جمعی',
        about: 'یک فیلم را با هم می‌بینیم و بعدش درباره‌اش حرف می‌زنیم.',
        parts: AFTERNOON_OR_EVENING,
      },
      {
        title: 'تئاتر و گپ بعد از نمایش',
        about: 'نمایش را با هم می‌بینیم و بعدش کمی می‌نشینیم و نظرها را می‌شنویم.',
        parts: EVENING,
      },
      {
        title: 'شب فیلم کلاسیک',
        about: 'یک فیلم قدیمی را با هم می‌بینیم و بعدش چای می‌خوریم.',
        parts: EVENING,
      },
    ],
  ],
  [
    'music',
    [
      {
        title: 'شب موسیقی زنده',
        about: 'به یک اجرای زنده‌ی کوچک می‌رویم و کنار هم می‌نشینیم.',
        parts: EVENING,
      },
      {
        title: 'دورهمی ساز و آواز',
        about: 'هر کس ساز دارد بیاورد. هر کس ندارد فقط بیاید و گوش بدهد.',
        parts: AFTERNOON_OR_EVENING,
      },
      {
        title: 'شب گوش دادن به یک آلبوم',
        about: 'یک آلبوم را کامل و بدون حواس‌پرتی گوش می‌دهیم و بعدش گپ می‌زنیم.',
        parts: EVENING,
      },
    ],
  ],
  [
    'travel',
    [
      {
        title: 'برنامه‌ریزی یک سفر کوتاه',
        about: 'برای یک سفر کوتاه مسیر و هزینه را با هم بررسی می‌کنیم.',
      },
      {
        title: 'تجربه‌های سفر',
        about: 'هر کس از یک سفر به‌یادماندنی‌اش می‌گوید و عکس‌ها را نشان می‌دهد.',
        parts: AFTERNOON_OR_EVENING,
      },
      {
        title: 'مسیرهای کوتاه اطراف شهر',
        about: 'جاهای دیدنی نزدیک شهر را به هم معرفی می‌کنیم. شاید از دلش یک سفر یک‌روزه دربیاید.',
      },
    ],
  ],
  [
    'volunteering',
    [
      {
        title: 'دورهمی داوطلب‌ها',
        about:
          'کسانی که به کار داوطلبانه علاقه دارند دور هم جمع می‌شوند و از تجربه‌ها و ایده‌هایشان می‌گویند.',
        parts: AFTERNOON_OR_EVENING,
      },
      {
        title: 'پاکسازی پارک با هم',
        about: 'دستکش و کیسه می‌آوریم و بخشی از پارک را با هم تمیز می‌کنیم.',
        parts: MORNING_OR_AFTERNOON,
      },
    ],
  ],
]);

/** For a category the bank does not know: templates over its name. */
function genericTopics(category: string): readonly Topic[] {
  return [
    {
      title: `دورهمی ${category}`,
      about: `یک برنامه‌ی ${category} کوچک و دوستانه. اگر تازه‌کار هم باشید مشکلی نیست، فضا صمیمی است.`,
    },
    {
      title: `${category} دوستانه`,
      about: `دنبال بهانه‌ای برای بیرون آمدن از خانه هستید؟ این یک ${category} ساده و بی‌تکلف است.`,
    },
    {
      title: `یک عصر با ${category}`,
      about: `جمع کوچکی برای ${category}. هدف آشنایی و وقت گذراندن است، نه رقابت.`,
      parts: AFTERNOON_OR_EVENING,
    },
    {
      title: `${category} برای آشنایی با آدم‌های جدید`,
      about: `اگر می‌خواهید در حین ${category} با آدم‌های تازه آشنا شوید، این قرار برای شماست.`,
    },
  ];
}

/** Every closing names the city, so a description always says where it is. */
const CLOSINGS: ReadonlyArray<(city: string) => string> = [
  (city) => `برنامه در ${city} برگزار می‌شود و جمع کوچک و صمیمی است.`,
  (city) => `اگر در ${city} هستید و دنبال آشنایی با آدم‌های تازه‌اید، همراه شوید.`,
  (city) => `قرار ما در ${city} است. هدف آشنایی و وقت‌گذرانی خوب است، نه رقابت.`,
  (city) => `مخصوص کسانی که در ${city} تنها می‌آیند و دوست دارند آدم‌های تازه ببینند.`,
];

function draw<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length) % items.length]!;
}

/**
 * A title, a description and the parts of the day they suit.
 *
 * `takenTitles` is the set of titles the city's upcoming events already carry:
 * a topic already in use is skipped, so a city never shows the same evening
 * twice while an unused one is available. Only when every topic of the category
 * is taken does it repeat one, because a repeat is better than no event.
 */
export function pickSeedContent(input: {
  /** The category's slug; omit for a category the bank should treat as unknown. */
  categorySlug?: string;
  categoryNameFa: string;
  cityNameFa: string;
  takenTitles?: ReadonlySet<string>;
  random: () => number;
}): SeedContent {
  const known =
    input.categorySlug === undefined ? undefined : TOPICS_BY_SLUG.get(input.categorySlug);
  const topics = known ?? genericTopics(input.categoryNameFa);

  const taken = input.takenTitles;
  const fresh = taken === undefined ? topics : topics.filter((topic) => !taken.has(topic.title));
  const topic = draw(fresh.length > 0 ? fresh : topics, input.random);
  const closing = draw(CLOSINGS, input.random);

  return {
    title: topic.title,
    description: `${topic.about} ${closing(input.cityNameFa)}`,
    parts: topic.parts ?? ALL_DAY_PARTS,
  };
}

/** Exposed for the tests that scan the whole bank against the blacklist. */
export function allSeedTopicTexts(): string[] {
  const texts: string[] = [];
  for (const topics of TOPICS_BY_SLUG.values()) {
    for (const topic of topics) texts.push(topic.title, topic.about);
  }
  for (const topic of genericTopics('کافه‌گردی')) texts.push(topic.title, topic.about);
  for (const closing of CLOSINGS) texts.push(closing('تهران'));
  return texts;
}
