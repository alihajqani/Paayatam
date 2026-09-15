/**
 * What asking Telegram produced.
 *
 * Five outcomes rather than a boolean, because they lead to five different
 * screens and three different decisions. Collapsing them would mean a user whose
 * check failed because Telegram was down sees the same message as one who is
 * genuinely not a member — and the second is asked to join while the first is
 * asked to do nothing they can do.
 */
export type MembershipProbeResult =
  | { kind: 'MEMBER' }
  | { kind: 'NOT_MEMBER' }
  /** The chat id is wrong, or the channel is gone. Configuration, not the user. */
  | { kind: 'CHAT_UNAVAILABLE'; reason: string }
  /** The bot is not an administrator, so it cannot see the member list. */
  | { kind: 'BOT_CANNOT_VERIFY'; reason: string }
  /** A timeout, a 5xx, a rate limit. Nothing is known, and it is nobody's fault. */
  | { kind: 'UNKNOWN'; reason: string };

/**
 * The port the API implements by talking to Telegram.
 *
 * An injection token rather than a direct dependency, for the reason every other
 * Telegram boundary in this codebase has one: the domain must stay testable with
 * no token and no network, and the one class that can make a network call should
 * be reachable from exactly one place. A deployment that provides no probe — a
 * test, a worker, a CI run — gets `UNKNOWN`, which fails open.
 */
export const MEMBERSHIP_PROBE = Symbol('MEMBERSHIP_PROBE');

export interface MembershipProbe {
  check(chatIdentifier: string, telegramUserId: bigint): Promise<MembershipProbeResult>;
  /**
   * Drop any cached answer for this pair.
   *
   * Optional, because a probe with no cache has nothing to clear — and the domain
   * must not require an implementation to have one. It exists so «بررسی دوباره»
   * can mean "ask Telegram now" rather than "read the same cached answer again".
   */
  invalidate?(chatIdentifier: string, telegramUserId: bigint): Promise<void>;
  /**
   * Whether the **bot itself** can check members of this channel (v0.16.0).
   *
   * Optional for the same reason `invalidate` is. It exists because the gate
   * fails open on `BOT_CANNOT_VERIFY`, and a channel the bot was never made an
   * administrator of is therefore a channel nobody is ever asked to join — with
   * the requirement switched on and green in the panel. `ChannelConfigService`
   * asks this when the panel loads, so the operator reads it there rather than
   * discovering it from a user who got through.
   */
  botStanding?(chatIdentifier: string): Promise<BotChannelStanding>;
}

/**
 * Where the bot stands in a required channel.
 *
 * `ADMIN` is the only one under which `getChatMember` answers about other
 * people. `NOT_ADMIN` covers both "a plain member" and "not in the channel at
 * all": Telegram answers «member list is inaccessible» for either, and the fix
 * the panel names is the same.
 */
export type BotChannelStanding = 'ADMIN' | 'NOT_ADMIN' | 'CHAT_UNAVAILABLE' | 'UNKNOWN';
