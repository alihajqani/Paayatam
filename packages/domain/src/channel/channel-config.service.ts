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
 *
 * `APP_ACCESS` is v0.3.1's addition and it is the odd one out, so it is worth
 * being explicit about what enforces it. The other four are enforced **in the
 * service that owns the operation** — `EventService.create`, `publishToChannel`,
 * `ParticipationService.join`, `InvitationService.inviteTop` — and no client can
 * talk its way past them. `APP_ACCESS` has no single operation behind it: it
 * means "do not let this person browse the Mini App at all", which is a
 * *navigation* rule, so the Mini App's router enforces it and
 * `GET /me/channel-membership` is what the router asks.
 *
 * It is deliberately **not** wired into `AuthGuard`. A gate over every
 * authenticated route would also refuse `/me`, `/me/policies` and the membership
 * check itself — the three calls the screen that clears the gate is built from —
 * so switching it on would lock the product shut with no way back. The practical
 * consequence is stated rather than hidden: somebody who bypasses the Mini App
 * can still read what the API exposes, and is still refused every one of the four
 * real operations the moment they attempt one.
 */
export const GATED_ACTIONS = [
  'APP_ACCESS',
  'EVENT_CREATE',
  'EVENT_JOIN',
  'EVENT_CHANNEL_SEND',
  'EVENT_INVITE',
] as const;
export type GatedAction = (typeof GATED_ACTIONS)[number];

/** The global switches. Which channels there are is `RequiredChannelRecord[]`. */
export interface ChannelConfig {
  membershipRequired: boolean;
  requiredActions: GatedAction[];
  verifyViaTelegram: boolean;
  updatedAt: Date;
}

/**
 * One channel a user can be asked to join.
 *
 * `joinUrl` is derived rather than stored: the invite link when there is one, the
 * `https://t.me/<username>` form when there is not, and null when neither — which
 * the CHECK on `required_channel` makes unreachable for an active row, but the
 * type still says so, because a null here is a button pointing nowhere and the
 * client has to be able to see that coming.
 */
export interface RequiredChannelRecord {
  id: string;
  title: string;
  chatIdentifier: string | null;
  publicUsername: string | null;
  inviteUrl: string | null;
  joinUrl: string | null;
  sortOrder: number;
  isActive: boolean;
}

/**
 * Why switching the requirement on right now would be a bad idea.
 *
 * A closed union rather than `string[]`, so the panel's Persian lookup is total
 * and the wire contract cannot drift from what this file produces.
 */
export type ChannelConfigWarning =
  'NO_CHANNELS' | 'NO_JOIN_LINK' | 'NO_CHAT_IDENTIFIER' | 'NO_ACTIONS_SELECTED';

