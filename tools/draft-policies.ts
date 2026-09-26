/**
 * Drafts the TERMS, PRIVACY and COMMUNITY documents from `docs/legal/`, for the
 * operator to publish from the panel (v0.21.0).
 *
 * ── What it does, and what it never does ────────────────────────────────────
 *
 * For each document: if a draft is open, its text is replaced with the
 * repository's; otherwise a new draft is created, numbered after the latest
 * version exactly as `PolicyAdminService.createDraft` numbers one. It **never
 * publishes** — publishing is what asks every user to accept again, and that is
 * a person's decision, made with the button in «اسناد حقوقی».
 *
 * Idempotent: a draft whose text already matches is left alone, so running it
 * twice writes nothing the second time.
 *
 * ── Why it may run in production without the typed confirmation ────────────
 *
 * `seed-policies` publishes, and so it refuses production outright. A draft is
 * seen by no user until somebody publishes it, and the panel shows it for
 * review first, so this runs `unattended` — which still writes the seed audit
 * row, plus one row per draft in the shape the panel writes.
 *
 *   PAYETAM_VERSION=v0.21.0 ./scripts/compose.sh --profile tools run --rm tools pnpm draft-policies
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PolicyType, PrismaClient } from '@payetam/db';
import { openSeed } from './seed-guard';

/** `__dirname`, not `import.meta.url`: the workspace compiles to CommonJS. */
function legal(name: string): string {
  return readFileSync(join(__dirname, '..', 'docs', 'legal', `${name}-fa.md`), 'utf8');
}

interface Document {
  type: PolicyType;
  file: string;
  titleFa: string;
  summaryFa: string;
  /** What a user who accepted an earlier version is told changed. */
  changeSummaryFa: string;
}

const DOCUMENTS: readonly Document[] = [
  {
    type: 'TERMS',
    file: 'terms',
    titleFa: 'قوانین و شرایط استفاده',
    summaryFa: 'قوانین استفاده از ربات پایتم',
    changeSummaryFa:
      'قوانین از نو نوشته شد: هزینه و بازگشت سکه‌ها (از جمله بازگشت سکهٔ لیست انتظار)، ' +
      'قواعد لغو و جریمه‌ها، پیام مستقیم و مسدود کردن، امتیاز اعتماد و نظرها.',
  },
  {
    type: 'PRIVACY',
    file: 'privacy',
    titleFa: 'سیاست حریم خصوصی',
    summaryFa: 'سیاست حریم خصوصی',
    changeSummaryFa:
      'سیاست حریم خصوصی از نو نوشته شد: پیام‌های مستقیم ۱۸۰ روز نگهداری می‌شوند و مدیران ' +
      'برای رسیدگی به گزارش‌ها می‌توانند آن‌ها را بخوانند، و حساب کاربری حذف نمی‌شود.',
  },
  {
    type: 'COMMUNITY',
    file: 'community',
    titleFa: 'آیین‌نامهٔ رفتار',
    summaryFa: 'آیین‌نامهٔ رفتار کاربران',
    changeSummaryFa:
      'آیین‌نامهٔ رفتار: رفتارهایی که انتظار داریم، رفتارهایی که پذیرفته نمی‌شوند و ' +
      'آنچه پس از تخلف پیش می‌آید.',
  },
];

type Outcome = 'created' | 'updated' | 'unchanged';

async function draft(prisma: PrismaClient, doc: Document): Promise<Outcome> {
  const contentMd = legal(doc.file);
  const fields = {
    titleFa: doc.titleFa,
    contentMd,
    summaryFa: doc.summaryFa,
    changeSummaryFa: doc.changeSummaryFa,
  };

  const open = await prisma.policyVersion.findFirst({
    where: { type: doc.type, status: 'DRAFT' },
  });

  if (open !== null) {
    if (
      open.contentMd === contentMd &&
      open.titleFa === doc.titleFa &&
      open.summaryFa === doc.summaryFa &&
      open.changeSummaryFa === doc.changeSummaryFa
    ) {
      return 'unchanged';
    }
    // Conditional on the revision it read, like the panel's edit: somebody saving
    // the same draft in the panel at this instant makes this fail loudly rather
    // than one of the two edits vanishing.
    const { count } = await prisma.policyVersion.updateMany({
      where: { id: open.id, status: 'DRAFT', revision: open.revision },
      data: { ...fields, revision: { increment: 1 }, updatedAt: new Date() },
    });
    if (count === 0) throw new Error(`${doc.type} draft changed while this ran; run it again.`);
    await prisma.auditLog.create({
      data: {
        actorType: 'SYSTEM',
        action: 'policy.draft_updated',
        targetType: 'policy_version',
        targetId: open.id,
        before: { type: doc.type, version: open.version, revision: open.revision },
        after: {
          type: doc.type,
          version: open.version,
          revision: open.revision + 1,
          source: `docs/legal/${doc.file}-fa.md`,
        },
      },
    });
    return 'updated';
  }

  const latest = await prisma.policyVersion.findFirst({
    where: { type: doc.type },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const version = (latest?.version ?? 0) + 1;
  const now = new Date();

  const created = await prisma.policyVersion.create({
    data: {
      type: doc.type,
      version,
      status: 'DRAFT',
      ...fields,
      isCurrent: false,
      // NOT NULL with a default; `status` is what says it is unpublished, as in
      // `PolicyAdminService.createDraft`.
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    select: { id: true },
  });
  await prisma.auditLog.create({
    data: {
      actorType: 'SYSTEM',
      action: 'policy.draft_created',
      targetType: 'policy_version',
      targetId: created.id,
      after: { type: doc.type, version, status: 'DRAFT', source: `docs/legal/${doc.file}-fa.md` },
    },
  });
  return 'created';
}

async function main(): Promise<void> {
  const { prisma, finish } = await openSeed(
    'policy.drafts_from_repository',
    'This drafts the TERMS, PRIVACY and COMMUNITY text from docs/legal/; nothing is published.',
    { unattended: true },
  );

  const outcomes: Record<string, Outcome> = {};
  for (const doc of DOCUMENTS) {
    outcomes[doc.type] = await draft(prisma, doc);
    console.log(`${doc.type}: ${outcomes[doc.type]}`);
  }

  await finish(outcomes);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
