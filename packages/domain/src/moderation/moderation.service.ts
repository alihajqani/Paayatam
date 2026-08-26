import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { ModerationSubjectType, Prisma } from '@payetam/db';
import { BlacklistService, type BlacklistMatch } from './blacklist.service';
import { normalize } from './persian-normalizer';

/**
 * What the scanner decided.
 *
 * `CLEAN` publishes. `FLAG` publishes **and** opens a case. `BLOCK` does not
 * publish and opens a case.
 *
 * That FLAG publishes is ADR-0012's central tuning decision, and it is worth
 * restating where the code implements it: a false positive that blocks a
 * legitimate host is a worse product outcome than a flagged item sitting briefly
 * in a review queue. Ambiguous terms are therefore configured FLAG by default,
 * and the automation is a filter feeding human review rather than a gate.
 */
export type ModerationDecision = 'CLEAN' | 'FLAG' | 'BLOCK';

export interface ContentScan {
  decision: ModerationDecision;
  matches: BlacklistMatch[];
  /** The version that judged, recorded on any case this produces. */
  blacklistVersion: number;
}

export interface NormalizedContent {
  title: string;
  description: string;
}

@Injectable()
export class ModerationService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly blacklist: BlacklistService,
  ) {}

  /**
   * Normalizes event text and scans it.
   *
   * Title and description are scanned as one subject: a term split across the
   * two would otherwise be a trivial evasion, and a host has no legitimate
   * reason for the boundary between the fields to change a verdict.
   */
  async scanEventContent(
    content: { title: string; description: string; customCategoryLabel?: string | null },
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<ContentScan & { normalized: NormalizedContent }> {
    const blacklist = await this.blacklist.load(tx);
    // The «سایر» label (M21) joins the corpus but produces no normalized column:
    // it is moderated like the title and deliberately not searchable, because
    // widening the 0005 `search_vector` trigger would put a tsvector rebuild on
    // the product's most contended write path. Migration 0020 has the argument.
    const matches = this.blacklist.match(
      [content.title, content.description, content.customCategoryLabel ?? '']
        .filter((part) => part !== '')
        .join('\n'),
      blacklist.rules,
    );

    return {
      decision: decisionFor(matches),
      matches,
      blacklistVersion: blacklist.version,
      normalized: {
        title: normalize(content.title),
        description: normalize(content.description),
      },
    };
  }

  /**
   * Scans a single free-text field — a review comment (M11).
   *
   * Separate from `scanEventContent` because there is only one field and no
   * normalized columns to produce: a review has no search vector and is never
   * matched against a query. The blacklist and the verdict rules are identical,
   * which is the point — a term that cannot appear in an event description cannot
   * appear in a review of one either.
   */
  async scanText(text: string, tx: Prisma.TransactionClient = this.prisma): Promise<ContentScan> {
    const blacklist = await this.blacklist.load(tx);
    const matches = this.blacklist.match(text, blacklist.rules);

    return {
      decision: decisionFor(matches),
      matches,
      blacklistVersion: blacklist.version,
    };
  }

  /**
   * Opens an `AUTO_BLACKLIST` case for a scan that was not clean.
   *
   * Takes the caller's transaction: the case must commit with the content it
   * judges. A case for an event that was rolled back is a moderator's wasted
   * afternoon, and content published with no case is the failure that matters.
   *
   * `matched_terms` carries the rules that fired, never the text they fired on —
   * the case points at its subject, and the subject is where the text lives.
   */
  async openCase(
    tx: Prisma.TransactionClient,
    input: {
      subjectType: ModerationSubjectType;
      subjectId: string;
      scan: ContentScan;
    },
  ): Promise<string> {
    const created = await tx.moderationCase.create({
      data: {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        trigger: 'AUTO_BLACKLIST',
        status: 'OPEN',
        blacklistVersion: input.scan.blacklistVersion,
        matchedTerms: input.scan.matches as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    return created.id;
  }
}

/**
 * BLOCK wins over FLAG wins over clean.
 *
 * Separated from the service so the precedence is a pure function with its own
 * test: "one BLOCK among ten FLAGs still blocks" is the property, and it should
 * not need a database to check.
 */
export function decisionFor(matches: BlacklistMatch[]): ModerationDecision {
  if (matches.length === 0) return 'CLEAN';
  return matches.some((match) => match.severity === 'BLOCK') ? 'BLOCK' : 'FLAG';
}
