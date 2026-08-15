/**
 * Seeds the initial TERMS and PRIVACY documents.
 *
 * Development convenience. Real policy text is authored in the admin panel (M12);
 * this exists so onboarding is exercisable before that panel is built.
 *
 * Idempotent: re-running updates the current version in place rather than
 * publishing a second one, so `pnpm seed:policies` is safe to repeat.
 *
 * Refuses to run against production — publishing placeholder legal text to real
 * users would be considerably worse than a failed script (M17 rail).
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@payetam/db';

const TERMS_FA = `# قوانین و شرایط استفاده از پایه‌تَم

۱. استفاده از پایه‌تَم برای افراد **۱۸ سال و بالاتر** امکان‌پذیر است.

۲. پایه‌تَم یک بستر آشنایی برای فعالیت‌های گروهی است. مسئولیت رفتار، ایمنی و
توافق‌های خارج از برنامه بر عهدهٔ خود کاربران است.

۳. انتشار محتوای توهین‌آمیز، تبلیغاتی یا خلاف قوانین ممنوع است.

۴. لغو دیرهنگام یا عدم حضور در فعالیت، موجب کسر سکه و کاهش امتیاز اعتماد می‌شود.

۵. گفتگوی ناشناس تا زمان پذیرش میزبان ادامه دارد. اشتراک‌گذاری اطلاعات تماس تنها
با اقدام آگاهانهٔ خود شما انجام می‌شود.`;

const PRIVACY_FA = `# سیاست حریم خصوصی

۱. شناسهٔ تلگرام شما هرگز به کاربران دیگر نمایش داده نمی‌شود.

۲. در گفتگوی ناشناس، شما با یک نام مستعار موقت شناخته می‌شوید.

۳. پیام‌های گفتگو برای بررسی تخلفات نگهداری می‌شوند و **۹۰ روز** پس از بسته شدن
گفتگو حذف می‌گردند.

۴. شمارهٔ تماس شما توسط پایه‌تَم ذخیره نمی‌شود.

۵. نشانی IP شما به‌صورت رمزشده (هش) و تنها برای جلوگیری از سوءاستفاده نگهداری می‌شود.`;

async function main(): Promise<void> {
  if (process.env['NODE_ENV'] === 'production' && process.env['ALLOW_PROD_SEED'] !== '1') {
    console.error(
      'Refusing to seed placeholder policy text in production.\n' +
        'Real policy documents are published through the admin panel.',
    );
    process.exit(1);
  }

  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  const documents = [
    { type: 'TERMS' as const, contentMd: TERMS_FA, summaryFa: 'قوانین استفاده از پایه‌تَم' },
    { type: 'PRIVACY' as const, contentMd: PRIVACY_FA, summaryFa: 'سیاست حریم خصوصی' },
  ];

  for (const doc of documents) {
    const existing = await prisma.policyVersion.findFirst({
      where: { type: doc.type, isCurrent: true },
    });

    if (existing) {
      await prisma.policyVersion.update({
        where: { id: existing.id },
        data: { contentMd: doc.contentMd, summaryFa: doc.summaryFa },
      });
      console.log(`updated ${doc.type} v${existing.version}`);
    } else {
      const created = await prisma.policyVersion.create({
        data: { ...doc, version: 1, isCurrent: true },
      });
      console.log(`published ${doc.type} v${created.version}`);
    }
  }

  await prisma.$disconnect();
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
