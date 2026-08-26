import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';

/**
 * Which operations a membership requirement can cover.
 *
 * A closed list rather than free strings, because every value has to have a call
 * site that enforces it — a configurable action nothing checks is a setting that
 * silently does nothing, which is worse than one that does not exist.
 */
export const GATED_ACTIONS = [
  'EVENT_CREATE',
  'EVENT_JOIN',
  'EVENT_CHANNEL_SEND',
  'EVENT_INVITE',
] as const;
export type GatedAction = (typeof GATED_ACTIONS)[number];

export interface ChannelConfig {
  /** What the Telegram API is given: `@payetam` or `-100…`. Never a token. */
  chatIdentifier: string | null;
  publicUsername: string | null;
  inviteUrl: string | null;
  membershipRequired: boolean;
  requiredActions: GatedAction[];
  verifyViaTelegram: boolean;
  updatedAt: Date;
}

/**
 * Why switching the requirement on right now would be a bad idea.
 *
 * A closed union rather than `string[]`, so the panel's Persian lookup is total
 * and the wire contract cannot drift from what this file produces.
 */
export type ChannelConfigWarning = 'NO_JOIN_LINK' | 'NO_CHAT_IDENTIFIER' | 'NO_ACTIONS_SELECTED';

/** Whether the configuration is complete enough to be switched on safely. */
export interface ChannelConfigStatus extends ChannelConfig {
  /** There is somewhere to send users. */
  hasJoinLink: boolean;
  /** There is an identifier the API can ask about membership with. */
  canVerify: boolean;
  /**
   * Why turning the requirement on right now would be a bad idea, if it would.
   *
   * Empty means safe. Non-empty is rendered by the panel *before* the switch, so
   * the operator never gets to lock everybody out and then read about it.
   */
  warnings: ChannelConfigWarning[];
}

export const CHANNEL_CONFIG_ID = 'default';

/**
 * The public face of the event channel, and whether joining it is required
 * (M22 phase 6).
 *
 * ── What is here and what is not ─────────────────────────────────────────────
 *
 * `TELEGRAM_CHANNEL_ID` stays an environment variable and is untouched by this:
 * it is where the *bot* posts, and a destination editable from a web session is a
 * destination an attacker with a session can redirect. What this holds is the
 * @username, the invite link and the requirement — none of it secret, all of it
 * something an operator needs to change without a deploy.
 *
 * **No token is stored, read or returned by anything in this file.**
 *
 * ── Why the default is off, permanently ──────────────────────────────────────
 *
 * Switching `membership_required` on with a channel the bot cannot see locks out
 * every user of the product at once. So the column defaults to false, the row
 * exists from the migration rather than being created lazily, and `status()`
 * reports the reasons not to enable it before the panel offers the switch.
 */
@Injectable()
export class ChannelConfigService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  /**
   * The current configuration.
   *
   * The row is created by migration 0021 rather than on demand, so there is no
   * "no row yet" branch here — and getting that branch backwards is precisely how
   * a default-off requirement becomes default-on.
   */
  async get(): Promise<ChannelConfig> {
    const row = await this.prisma.eventChannelConfig.findUnique({
      where: { id: CHANNEL_CONFIG_ID },
    });
    if (row === null) {
      // Unreachable in a migrated database. Answering with the safe shape rather
      // than throwing, because the caller is usually a gate and a gate that
      // throws is a gate that locks people out over a missing row.
      return {
        chatIdentifier: null,
        publicUsername: null,
        inviteUrl: null,
        membershipRequired: false,
        requiredActions: [],
        verifyViaTelegram: true,
        updatedAt: this.clock.now(),
      };
    }

    return {
      chatIdentifier: row.chatIdentifier,
      publicUsername: row.publicUsername,
      inviteUrl: row.inviteUrl,
      membershipRequired: row.membershipRequired,
      requiredActions: row.requiredActions.filter(isGatedAction),
      verifyViaTelegram: row.verifyViaTelegram,
      updatedAt: row.updatedAt,
    };
  }

  async status(): Promise<ChannelConfigStatus> {
    const config = await this.get();
    const hasJoinLink = config.inviteUrl !== null || config.publicUsername !== null;
    const canVerify = config.chatIdentifier !== null;

    const warnings: ChannelConfigWarning[] = [];
    if (!hasJoinLink) warnings.push('NO_JOIN_LINK');
    if (config.verifyViaTelegram && !canVerify) warnings.push('NO_CHAT_IDENTIFIER');
    if (config.membershipRequired && config.requiredActions.length === 0) {
      warnings.push('NO_ACTIONS_SELECTED');
    }

    return { ...config, hasJoinLink, canVerify, warnings };
  }

  /**
   * Change it. Every field is optional; an absent one is left alone.
   *
   * The link is **normalised and validated** rather than stored as typed, and that
   * is a security control rather than tidiness: this value is rendered as an
   * `href` in a button every user sees, so an unvalidated one is a phishing link
   * the product would be hosting. Only `https://t.me/…` is accepted.
   *
   * Turning the requirement on with nowhere to send people is refused outright.
   * That is the one warning `status()` reports which is also an error here: every
   * other misconfiguration degrades, and this one locks users out of a product
   * with no way forward on the screen.
   */
  async update(
    adminUserId: string,
    input: {
      chatIdentifier?: string | null | undefined;
      publicUsername?: string | null | undefined;
      inviteUrl?: string | null | undefined;
      membershipRequired?: boolean | undefined;
      requiredActions?: GatedAction[] | undefined;
      verifyViaTelegram?: boolean | undefined;
    },
  ): Promise<ChannelConfigStatus> {
    const before = await this.get();

    const chatIdentifier =
      input.chatIdentifier === undefined
        ? before.chatIdentifier
        : normalizeChatIdentifier(input.chatIdentifier);
    const publicUsername =
      input.publicUsername === undefined
        ? before.publicUsername
        : normalizeUsername(input.publicUsername);
    const inviteUrl =
      input.inviteUrl === undefined ? before.inviteUrl : normalizeInviteUrl(input.inviteUrl);

    const membershipRequired = input.membershipRequired ?? before.membershipRequired;
    const requiredActions = input.requiredActions ?? before.requiredActions;

    if (membershipRequired && inviteUrl === null && publicUsername === null) {
      throw new AppError(ErrorCode.CHANNEL_NOT_CONFIGURED, { reason: 'NO_JOIN_LINK' });
    }

    await this.prisma.eventChannelConfig.upsert({
      where: { id: CHANNEL_CONFIG_ID },
      create: {
        id: CHANNEL_CONFIG_ID,
        chatIdentifier,
        publicUsername,
        inviteUrl,
        membershipRequired,
        requiredActions,
        verifyViaTelegram: input.verifyViaTelegram ?? before.verifyViaTelegram,
        updatedByAdminId: adminUserId,
        updatedAt: this.clock.now(),
      },
      update: {
        chatIdentifier,
        publicUsername,
        inviteUrl,
        membershipRequired,
        requiredActions,
        verifyViaTelegram: input.verifyViaTelegram ?? before.verifyViaTelegram,
        updatedByAdminId: adminUserId,
        updatedAt: this.clock.now(),
      },
    });

    const after = await this.status();

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: adminUserId,
      action: 'channel.config_updated',
      targetType: 'event_channel_config',
      targetId: CHANNEL_CONFIG_ID,
      // Old and new, in full — none of this is secret, and "who turned the
      // requirement on?" is the question this row exists to answer.
      before: auditShape(before),
      after: auditShape(after),
    });

    return after;
  }
}

