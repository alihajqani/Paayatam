import { Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { AppError, ErrorCode } from '@payetam/shared';
import { ChannelConfigService, type GatedAction } from './channel-config.service';

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
}

/** What the Mini App renders, and what the gate decided. */
export interface MembershipState {
  required: boolean;
  /** Which operations are gated right now. Empty when nothing is. */
  requiredActions: GatedAction[];
  /** Where to send somebody who has to join. Null when nothing is configured. */
  joinUrl: string | null;
  status: MembershipProbeResult['kind'] | 'NOT_REQUIRED';
  /** True when the product will currently let this user through. */
  allowed: boolean;
  /** A machine-readable hint the client renders a Persian sentence for. */
  reason: string | null;
}

/**
 * Requiring users to join the channel before they can do things (M22 phase 6).
 *
 * ── Fail open, and say why ───────────────────────────────────────────────────
 *
 * Three of the five probe outcomes are **not the user's fault**: the chat id is
 * wrong, the bot was never made an administrator, or Telegram is having a bad
 * minute. Every one of them lets the user through, and the requirement says so
 * explicitly — *"do not permanently block users because of a temporary Telegram
 * API failure"*. Only an authoritative `NOT_MEMBER` refuses.
 *
 * That is a deliberate weakening of the gate, and it is the right one: the
 * failure mode of fail-closed is "the product stops working for everybody because
 * somebody removed the bot from a channel", and nobody is watching at 3 a.m.
 * A misconfiguration is loud in the admin panel's status block instead.
 *
 * ── Why the check is short-cached ────────────────────────────────────────────
 *
 * A user who joins and presses «بررسی دوباره» must see the change immediately, so
 * the cache is deliberately brief and the explicit re-check bypasses it. It exists
 * only so that opening five screens does not become five Telegram calls.
 */
@Injectable()
export class ChannelMembershipService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly config: ChannelConfigService,
    @Optional() @Inject(MEMBERSHIP_PROBE) private readonly probe?: MembershipProbe,
  ) {}

  /**
   * Where a user stands, for the screen that explains it.
   *
   * `allowed` here is about the requirement as a whole; the per-action gate is
   * `assertAllowed`. The two read the same config and the same probe, so the
   * screen and the refusal cannot disagree.
   */
  async stateFor(userId: string, action?: GatedAction): Promise<MembershipState> {
    const config = await this.config.get();
    const joinUrl =
      config.inviteUrl ??
      (config.publicUsername === null ? null : `https://t.me/${config.publicUsername}`);

    const gated =
      config.membershipRequired &&
      (action === undefined
        ? config.requiredActions.length > 0
        : config.requiredActions.includes(action));

    if (!gated) {
      return {
        required: config.membershipRequired,
        requiredActions: config.requiredActions,
        joinUrl,
        status: 'NOT_REQUIRED',
        allowed: true,
        reason: null,
      };
    }

    const result = await this.probeFor(userId, config.chatIdentifier, config.verifyViaTelegram);

    return {
      required: true,
      requiredActions: config.requiredActions,
      joinUrl,
      status: result.kind,
      // Everything except an authoritative refusal lets the user through.
      allowed: result.kind !== 'NOT_MEMBER',
      reason: result.kind === 'MEMBER' ? null : result.kind,
    };
  }

  /**
   * Ask again, now — the «بررسی دوباره» button (M22 phase 6).
   *
   * Drops the probe's cached answer first, which is the whole point: a user who
   * has just joined must not be told for another two minutes that they have not.
   *
   * The Telegram id is read and used **here**, inside the one service allowed to
   * (ADR-0009), and never reaches the controller — which is why this method exists
   * rather than the route assembling the same three calls itself.
   */
  async recheck(userId: string, action?: GatedAction): Promise<MembershipState> {
    const config = await this.config.get();

    if (config.chatIdentifier !== null && this.probe?.invalidate !== undefined) {
      const account = await this.prisma.telegramAccount.findUnique({
        where: { userId },
        select: { telegramUserId: true },
      });
      if (account !== null) {
        await this.probe.invalidate(config.chatIdentifier, account.telegramUserId);
      }
    }

    return this.stateFor(userId, action);
  }

  /**
   * The gate itself, called by the services that own the protected operations.
   *
   * In the **service** rather than in a guard, and that is the requirement's own
   * instruction — *"do not rely solely on middleware if background jobs or
   * alternate API routes can bypass it"*. A guard protects the routes somebody
   * remembered to decorate; this protects the operation.
   */
  async assertAllowed(userId: string, action: GatedAction): Promise<void> {
    const state = await this.stateFor(userId, action);
    if (state.allowed) return;

    throw new AppError(ErrorCode.CHANNEL_MEMBERSHIP_REQUIRED, {
      joinUrl: state.joinUrl,
      action,
    });
  }

  /**
   * Ask Telegram, if there is anything to ask and anyone to ask it of.
   *
   * `telegram_account` is read here, which is one of the very few places outside
   * the identity module that may (ADR-0009): a membership check is by definition a
   * question about a Telegram account, and the id goes to the probe and nowhere
   * else — never into a response, a log line or a payload.
   */
  private async probeFor(
    userId: string,
    chatIdentifier: string | null,
    verifyViaTelegram: boolean,
  ): Promise<MembershipProbeResult> {
    // Verification switched off: the requirement is advisory, the user is shown
    // the join button and taken at their word. The honest setting for a channel
    // the bot is not an administrator of.
    if (!verifyViaTelegram) return { kind: 'MEMBER' };

    if (chatIdentifier === null) return { kind: 'CHAT_UNAVAILABLE', reason: 'NOT_CONFIGURED' };
    if (this.probe === undefined) return { kind: 'UNKNOWN', reason: 'NO_PROBE' };

    const account = await this.prisma.telegramAccount.findUnique({
      where: { userId },
      select: { telegramUserId: true },
    });
    if (account === null) return { kind: 'UNKNOWN', reason: 'NO_TELEGRAM_ACCOUNT' };

    return this.probe.check(chatIdentifier, account.telegramUserId);
  }
}