/** Whether the configuration is complete enough to be switched on safely. */
export interface ChannelConfigStatus extends ChannelConfig {
  /** Active channels, in the order they are to be joined and displayed. */
  channels: RequiredChannelRecord[];
  /** Every channel, active or not — the panel's list. */
  allChannels: RequiredChannelRecord[];
  /** There is at least one active channel, and every one has somewhere to go. */
  hasJoinLink: boolean;
  /** Every active channel carries an identifier Telegram can be asked about. */
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

/** Sparse, so a channel can be slotted between two others without a rewrite. */
const SORT_STEP = 10;

/**
 * The channels users can be required to join, and whether they are (v0.3.1).
 *
 * ── What is here and what is not ─────────────────────────────────────────────
 *
 * `TELEGRAM_CHANNEL_ID` stays an environment variable and is untouched by this:
 * it is where the *bot* posts, and a destination editable from a web session is a
 * destination an attacker with a session can redirect. What this holds is
 * @usernames, invite links and the requirement — none of it secret, all of it
 * something an operator needs to change without a deploy.
 *
 * **No token is stored, read or returned by anything in this file.**
 *
 * ── One channel became several ───────────────────────────────────────────────
 *
 * v0.3.0 kept the channel on the settings singleton, which can describe exactly
 * one. Migration 0024 moved the channels into `required_channel` — ordered,
 * because the requirement states that the order of joining and of display
 * matters — and left the singleton holding only what is global. Its three
 * per-channel columns still exist and are no longer read by anything; dropping
 * them would have been a destructive statement in a feature release.
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
   * The global switches.
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
        membershipRequired: false,
        requiredActions: [],
        verifyViaTelegram: true,
        updatedAt: this.clock.now(),
      };
    }

    return {
      membershipRequired: row.membershipRequired,
      requiredActions: row.requiredActions.filter(isGatedAction),
      verifyViaTelegram: row.verifyViaTelegram,
      updatedAt: row.updatedAt,
    };
  }

  /** Active channels, in join order. What the gate and the Mini App read. */
  async activeChannels(): Promise<RequiredChannelRecord[]> {
    const rows = await this.prisma.requiredChannel.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toRecord);
  }

  /** Every channel, active or not. What the panel lists. */
  async listChannels(): Promise<RequiredChannelRecord[]> {
    const rows = await this.prisma.requiredChannel.findMany({
      orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toRecord);
  }

  async status(): Promise<ChannelConfigStatus> {
    const [config, allChannels] = await Promise.all([this.get(), this.listChannels()]);
    const channels = allChannels.filter((channel) => channel.isActive);

    const hasJoinLink = channels.length > 0 && channels.every((c) => c.joinUrl !== null);
    const canVerify = channels.length > 0 && channels.every((c) => c.chatIdentifier !== null);

    const warnings: ChannelConfigWarning[] = [];
    if (channels.length === 0) warnings.push('NO_CHANNELS');
    else if (!hasJoinLink) warnings.push('NO_JOIN_LINK');
    if (channels.length > 0 && config.verifyViaTelegram && !canVerify) {
      warnings.push('NO_CHAT_IDENTIFIER');
    }
    if (config.membershipRequired && config.requiredActions.length === 0) {
      warnings.push('NO_ACTIONS_SELECTED');
    }

    return { ...config, channels, allChannels, hasJoinLink, canVerify, warnings };
  }

  /**
   * Change the global switches. Every field is optional; an absent one is left alone.
   *
   * Turning the requirement on with nowhere to send people is refused outright.
   * That is the one warning `status()` reports which is also an error here: every
   * other misconfiguration degrades, and this one locks users out of a product
   * with no way forward on the screen.
   */
  async update(
    adminUserId: string,
    input: {
      membershipRequired?: boolean | undefined;
      requiredActions?: GatedAction[] | undefined;
      verifyViaTelegram?: boolean | undefined;
    },
  ): Promise<ChannelConfigStatus> {
    const before = await this.get();

    const membershipRequired = input.membershipRequired ?? before.membershipRequired;
    const requiredActions = input.requiredActions ?? before.requiredActions;

    if (membershipRequired) {
      const channels = await this.activeChannels();
      if (channels.length === 0 || channels.some((channel) => channel.joinUrl === null)) {
        throw new AppError(ErrorCode.CHANNEL_NOT_CONFIGURED, { reason: 'NO_JOIN_LINK' });
      }
    }

    await this.prisma.eventChannelConfig.upsert({
      where: { id: CHANNEL_CONFIG_ID },
      create: {
        id: CHANNEL_CONFIG_ID,
        membershipRequired,
        requiredActions,
        verifyViaTelegram: input.verifyViaTelegram ?? before.verifyViaTelegram,
        updatedByAdminId: adminUserId,
        updatedAt: this.clock.now(),
      },
      update: {
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

  // ── the channels themselves ────────────────────────────────────────────────

  /**
   * Add a channel.
   *
   * Appended to the end of the order rather than inserted anywhere clever: the
   * operator reorders afterwards if they care, and guessing would be a surprise.
   *
   * The link is **normalised and validated** rather than stored as typed, and that
   * is a security control rather than tidiness: this value is rendered as an
   * `href` in a button every user sees, so an unvalidated one is a phishing link
   * the product would be hosting. Only `https://t.me/…` is accepted.
   */
  async createChannel(
    adminUserId: string,
    input: {
      title: string;
      chatIdentifier?: string | null | undefined;
      publicUsername?: string | null | undefined;
      inviteUrl?: string | null | undefined;
      isActive?: boolean | undefined;
    },
  ): Promise<RequiredChannelRecord> {
    const title = normalizeTitle(input.title);
    const chatIdentifier = normalizeChatIdentifier(input.chatIdentifier ?? null);
    const publicUsername = normalizeUsername(input.publicUsername ?? null);
    const inviteUrl = normalizeInviteUrl(input.inviteUrl ?? null);

    assertReachable(inviteUrl, publicUsername);
    await this.assertNotDuplicate(chatIdentifier, null);

    const last = await this.prisma.requiredChannel.findFirst({
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });

    const created = await this.prisma.requiredChannel.create({
      data: {
        title,
        chatIdentifier,
        publicUsername,
        inviteUrl,
        sortOrder: (last?.sortOrder ?? 0) + SORT_STEP,
        isActive: input.isActive ?? true,
        updatedByAdminId: adminUserId,
        updatedAt: this.clock.now(),
      },
    });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: adminUserId,
      action: 'channel.required_channel_created',
      targetType: 'required_channel',
      targetId: created.id,
      after: channelAuditShape(toRecord(created)),
    });

    return toRecord(created);
  }

  /**
   * Change one. Every field is optional; an absent one is left alone.
   *
   * Deactivating the last channel while the requirement is on is refused for the
   * same reason turning the requirement on with no channel is: it leaves a gate
   * with nothing behind it, and the failure is silent.
   */
  async updateChannel(
    adminUserId: string,
    id: string,
    input: {
      title?: string | undefined;
      chatIdentifier?: string | null | undefined;
      publicUsername?: string | null | undefined;
      inviteUrl?: string | null | undefined;
      isActive?: boolean | undefined;
    },
  ): Promise<RequiredChannelRecord> {
    const existing = await this.prisma.requiredChannel.findUnique({ where: { id } });
    if (existing === null) throw new AppError(ErrorCode.NOT_FOUND);
    const before = toRecord(existing);

    const title = input.title === undefined ? before.title : normalizeTitle(input.title);
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
    const isActive = input.isActive ?? before.isActive;

    if (isActive) {
      assertReachable(inviteUrl, publicUsername);
      await this.assertNotDuplicate(chatIdentifier, id);
    } else if (before.isActive) {
      await this.assertNotLastActive(id);
    }

    const updated = await this.prisma.requiredChannel.update({
      where: { id },
      data: {
        title,
        chatIdentifier,
        publicUsername,
        inviteUrl,
        isActive,
        updatedByAdminId: adminUserId,
        updatedAt: this.clock.now(),
      },
    });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: adminUserId,
      action: 'channel.required_channel_updated',
      targetType: 'required_channel',
      targetId: id,
      before: channelAuditShape(before),
      after: channelAuditShape(toRecord(updated)),
    });

    return toRecord(updated);
  }

  /**
   * Remove one.
   *
   * A real delete, unlike deactivation: an operator who added the wrong channel
   * wants it gone rather than greyed out, and nothing references these rows. The
   * audit entry is what survives.
   */
  async deleteChannel(adminUserId: string, id: string): Promise<void> {
    const existing = await this.prisma.requiredChannel.findUnique({ where: { id } });
    if (existing === null) throw new AppError(ErrorCode.NOT_FOUND);

    if (existing.isActive) await this.assertNotLastActive(id);

    await this.prisma.requiredChannel.delete({ where: { id } });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: adminUserId,
      action: 'channel.required_channel_deleted',
      targetType: 'required_channel',
      targetId: id,
      before: channelAuditShape(toRecord(existing)),
    });
  }

  /**
   * Set the order, from a list of ids.
   *
   * The whole order at once rather than a move-up/move-down pair: the panel holds
   * the list the operator is looking at, and sending it back is the one
   * formulation that cannot produce an order neither side intended. Ids the list
   * omits keep their position after everything named, because they sort after the
   * highest number this assigns.
   */
  async reorderChannels(adminUserId: string, ids: string[]): Promise<RequiredChannelRecord[]> {
    const known = await this.prisma.requiredChannel.findMany({ select: { id: true } });
    const knownIds = new Set(known.map((row) => row.id));

    for (const id of ids) {
      if (!knownIds.has(id)) throw new AppError(ErrorCode.NOT_FOUND);
    }
    if (new Set(ids).size !== ids.length) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        fields: [{ path: 'ids', message: 'must not repeat a channel' }],
      });
    }

    const now = this.clock.now();
    await this.prisma.$transaction(
      ids.map((id, index) =>
        this.prisma.requiredChannel.update({
          where: { id },
          data: {
            sortOrder: (index + 1) * SORT_STEP,
            updatedByAdminId: adminUserId,
            updatedAt: now,
          },
        }),
      ),
    );

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: adminUserId,
      action: 'channel.required_channels_reordered',
      targetType: 'required_channel',
      targetId: CHANNEL_CONFIG_ID,
      after: { order: ids.join(',') },
    });

    return this.listChannels();
  }

  /**
   * Two active rows for one Telegram chat would give a user two join buttons for
   * one membership, and the second would never turn green.
   *
   * Checked here as well as by the partial unique index, so the operator gets a
   * Persian sentence rather than a constraint violation.
   */
  private async assertNotDuplicate(
    chatIdentifier: string | null,
    excludeId: string | null,
  ): Promise<void> {
    if (chatIdentifier === null) return;

    const clash = await this.prisma.requiredChannel.findFirst({
      where: {
        chatIdentifier,
        isActive: true,
        ...(excludeId === null ? {} : { id: { not: excludeId } }),
      },
      select: { id: true },
    });
    if (clash !== null) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        fields: [{ path: 'chatIdentifier', message: 'this channel is already required' }],
      });
    }
  }

  /**
   * Removing the last channel while the requirement is on leaves a gate with
   * nothing behind it — the user is told to join something and shown no button.
   *
   * Refused rather than silently switching the requirement off: an operator who
   * meant to stop requiring membership should say so, and the panel's own switch
   * is one click away.
   */
  private async assertNotLastActive(id: string): Promise<void> {
    const config = await this.get();
    if (!config.membershipRequired) return;

    const others = await this.prisma.requiredChannel.count({
      where: { isActive: true, id: { not: id } },
    });
    if (others === 0) {
      throw new AppError(ErrorCode.CHANNEL_NOT_CONFIGURED, { reason: 'LAST_ACTIVE_CHANNEL' });
    }
  }
}

