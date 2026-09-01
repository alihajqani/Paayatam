import { Inject, Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { AppError, ErrorCode } from '@payetam/shared';
import {
  ChannelConfigService,
  type GatedAction,
  type RequiredChannelRecord,
} from './channel-config.service';

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

/** One channel, and where this user stands with it. */
export interface ChannelMembershipState {
  id: string;
  title: string;
  joinUrl: string | null;
  status: MembershipProbeResult['kind'];
  /** True when this particular channel is not standing in the user's way. */
  allowed: boolean;
}

/** What the Mini App renders, and what the gate decided. */
export interface MembershipState {
  required: boolean;
  /** Which operations are gated right now. Empty when nothing is. */
  requiredActions: GatedAction[];
  /**
   * Every required channel, **in join order**, with this user's standing in each.
   *
   * The order is the operator's — `required_channel.sort_order` — because the
   * requirement states that the order of joining and of display matters. The
   * client renders the list as given and must not sort it.
   */
  channels: ChannelMembershipState[];
  /**
   * Where to send somebody who has to join.
   *
   * The **first channel they have not joined**, so a one-button client still
   * takes them somewhere useful, and so the `CHANNEL_MEMBERSHIP_REQUIRED` error
   * detail keeps the shape it had when there was only one channel. Null when
   * nothing is outstanding or nothing is configured.
   */
  joinUrl: string | null;
  /**
   * The worst thing that happened, across every channel.
   *
   * `NOT_MEMBER` if any channel authoritatively refused; otherwise the first
   * non-`MEMBER` outcome, so a degraded check is still visible to the screen;
   * otherwise `MEMBER`. `NOT_REQUIRED` when the gate does not apply at all.
   */
  status: MembershipProbeResult['kind'] | 'NOT_REQUIRED';
  /** True when the product will currently let this user through. */
  allowed: boolean;
  /** A machine-readable hint the client renders a Persian sentence for. */
  reason: string | null;
}

/**
 * Requiring users to join the channels before they can do things.
 *
 * ── Every channel, and all of them ───────────────────────────────────────────
 *
 * v0.3.1: the requirement is a **list**. A user passes when no active channel
 * refuses them, which is not the same as "passes the first one" — the whole point
 * of several mandatory channels is that joining one is not enough. The check runs
 * over the list in order and reports each channel separately, because the screen
 * has to show which ones are still outstanding rather than a single red banner.
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
 * With several channels this matters more, not less: one misconfigured channel in
 * a list of four must not refuse everybody, so the outcomes are combined by
 * "does any channel *authoritatively* refuse", never by "did every channel say
 * yes".
 *
 * ── Why the check is short-cached ────────────────────────────────────────────
 *
 * A user who joins and presses «بررسی دوباره» must see the change immediately, so
 * the cache is deliberately brief and the explicit re-check bypasses it. It exists
 * only so that opening five screens does not become five Telegram calls — and
 * with a list of channels it is what keeps one screen from becoming four.
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

    /**
     * The switches first, and the channel list only if they say yes.
     *
     * Both reads used to run in parallel, which was right when this was called
     * from a handful of routes. v0.6.5 puts it on the bot's router — every
     * message, command and tap — and the overwhelmingly common answer is "the
     * requirement is off", which the config row alone settles. One indexed read
     * per update instead of two, for a question whose answer is almost always no.
     */
    const switchedOn =
      config.membershipRequired &&
      (action === undefined
        ? config.requiredActions.length > 0
        : config.requiredActions.includes(action));

    const channels = switchedOn ? await this.config.activeChannels() : [];
    const gated = switchedOn && channels.length > 0;

    if (!gated) {
      return {
        required: config.membershipRequired,
        requiredActions: config.requiredActions,
        /**
         * **Empty, not "everybody is a member".**
         *
         * The obvious shortcut here is to return the configured channels with
         * `status: 'MEMBER'`, and it is a lie: nothing was asked, so the honest
         * answer about each channel is "not checked" — and there is no such
         * member of `MembershipProbeResult`, deliberately, because every value in
         * that union is something Telegram actually said. Reporting an
         * unverified `MEMBER` would put a claim into a response that a later
         * screen could render as «عضو هستید» for somebody who is not.
         *
         * A gate that does not apply has nothing to say about channels, so it
         * says nothing.
         */
        channels: [],
        joinUrl: null,
        status: 'NOT_REQUIRED',
        allowed: true,
        reason: null,
      };
    }

    const telegramUserId = config.verifyViaTelegram ? await this.telegramIdOf(userId) : null;

    const results: ChannelMembershipState[] = [];
    for (const channel of channels) {
      const result = await this.probeFor(channel, telegramUserId, config.verifyViaTelegram);
      results.push({
        id: channel.id,
        title: channel.title,
        joinUrl: channel.joinUrl,
        status: result.kind,
        // Everything except an authoritative refusal lets the user through.
        allowed: result.kind !== 'NOT_MEMBER',
      });
    }

    const outstanding = results.filter((channel) => !channel.allowed);
    const degraded = results.find((channel) => channel.status !== 'MEMBER');

    return {
      required: true,
      requiredActions: config.requiredActions,
      channels: results,
      joinUrl: outstanding[0]?.joinUrl ?? null,
      status: outstanding.length > 0 ? 'NOT_MEMBER' : (degraded?.status ?? 'MEMBER'),
      allowed: outstanding.length === 0,
      reason: outstanding.length > 0 ? 'NOT_MEMBER' : (degraded?.status ?? null),
    };
  }

  /**
   * Ask again, now — the «بررسی دوباره» button.
   *
   * Drops the probe's cached answer **for every channel** first, which is the
   * whole point: a user who has just joined three channels must not be told for
   * another two minutes that they have joined none.
   *
   * The Telegram id is read and used **here**, inside the one service allowed to
   * (ADR-0009), and never reaches the controller — which is why this method exists
   * rather than the route assembling the same calls itself.
   */
  async recheck(userId: string, action?: GatedAction): Promise<MembershipState> {
    if (this.probe?.invalidate !== undefined) {
      const channels = await this.config.activeChannels();
      const telegramUserId = await this.telegramIdOf(userId);

      if (telegramUserId !== null) {
        for (const channel of channels) {
          if (channel.chatIdentifier !== null) {
            await this.probe.invalidate(channel.chatIdentifier, telegramUserId);
          }
        }
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
      // Which channels are outstanding, so the bot and the Mini App can list them
      // from the refusal itself rather than making a second call to find out.
      channels: state.channels
        .filter((channel) => !channel.allowed)
        .map((channel) => ({ title: channel.title, joinUrl: channel.joinUrl })),
    });
  }

  /**
   * The caller's Telegram id, or null when there is not one.
   *
   * `telegram_account` is read here, which is one of the very few places outside
   * the identity module that may (ADR-0009): a membership check is by definition a
   * question about a Telegram account, and the id goes to the probe and nowhere
   * else — never into a response, a log line or a payload.
   *
   * Read **once** per check rather than once per channel, which is the difference
   * between one query and four on the screen that lists them.
   */
  private async telegramIdOf(userId: string): Promise<bigint | null> {
    const account = await this.prisma.telegramAccount.findUnique({
      where: { userId },
      select: { telegramUserId: true },
    });
    return account?.telegramUserId ?? null;
  }

  /** Ask Telegram about one channel, if there is anything to ask and anyone to ask it of. */
  private async probeFor(
    channel: RequiredChannelRecord,
    telegramUserId: bigint | null,
    verifyViaTelegram: boolean,
  ): Promise<MembershipProbeResult> {
    // Verification switched off: the requirement is advisory, the user is shown
    // the join button and taken at their word. The honest setting for a channel
    // the bot is not an administrator of.
    if (!verifyViaTelegram) return { kind: 'MEMBER' };

    if (channel.chatIdentifier === null) {
      return { kind: 'CHAT_UNAVAILABLE', reason: 'NOT_CONFIGURED' };
    }
    if (this.probe === undefined) return { kind: 'UNKNOWN', reason: 'NO_PROBE' };
    if (telegramUserId === null) return { kind: 'UNKNOWN', reason: 'NO_TELEGRAM_ACCOUNT' };

    return this.probe.check(channel.chatIdentifier, telegramUserId);
  }
}
