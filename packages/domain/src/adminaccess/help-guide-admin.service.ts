import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import {
  HELP_GUIDE_BODY_MAX,
  HELP_GUIDE_TITLE_MAX,
  helpGuidePlaceholderKeys,
  unknownPlaceholders,
} from '../catalog/help-guide';
import { HelpGuideService, type HelpGuideEntry } from '../catalog/help-guide.service';
import { SETTING_GUIDE, type SettingGuide } from '../catalog/setting-guide';
import { AdminAccessService, type AdminSession } from './admin-access.service';
import { PERMISSIONS } from './permissions';

/** A placeholder the editor may use, with what it reads today. */
export interface HelpGuidePlaceholder {
  key: string;
  /** The setting's own Persian label, or a description of the derived sum. */
  label: string;
  value: number;
}

/** Labels for the derived placeholders, which have no `SETTING_GUIDE` entry. */
const DERIVED_LABELS: Record<string, string> = {
  'derived.event_register_coins': 'هزینهٔ ساختن رویداد (ثبت + انتشار در کانال، یک عدد)',
  'derived.host_no_show_coins': 'جریمهٔ سکهٔ غیبت میزبان (جریمهٔ غیبت × ضریب میزبان)',
};

/**
 * Editing the in-bot guide from the panel (migration 0063).
 *
 * Behind the policy permissions rather than a new one: the guide is text users
 * read about how the product works, which is what `policy.read` and
 * `policy.manage` already mean — the same people who may change the terms may
 * change the guide, and support may read both.
 *
 * ── What an edit stores ─────────────────────────────────────────────────────
 *
 * A title or body equal to the default is stored as NULL, so saving a section
 * unchanged does not freeze it against the next release's corrections. A row
 * whose three columns are all defaults is deleted rather than kept.
 */
@Injectable()
export class HelpGuideAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly access: AdminAccessService,
    private readonly audit: AuditService,
    private readonly guides: HelpGuideService,
  ) {}

  async list(
    session: AdminSession,
  ): Promise<{ guides: HelpGuideEntry[]; placeholders: HelpGuidePlaceholder[] }> {
    this.access.assertPermission(session, PERMISSIONS.POLICY_READ);
    const [guides, placeholders] = await Promise.all([this.guides.entries(), this.placeholders()]);
    return { guides, placeholders };
  }

  /**
   * Save one section. `null` for the title or body means "back to the default".
   *
   * Validated here and not only in the panel, because the bot draws whatever
   * this stores: an unknown placeholder would print as «{{…}}» to every user.
   */
  async update(
    session: AdminSession,
    slug: string,
    input: { title: string | null; body: string | null; hidden: boolean },
  ): Promise<HelpGuideEntry> {
    this.access.assertPermission(session, PERMISSIONS.POLICY_MANAGE);
    const before = await this.guides.entry(slug);
    if (before === null) throw new AppError(ErrorCode.NOT_FOUND);

    const title = normalise(input.title, before.defaultTitle);
    const body = normalise(input.body, before.defaultBody);

    if (title !== null && title.length > HELP_GUIDE_TITLE_MAX) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        field: 'title',
        max: HELP_GUIDE_TITLE_MAX,
      });
    }
    if (body !== null) {
      if (body.length > HELP_GUIDE_BODY_MAX) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          field: 'body',
          max: HELP_GUIDE_BODY_MAX,
        });
      }
      const unknown = unknownPlaceholders(body);
      if (unknown.length > 0) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, {
          field: 'body',
          unknownPlaceholders: unknown,
        });
      }
    }

    await this.prisma.$transaction(async (tx) => {
      if (title === null && body === null && !input.hidden) {
        await tx.helpGuide.deleteMany({ where: { slug } });
      } else {
        await tx.helpGuide.upsert({
          where: { slug },
          create: { slug, title, body, hidden: input.hidden, updatedBy: session.adminUserId },
          update: { title, body, hidden: input.hidden, updatedBy: session.adminUserId },
        });
      }

      await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: session.adminUserId,
          action: 'help_guide.updated',
          targetType: 'help_guide',
          targetId: slug,
          // Staff-written public text, so the words themselves are the record:
          // "who changed the guide to say what" is the question this answers.
          before: {
            title: before.titleCustomized ? before.title : null,
            body: before.bodyCustomized ? before.body : null,
            hidden: before.hidden,
          },
          after: { title, body, hidden: input.hidden },
        },
        tx,
      );
    });

    return this.reread(slug);
  }

  /** Back to the code's default: title, body and visibility. */
  async reset(session: AdminSession, slug: string): Promise<HelpGuideEntry> {
    this.access.assertPermission(session, PERMISSIONS.POLICY_MANAGE);
    const before = await this.guides.entry(slug);
    if (before === null) throw new AppError(ErrorCode.NOT_FOUND);

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.helpGuide.deleteMany({ where: { slug } });
      if (count === 0) return;
      await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: session.adminUserId,
          action: 'help_guide.reset',
          targetType: 'help_guide',
          targetId: slug,
          before: {
            title: before.titleCustomized ? before.title : null,
            body: before.bodyCustomized ? before.body : null,
            hidden: before.hidden,
          },
          after: { title: null, body: null, hidden: false },
        },
        tx,
      );
    });

    return this.reread(slug);
  }

  private async reread(slug: string): Promise<HelpGuideEntry> {
    const entry = await this.guides.entry(slug);
    if (entry === null) throw new AppError(ErrorCode.NOT_FOUND);
    return entry;
  }

  /** Every placeholder, its label and today's value, for the editor's reference list. */
  private async placeholders(): Promise<HelpGuidePlaceholder[]> {
    const keys = helpGuidePlaceholderKeys();
    // `valuesFor` reads exactly the settings the texts name; this names them all.
    const values = await this.guides.valuesFor(keys.map((key) => `{{${key}}}`));
    const guide: Partial<Record<string, SettingGuide>> = SETTING_GUIDE;
    return keys.map((key) => ({
      key,
      label: guide[key]?.label ?? DERIVED_LABELS[key] ?? key,
      value: values[key] ?? 0,
    }));
  }
}

/**
 * Trimmed, with Windows line endings folded, and NULL when it matches the
 * default or is empty — so "saved unchanged" and "never edited" are one state.
 */
function normalise(value: string | null, fallback: string): string | null {
  if (value === null) return null;
  const text = value.replace(/\r\n/g, '\n').trim();
  if (text === '' || text === fallback) return null;
  return text;
}