function isGatedAction(value: string): value is GatedAction {
  return (GATED_ACTIONS as readonly string[]).includes(value);
}

function auditShape(config: ChannelConfig): Record<string, string | boolean> {
  return {
    chatIdentifier: config.chatIdentifier ?? '',
    publicUsername: config.publicUsername ?? '',
    inviteUrl: config.inviteUrl ?? '',
    membershipRequired: config.membershipRequired,
    requiredActions: config.requiredActions.join(','),
    verifyViaTelegram: config.verifyViaTelegram,
  };
}

/**
 * `@payetam` or `-1001234567890`, or nothing.
 *
 * The two forms Telegram's `chat_id` accepts, and nothing else. A free string
 * here would be handed to `getChatMember`, and a value that is neither produces a
 * 400 on every membership check — which, with the requirement on, is every user
 * blocked by a typo.
 */
export function normalizeChatIdentifier(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  if (/^-?\d{5,20}$/.test(trimmed)) return trimmed;

  const username = trimmed.replace(/^@/, '');
  if (/^[A-Za-z0-9_]{5,32}$/.test(username)) return `@${username}`;

  throw new AppError(ErrorCode.VALIDATION_FAILED, {
    fields: [{ path: 'chatIdentifier', message: 'must be @username or a numeric chat id' }],
  });
}

/** Telegram's own rule: 5–32 of `[A-Za-z0-9_]`, no `@`. */
export function normalizeUsername(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim().replace(/^@/, '');
  if (trimmed === '') return null;
  if (!/^[A-Za-z0-9_]{5,32}$/.test(trimmed)) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, {
      fields: [{ path: 'publicUsername', message: 'must be a Telegram username' }],
    });
  }
  return trimmed;
}

/**
 * The join link, validated because the product renders it as an `href`.
 *
 * **`https://t.me/…` only.** Not `http`, so the link cannot be downgraded; not
 * `tg://`, which a browser cannot open and which no user is ever shown from; and
 * not an arbitrary host, because a configurable link the product presents as
 * "join our channel" is a phishing page with the product's credibility attached.
 * That is the SSRF/redirect surface §13 asks about, and closing it is a whitelist
 * rather than a blacklist.
 *
 * `t.me/+AbCd…` — the private invite form — is accepted, which is the whole point
 * of having a link field beside the username.
 */
export function normalizeInviteUrl(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AppError(ErrorCode.VALIDATION_FAILED, {
      fields: [{ path: 'inviteUrl', message: 'must be a URL' }],
    });
  }

  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || (host !== 't.me' && host !== 'telegram.me')) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, {
      fields: [{ path: 'inviteUrl', message: 'must be an https://t.me/… link' }],
    });
  }
  if (url.pathname === '/' || url.pathname === '') {
    throw new AppError(ErrorCode.VALIDATION_FAILED, {
      fields: [{ path: 'inviteUrl', message: 'must name a channel or an invite' }],
    });
  }

  // Rebuilt rather than echoed, so a stored link carries no query string, no
  // fragment and no credentials — three things a pasted URL can smuggle and none
  // of which a t.me join link needs.
  return `https://t.me${url.pathname}`;
}
