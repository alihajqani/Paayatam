import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { HELP_GUIDE_DEFAULTS, type HelpGuideDefault } from './help-guide-defaults';
import { placeholderValues, renderGuideText, settingKeysFor } from './help-guide';
import { SettingsService } from './settings.service';

/**
 * One section as it stands: the default from code, with whatever an operator
 * changed laid over it.
 */
export interface HelpGuideEntry {
  slug: string;
  /** Position in `HELP_GUIDE_DEFAULTS`, which is the order `/help` lists them. */
  position: number;
  title: string;
  /** Still holding its `{{placeholders}}`; `render` fills them. */
  body: string;
  hidden: boolean;
  defaultTitle: string;
  defaultBody: string;
  /** Whether the title or the body is an operator's rather than the default. */
  titleCustomized: boolean;
  bodyCustomized: boolean;
  updatedBy: string | null;
  updatedAt: Date | null;
}

/** A section ready to show: placeholders filled, and where it sits among the visible ones. */
export interface RenderedHelpGuide {
  slug: string;
  title: string;
  body: string;
  /** Zero-based among the sections a user can see. */
  index: number;
  total: number;
  previousSlug: string | null;
  nextSlug: string | null;
}

/**
 * The in-bot guide (migration 0063): what `/help` lists and what each section
 * says.
 *
 * Read-only. Editing is `HelpGuideAdminService`, which is where the permission
 * check lives; this is what the bot reads, and the bot has no session.
 */
@Injectable()
export class HelpGuideService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** Every section, hidden ones included, in order. */
  async entries(): Promise<HelpGuideEntry[]> {
    const rows = await this.prisma.helpGuide.findMany({
      where: { slug: { in: HELP_GUIDE_DEFAULTS.map((guide) => guide.slug) } },
    });
    const edited = new Map(rows.map((row) => [row.slug, row]));

    return HELP_GUIDE_DEFAULTS.map((guide, position) => {
      const row = edited.get(guide.slug);
      return toEntry(guide, position, row);
    });
  }

  /** One section by slug, hidden or not; null for a slug the code does not define. */
  async entry(slug: string): Promise<HelpGuideEntry | null> {
    const position = HELP_GUIDE_DEFAULTS.findIndex((guide) => guide.slug === slug);
    const guide = HELP_GUIDE_DEFAULTS[position];
    if (guide === undefined) return null;
    const row = await this.prisma.helpGuide.findUnique({ where: { slug } });
    return toEntry(guide, position, row ?? undefined);
  }

  /** The sections a user can see, for the contents page. */
  async visible(): Promise<{ slug: string; title: string }[]> {
    return (await this.entries())
      .filter((entry) => !entry.hidden)
      .map((entry) => ({ slug: entry.slug, title: entry.title }));
  }

  /**
   * One visible section with its numbers filled in, or null when it is hidden
   * or unknown — an old button, or a section switched off since it was drawn.
   */
  async render(slug: string): Promise<RenderedHelpGuide | null> {
    const visible = (await this.entries()).filter((entry) => !entry.hidden);
    const index = visible.findIndex((entry) => entry.slug === slug);
    const entry = visible[index];
    if (entry === undefined) return null;

    return {
      slug: entry.slug,
      title: entry.title,
      body: renderGuideText(entry.body, await this.valuesFor([entry.body])),
      index,
      total: visible.length,
      previousSlug: visible[index - 1]?.slug ?? null,
      nextSlug: visible[index + 1]?.slug ?? null,
    };
  }

  /** The live value of every placeholder the given texts name. */
  async valuesFor(texts: readonly string[]): Promise<Record<string, number>> {
    const keys = settingKeysFor(texts);
    if (keys.length === 0) return {};
    return placeholderValues(await this.settings.getNumbers(keys));
  }
}

function toEntry(
  guide: HelpGuideDefault,
  position: number,
  row:
    | {
        title: string | null;
        body: string | null;
        hidden: boolean;
        updatedBy: string | null;
        updatedAt: Date;
      }
    | undefined,
): HelpGuideEntry {
  return {
    slug: guide.slug,
    position,
    title: row?.title ?? guide.title,
    body: row?.body ?? guide.body,
    hidden: row?.hidden ?? false,
    defaultTitle: guide.title,
    defaultBody: guide.body,
    titleCustomized: (row?.title ?? null) !== null,
    bodyCustomized: (row?.body ?? null) !== null,
    updatedBy: row?.updatedBy ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}