function isGatedAction(value: string): value is GatedAction {
  return (GATED_ACTIONS as readonly string[]).includes(value);
}

/** The wire-ish shape, from a row. An allowlist, never a spread (§3.6 layer 2). */
function toRecord(row: {
  id: string;
  title: string;
  chatIdentifier: string | null;
  publicUsername: string | null;
  inviteUrl: string | null;
  sortOrder: number;
  isActive: boolean;
}): RequiredChannelRecord {
  return {
    id: row.id,
    title: row.title,
    chatIdentifier: row.chatIdentifier,
    publicUsername: row.publicUsername,
    inviteUrl: row.inviteUrl,
    joinUrl:
      row.inviteUrl ?? (row.publicUsername === null ? null : `https://t.me/${row.publicUsername}`),
    sortOrder: row.sortOrder,
    isActive: row.isActive,
  };
}

function auditShape(config: ChannelConfig): Record<string, string | boolean> {
  return {
    membershipRequired: config.membershipRequired,
    requiredActions: config.requiredActions.join(','),
    verifyViaTelegram: config.verifyViaTelegram,
  };
}

function channelAuditShape(channel: RequiredChannelRecord): Record<string, string | boolean> {
  return {
    title: channel.title,
    chatIdentifier: channel.chatIdentifier ?? '',
    publicUsername: channel.publicUsername ?? '',
    inviteUrl: channel.inviteUrl ?? '',
    sortOrder: String(channel.sortOrder),
    isActive: channel.isActive,
  };
}

/** A channel with nowhere to send anybody is a join button pointing nowhere. */
function assertReachable(inviteUrl: string | null, publicUsername: string | null): void {
  if (inviteUrl === null && publicUsername === null) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, {
      fields: [{ path: 'inviteUrl', message: 'a channel needs an invite link or a username' }],
    });
  }
}

/** Shown above the join button, so it has to be something a person wrote. */
export function normalizeTitle(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > 60) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, {
      fields: [{ path: 'title', message: 'must be between 2 and 60 characters' }],
    });
  }
  return trimmed;
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
