import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { BlacklistPatternType, BlacklistSeverity, Prisma } from '@payetam/db';
import { normalize, tokenize } from './persian-normalizer';

/** A term as the matcher needs it. `termRaw` is for humans; matching uses the normalized form. */
export interface BlacklistRule {
  id: string;
  termRaw: string;
  termNormalized: string;
  patternType: BlacklistPatternType;
  severity: BlacklistSeverity;
  category: string | null;
}

/** What goes into `moderation_case.matched_terms`. Never the scanned text. */
export interface BlacklistMatch {
  termId: string;
  termRaw: string;
  patternType: BlacklistPatternType;
  severity: BlacklistSeverity;
  category: string | null;
}

export interface Blacklist {
  version: number;
  rules: BlacklistRule[];
}

/**
 * The longest a normalized string may be before regex rules stop being applied
 * to it.
 *
 * JavaScript has no regex timeout, so a pathological admin-authored pattern is a
 * denial of service on the event-creation path. Bounding the *subject* bounds
 * the damage: backtracking blows up with input length, and event text is capped
 * at 2000 characters by the schema anyway, so this never fires in practice. It
 * is the backstop for the day something longer reaches the scanner.
 */
const MAX_REGEX_SUBJECT_LENGTH = 4000;

@Injectable()
export class BlacklistService {
  private readonly logger = new Logger(BlacklistService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Loads the active rules and the version that will judge with them.
   *
   * Read fresh on every scan. Event creation is a rare operation and the term
   * list is small, so a cache would buy nothing measurable and would introduce
   * the one bug that matters here — a moderator adding a term and it not taking
   * effect. M12's re-scan job is where caching earns its place.
   *
   * Version 0 means no `blacklist_version` row exists yet. Scans still run; the
   * caller records 0, which reads honestly as "judged before the list was
   * versioned" rather than pretending some version applied.
   */
  async load(tx: Prisma.TransactionClient = this.prisma): Promise<Blacklist> {
    const [current, terms] = await Promise.all([
      tx.blacklistVersion.findFirst({ orderBy: { version: 'desc' }, select: { version: true } }),
      tx.blacklistTerm.findMany({
        where: { isActive: true },
        select: {
          id: true,
          termRaw: true,
          termNormalized: true,
          patternType: true,
          severity: true,
          category: true,
        },
      }),
    ]);

    return { version: current?.version ?? 0, rules: terms };
  }

  /**
   * Every rule that matches the supplied text.
   *
   * The text is normalized here rather than by the caller, so no caller can
   * accidentally match raw text against normalized terms and quietly find
   * nothing.
   */
  match(rawText: string, rules: BlacklistRule[]): BlacklistMatch[] {
    const normalized = normalize(rawText);
    const tokens = new Set(tokenize(normalized));

    return rules.filter((rule) => this.ruleMatches(rule, normalized, tokens)).map(toMatch);
  }

  private ruleMatches(rule: BlacklistRule, normalized: string, tokens: Set<string>): boolean {
    switch (rule.patternType) {
      case 'EXACT':
        // A whole token, not a substring. This is the Scunthorpe defence: a short
        // banned word that happens to sit inside an innocent one — «بنگ» inside
        // «بنگاه» — must not flag the innocent one. Terms that genuinely need to
        // match mid-word are configured as SUBSTRING, deliberately.
        return rule.termNormalized
          .split(' ')
          .every((part) => part.length === 0 || tokens.has(part));

      case 'SUBSTRING':
        return normalized.includes(rule.termNormalized);

      case 'REGEX':
        return this.regexMatches(rule, normalized);

      default:
        // Unreachable while the enum is exhaustive; a new pattern type must not
        // silently become "matches nothing".
        return false;
    }
  }

  private regexMatches(rule: BlacklistRule, normalized: string): boolean {
    if (normalized.length > MAX_REGEX_SUBJECT_LENGTH) {
      this.logger.warn(
        `Skipped regex rule ${rule.id} on a ${String(normalized.length)}-character subject`,
      );
      return false;
    }

    try {
      // Constructed per call rather than cached: `lastIndex` on a shared global
      // regex is a classic source of alternating true/false results.
      return new RegExp(rule.termNormalized, 'u').test(normalized);
    } catch (error) {
      // An invalid pattern is an admin mistake. It must not take down event
      // creation, and it must not silently behave as "no rule" without a trace.
      this.logger.error(
        `Blacklist rule ${rule.id} has an invalid pattern: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return false;
    }
  }
}

function toMatch(rule: BlacklistRule): BlacklistMatch {
  return {
    termId: rule.id,
    termRaw: rule.termRaw,
    patternType: rule.patternType,
    severity: rule.severity,
    category: rule.category,
  };
}
