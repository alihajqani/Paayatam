import { Inject, Injectable, Logger } from '@nestjs/common';
import { Bot, GrammyError, HttpError } from 'grammy';
import type { Env } from '@payetam/config';
import { ENV, RedisService } from '@payetam/platform';
import type { MembershipProbe, MembershipProbeResult } from '@payetam/domain';

/**
 * Asking Telegram whether somebody is in the channel (M22 phase 6).
 *
 * ── Why this one Telegram call lives in the API ──────────────────────────────
 *
 * Invariant 11 says every outbound Telegram call happens in the worker, and it is
 * the right rule for **sends**: Telegram's ~30/s has to shape queue throughput
 * rather than API latency, and a send is something the product decides to do.
 * `getChatMember` is neither. It is a **read**, it is synchronous, and a user is
 * watching a spinner for its answer — routing it through a queue would turn
 * «بررسی عضویت» into a poll that takes seconds and would put a question about one
 * user behind a backlog of notifications for everybody else.
 *
 * So this is a deliberate, documented exception, and it is bounded in three ways
 * so that it cannot become a second uncontrolled path to Telegram:
 *
 *  - **One method.** There is no `sendMessage` here and no `Bot` handle exposed.
 *  - **Cached.** An answer is reused for `CACHE_TTL_SECONDS`, so opening five
 *    screens is one call rather than five. `POST /me/channel-membership/check`
 *    clears the entry first, which is what makes «بررسی دوباره» honest.
 *  - **Failing open.** Every outcome except an authoritative "not a member" lets
 *    the user through, so a Telegram outage degrades the *gate* rather than the
 *    product.
 *
 * Nothing here ever returns or logs the bot token, and the Telegram user id it is
 * given goes to the API call and into a cache key — never into a response.
 */
@Injectable()
export class TelegramMembershipProbe implements MembershipProbe {
  private readonly logger = new Logger(TelegramMembershipProbe.name);
  private readonly bot: Bot | null;

  constructor(
    @Inject(ENV) env: Env,
    private readonly redis: RedisService,
  ) {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (token === undefined || token === '') {
      // Development and CI have no token. Reporting the absence per check rather
      // than failing construction, exactly as `TelegramClient` does — a missing
      // token must not stop the API booting.
      this.logger.warn('TELEGRAM_BOT_TOKEN is not set — membership checks will report UNKNOWN.');
      this.bot = null;
      return;
    }
    // No `auto-retry`, unlike the sender. A membership check is in front of a
    // person: an answer that arrives thirty seconds late is worse than "we could
    // not tell", which fails open anyway.
    this.bot = new Bot(token);
  }

  /**
   * Statuses Telegram reports for somebody who is in the chat.
   *
   * `restricted` is deliberately included when `is_member` is true: a muted member
   * is still a member, and the product's question is "did they join?" rather than
   * "can they post?". `left` and `kicked` are the two that mean no.
   */
  private static readonly MEMBER_STATUSES = new Set(['creator', 'administrator', 'member']);

  async check(chatIdentifier: string, telegramUserId: bigint): Promise<MembershipProbeResult> {
    if (this.bot === null) return { kind: 'UNKNOWN', reason: 'NO_TOKEN' };

    const cacheKey = keyFor(chatIdentifier, telegramUserId);
    const cached = await this.readCache(cacheKey);
    if (cached !== null) return cached;

    let result: MembershipProbeResult;
    try {
      const member = await this.bot.api.getChatMember(chatIdentifier, Number(telegramUserId));
      const joined =
        TelegramMembershipProbe.MEMBER_STATUSES.has(member.status) ||
        (member.status === 'restricted' && member.is_member);
      result = joined ? { kind: 'MEMBER' } : { kind: 'NOT_MEMBER' };
    } catch (error) {
      result = classifyMembershipError(error);
    }

    await this.writeCache(cacheKey, result);
    return result;
  }

  /** Drop a cached answer, so an explicit re-check actually asks Telegram. */
  async invalidate(chatIdentifier: string, telegramUserId: bigint): Promise<void> {
    try {
      await this.redis.client.del(keyFor(chatIdentifier, telegramUserId));
    } catch {
      // A cache that cannot be cleared costs one stale answer for at most the TTL.
      // Failing the user's re-check over it would be the wrong trade.
    }
  }

  private async readCache(key: string): Promise<MembershipProbeResult | null> {
    try {
      const value = await this.redis.client.get(key);
      if (value === 'MEMBER') return { kind: 'MEMBER' };
      if (value === 'NOT_MEMBER') return { kind: 'NOT_MEMBER' };
      return null;
    } catch {
      // Redis down. Asking Telegram directly is slower and correct; refusing would
      // be neither.
      return null;
    }
  }

  /**
   * Only the two authoritative answers are cached.
   *
   * Caching `UNKNOWN` would extend a transient Telegram problem into a
   * two-minute one for that user, and caching `CHAT_UNAVAILABLE` would keep an
   * operator's fix invisible for the same window. Both are cheap to re-ask.
   */
  private async writeCache(key: string, result: MembershipProbeResult): Promise<void> {
    if (result.kind !== 'MEMBER' && result.kind !== 'NOT_MEMBER') return;
    try {
      await this.redis.client.set(key, result.kind, 'EX', CACHE_TTL_SECONDS);
    } catch {
      // Same reasoning as `invalidate`: a cache miss is a slower answer, not a
      // wrong one.
    }
  }
}

/**
 * Two minutes.
 *
 * Long enough that browsing several screens is one Telegram call, short enough
 * that a user who joins and comes back a minute later is not told they have not.
 * The explicit re-check bypasses it entirely, which is what makes the button mean
 * something.
 */
const CACHE_TTL_SECONDS = 120;

/**
 * The cache key.
 *
 * The Telegram id appears here and nowhere else outside the API call itself. It
 * is inside a Redis key rather than a response or a log line, which is where
 * ADR-0009 permits it to be — the same place `InitDataReplayGuard` puts a hash.
 */
function keyFor(chatIdentifier: string, telegramUserId: bigint): string {
  return `channel-member:${chatIdentifier}:${telegramUserId.toString()}`;
}

/**
 * Which Telegram failure this was, from the product's point of view.
 *
 * The distinction that matters is **whose problem it is**. A 400 naming the chat
 * is configuration; a 400 naming the *user* usually means the bot cannot see the
 * member list, which is also configuration; anything else is weather. None of the
 * three blocks the user, and each one leads to a different sentence on screen and
 * a different fix in the panel.
 */
export function classifyMembershipError(error: unknown): MembershipProbeResult {
  if (error instanceof GrammyError) {
    const description = error.description;
    if (/chat not found|chat_id is empty|invalid.*chat/i.test(description)) {
      return { kind: 'CHAT_UNAVAILABLE', reason: description };
    }
    if (
      error.error_code === 403 ||
      /not enough rights|member list is inaccessible/i.test(description)
    ) {
      return { kind: 'BOT_CANNOT_VERIFY', reason: description };
    }
    // A 429 lands here, and lands as UNKNOWN — which fails open. Rate-limiting a
    // membership check must not lock anybody out of the product.
    return { kind: 'UNKNOWN', reason: `${String(error.error_code)}: ${description}` };
  }

  if (error instanceof HttpError) return { kind: 'UNKNOWN', reason: 'network error' };
  return { kind: 'UNKNOWN', reason: error instanceof Error ? error.message : 'unknown error' };
}
