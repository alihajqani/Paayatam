import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { PolicyStatus, PolicyType, Prisma } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { AppError, ErrorCode } from '@payetam/shared';
import { AuditService } from '../audit/audit.service';
import { policyLabel } from '../identity/consent.service';
import { isUniqueViolation } from '../identity/user.service';
import { AdminAccessService, type AdminSession } from './admin-access.service';
import { PERMISSIONS } from './permissions';

export interface PolicySummary {
  id: string;
  type: PolicyType;
  version: number;
  status: PolicyStatus;
  titleFa: string | null;
  contentMd: string;
  summaryFa: string | null;
  changeSummaryFa: string | null;
  isCurrent: boolean;
  revision: number;
  createdByAdminId: string | null;
  publishedByAdminId: string | null;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
  archivedAt: Date | null;
  acceptanceCount: number;
}

export interface ConsentRecord {
  userPublicId: string;
  policyVersionId: string;
  label: string | null;
  context: 'ONBOARDING' | 'REACCEPT' | 'CONTACT_SHARE';
  acceptedAt: Date;
  appVersion: string | null;
  requestId: string | null;
}

/**
 * Authoring the rules the product judges people by (M22 phase 8).
 *
 * `policy.manage` has been in the catalogue since M12 with nothing behind it, and
 * `tools/seed-policies.ts` — which refuses to run against production — was the
 * only way text ever reached `policy_version`. So production has whatever was
 * seeded on the first deploy and no way to change it. This is the missing half.
 *
 * ── Four rules, and each one is a property rather than a convention ──────────
 *
 * **A published version is immutable.** `updateDraft` refuses anything that is not
 * `DRAFT`, and nothing here has an UPDATE path that can reach `content_md` on a
 * published row. That is what makes a `consent` record mean something: it points
 * at text that cannot have changed since it was agreed to.
 *
 * **One current version per type, and the database says so.** Migration 0002's
 * partial unique index on `(type) WHERE is_current` is what publishing races
 * against, so two operators publishing two drafts of the same type at the same
 * moment produce one winner and one refusal rather than two current versions.
 * Migration 0021's CHECK adds that a current version must be `PUBLISHED`.
 *
 * **Publishing needs the version typed back.** Not a checkbox — an operator has to
 * read the number off the screen and repeat it, which is the cheapest defence
 * available against publishing the wrong draft on a page showing three.
 *
 * **A draft carries an optimistic-concurrency token.** Two people editing one
 * legal document is the ordinary case, and last-write-wins silently discards
 * whichever of them saved first.
 *
 * Every mutating method begins with `assertPermission` and ends with an audit
 * row, in that order, like every other service in this directory (ADR-0010 rule 2).
 */
@Injectable()
export class PolicyAdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: AdminAccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Every version of every type, newest first, drafts included.
   *
   * Behind `policy.read` rather than `policy.manage`, so support and moderation
   * can answer "what do the current terms say?" without holding the ability to
   * write new ones.
   */
  async list(
    session: AdminSession,
    filters: { type?: PolicyType; status?: PolicyStatus } = {},
  ): Promise<PolicySummary[]> {
    this.access.assertPermission(session, PERMISSIONS.POLICY_READ);

    const rows = await this.prisma.policyVersion.findMany({
      where: {
        ...(filters.type !== undefined ? { type: filters.type } : {}),
        ...(filters.status !== undefined ? { status: filters.status } : {}),
      },
      orderBy: [{ type: 'asc' }, { version: 'desc' }],
      select: POLICY_SELECT,
    });

    return rows.map(toSummary);
  }

  async get(session: AdminSession, id: string): Promise<PolicySummary> {
    this.access.assertPermission(session, PERMISSIONS.POLICY_READ);

    const row = await this.prisma.policyVersion.findUnique({
      where: { id },
      select: POLICY_SELECT,
    });
    if (row === null) throw new AppError(ErrorCode.NOT_FOUND);
    return toSummary(row);
  }

  /**
   * Start a new version of a document.
   *
   * The version number is **allocated here**, never supplied: a client that could
   * choose one could collide with a published version or skip past it, and
   * `UNIQUE (type, version)` would turn that into a constraint error rather than
   * an explanation. `MAX(version) + 1` is read and then relied on by the unique
   * index — two operators drafting the same type at the same instant collide, and
   * the loser is told to try again rather than silently overwriting.
   *
   * At most one draft per type at a time. Two open drafts of the terms is a
   * question about which one is "the" next version, and the answer would be
   * whichever got published first — which is not a decision anybody made.
   */
  async createDraft(
    session: AdminSession,
    input: {
      type: PolicyType;
      titleFa: string;
      contentMd: string;
      summaryFa?: string | undefined;
      changeSummaryFa?: string | undefined;
    },
  ): Promise<PolicySummary> {
    this.access.assertPermission(session, PERMISSIONS.POLICY_MANAGE);

    const openDraft = await this.prisma.policyVersion.findFirst({
      where: { type: input.type, status: 'DRAFT' },
      select: { id: true, version: true },
    });
    if (openDraft !== null) {
      throw new AppError(ErrorCode.POLICY_DRAFT_EXISTS, {
        draftId: openDraft.id,
        version: openDraft.version,
      });
    }

    const latest = await this.prisma.policyVersion.findFirst({
      where: { type: input.type },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;

    const now = this.clock.now();
    let created;
    try {
      created = await this.prisma.policyVersion.create({
        data: {
          type: input.type,
          version,
          status: 'DRAFT',
          titleFa: input.titleFa,
          contentMd: input.contentMd,
          summaryFa: input.summaryFa ?? null,
          changeSummaryFa: input.changeSummaryFa ?? null,
          isCurrent: false,
          // A draft has not been published, and `published_at` is NOT NULL with a
          // `now()` default. Writing the creation time keeps the column honest —
          // `status` is what says whether it has been published, not this.
          publishedAt: now,
          createdAt: now,
          updatedAt: now,
          createdByAdminId: session.adminUserId,
        },
        select: POLICY_SELECT,
      });
    } catch (error) {
      // `UNIQUE (type, version)`: somebody else allocated the same number between
      // the read above and this insert.
      if (isUniqueViolation(error)) throw new AppError(ErrorCode.CONFLICT_STALE_VERSION);
      throw error;
    }

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: 'policy.draft_created',
      targetType: 'policy_version',
      targetId: created.id,
      after: auditShape(created),
    });

    return toSummary(created);
  }

  /**
   * Edit a draft.
   *
   * Refuses anything that is not `DRAFT`, which is where "a published version is
   * immutable" actually lives — there is no other write path to `content_md`.
   *
   * `expectedRevision` is checked in the same `UPDATE` that increments it, as a
   * `WHERE` clause rather than a read-then-write. A read-then-write has a window;
   * a conditional update has none, and `count === 0` is the whole conflict
   * detection.
   */
  async updateDraft(
    session: AdminSession,
    id: string,
    input: {
      expectedRevision: number;
      titleFa?: string | undefined;
      contentMd?: string | undefined;
      summaryFa?: string | null | undefined;
      changeSummaryFa?: string | null | undefined;
    },
  ): Promise<PolicySummary> {
    this.access.assertPermission(session, PERMISSIONS.POLICY_MANAGE);

    const before = await this.prisma.policyVersion.findUnique({
      where: { id },
      select: POLICY_SELECT,
    });
    if (before === null) throw new AppError(ErrorCode.NOT_FOUND);
    if (before.status !== 'DRAFT') throw new AppError(ErrorCode.POLICY_NOT_EDITABLE);

    const data: Prisma.PolicyVersionUpdateManyMutationInput = {
      revision: { increment: 1 },
      updatedAt: this.clock.now(),
    };
    if (input.titleFa !== undefined) data.titleFa = input.titleFa;
    if (input.contentMd !== undefined) data.contentMd = input.contentMd;
    if (input.summaryFa !== undefined) data.summaryFa = input.summaryFa;
    if (input.changeSummaryFa !== undefined) data.changeSummaryFa = input.changeSummaryFa;

    const { count } = await this.prisma.policyVersion.updateMany({
      // Status is re-checked here as well as above: between the read and this
      // write, somebody else may have published it.
      where: { id, status: 'DRAFT', revision: input.expectedRevision },
      data,
    });
    if (count === 0) throw new AppError(ErrorCode.CONFLICT_STALE_VERSION);

    const after = await this.prisma.policyVersion.findUniqueOrThrow({
      where: { id },
      select: POLICY_SELECT,
    });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: 'policy.draft_updated',
      targetType: 'policy_version',
      targetId: id,
      before: auditShape(before),
      after: auditShape(after),
    });

    return toSummary(after);
  }

  /**
   * Make a draft the version users must accept.
   *
   * The legally significant act, and behind its own permission for that reason:
   * `policy.manage` writes drafts, `policy.publish` changes what every user is
   * being asked to agree to.
   *
   * One transaction doing three things that must all be true together: the
   * previously current version of this type stops being current, this one becomes
   * current and `PUBLISHED`, and the audit row records who signed for it. A crash
   * between the first two would leave a type with **no** current version, which
   * `ConsentService` reads as "nothing can be accepted" and refuses onboarding
   * over.
   *
   * Historical versions are not touched. Superseding is `is_current = false`, not
   * an edit and not a delete — every `consent` row still points at the exact text
   * that was agreed to.
   */
  async publish(
    session: AdminSession,
    id: string,
    input: { confirmVersion: number; reason: string },
  ): Promise<PolicySummary> {
    this.access.assertPermission(session, PERMISSIONS.POLICY_PUBLISH);
    if (input.reason.trim().length < 3) throw new AppError(ErrorCode.VALIDATION_FAILED);

    const now = this.clock.now();

    const published = await this.prisma.$transaction(async (tx) => {
      const draft = await tx.policyVersion.findUnique({
        where: { id },
        select: POLICY_SELECT,
      });
      if (draft === null) throw new AppError(ErrorCode.NOT_FOUND);
      if (draft.status !== 'DRAFT') throw new AppError(ErrorCode.POLICY_NOT_EDITABLE);

      // The typed-back version. Checked before anything is written, because the
      // whole point is that the operator meant *this* row.
      if (draft.version !== input.confirmVersion) {
        throw new AppError(ErrorCode.POLICY_CONFIRMATION_MISMATCH, {
          expected: draft.version,
        });
      }
      // Publishing empty text would be publishing nothing while telling every user
      // they had agreed to something.
      if (draft.contentMd.trim().length === 0) throw new AppError(ErrorCode.VALIDATION_FAILED);

      // Clear the incumbent first: the partial unique index on `(type) WHERE
      // is_current` refuses two, so the order is not a preference.
      await tx.policyVersion.updateMany({
        where: { type: draft.type, isCurrent: true },
        data: { isCurrent: false },
      });

      await tx.policyVersion.update({
        where: { id },
        data: {
          status: 'PUBLISHED',
          isCurrent: true,
          publishedAt: now,
          updatedAt: now,
          publishedByAdminId: session.adminUserId,
          revision: { increment: 1 },
        },
      });

      const after = await tx.policyVersion.findUniqueOrThrow({
        where: { id },
        select: POLICY_SELECT,
      });

      await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: session.adminUserId,
          action: 'policy.published',
          targetType: 'policy_version',
          targetId: id,
          before: auditShape(draft),
          after: { ...auditShape(after), reason: input.reason.trim() },
        },
        tx,
      );

      return after;
    });

    return toSummary(published);
  }

  /**
   * Retire a version nobody should be shown any more.
   *
   * **The current version cannot be archived**, and that refusal is the important
   * one: archiving it would leave the type with no current version, which
   * `ConsentService` reads as "nothing can be accepted" — every new user would be
   * unable to finish onboarding. Publish a replacement instead.
   *
   * Archiving changes nothing about the past. Consent rows still point at the row,
   * and they snapshot the label as well, so the evidence survives even a reader
   * who filters archived versions out.
   */
  async archive(session: AdminSession, id: string, reason: string): Promise<PolicySummary> {
    this.access.assertPermission(session, PERMISSIONS.POLICY_PUBLISH);
    if (reason.trim().length < 3) throw new AppError(ErrorCode.VALIDATION_FAILED);

    const before = await this.prisma.policyVersion.findUnique({
      where: { id },
      select: POLICY_SELECT,
    });
    if (before === null) throw new AppError(ErrorCode.NOT_FOUND);
    if (before.isCurrent) throw new AppError(ErrorCode.POLICY_IS_CURRENT);
    if (before.status === 'ARCHIVED') throw new AppError(ErrorCode.INVALID_STATE_TRANSITION);

    const now = this.clock.now();
    await this.prisma.policyVersion.update({
      where: { id },
      data: { status: 'ARCHIVED', archivedAt: now, updatedAt: now, revision: { increment: 1 } },
    });

    const after = await this.prisma.policyVersion.findUniqueOrThrow({
      where: { id },
      select: POLICY_SELECT,
    });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: session.adminUserId,
      action: 'policy.archived',
      targetType: 'policy_version',
      targetId: id,
      before: auditShape(before),
      after: { ...auditShape(after), reason: reason.trim() },
    });

    return toSummary(after);
  }

  /**
   * Who accepted what, and when (M22 phase 8).
   *
   * Behind `policy.consent.read` rather than `policy.read`, because this is
   * per-user evidence: "did this person accept v3?" is a question about a person,
   * and reading the current terms is not.
   *
   * The projection carries **`public_id` only** — no internal id, no Telegram id,
   * no IP. `ip_hash` and `user_agent_hash` exist on the row and are deliberately
   * absent here: they are an HMAC kept for abuse investigation, and putting them
   * on a screen would make them a value somebody could correlate across users.
   */
  async listConsents(
    session: AdminSession,
    filters: {
      policyVersionId?: string | undefined;
      userPublicId?: string | undefined;
      limit?: number | undefined;
      offset?: number | undefined;
    } = {},
  ): Promise<{ rows: ConsentRecord[]; total: number }> {
    this.access.assertPermission(session, PERMISSIONS.POLICY_CONSENT_READ);

    const where: Prisma.ConsentWhereInput = {
      ...(filters.policyVersionId !== undefined
        ? { policyVersionId: filters.policyVersionId }
        : {}),
      ...(filters.userPublicId !== undefined ? { user: { publicId: filters.userPublicId } } : {}),
    };

    const take = Math.min(Math.max(filters.limit ?? 50, 1), 200);

    const [rows, total] = await Promise.all([
      this.prisma.consent.findMany({
        where,
        orderBy: { acceptedAt: 'desc' },
        take,
        skip: Math.max(filters.offset ?? 0, 0),
        select: {
          policyVersionId: true,
          policyVersionLabel: true,
          context: true,
          acceptedAt: true,
          appVersion: true,
          requestId: true,
          user: { select: { publicId: true } },
          policyVersion: { select: { type: true, version: true } },
        },
      }),
      this.prisma.consent.count({ where }),
    ]);

    return {
      rows: rows.map((row) => ({
        userPublicId: row.user.publicId,
        policyVersionId: row.policyVersionId,
        // The snapshot when there is one, and the join for the rows written before
        // M22 added the column. Never neither.
        label:
          row.policyVersionLabel ?? policyLabel(row.policyVersion.type, row.policyVersion.version),
        context: row.context,
        acceptedAt: row.acceptedAt,
        appVersion: row.appVersion,
        requestId: row.requestId,
      })),
      total,
    };
  }
}

const POLICY_SELECT = {
  id: true,
  type: true,
  version: true,
  status: true,
  titleFa: true,
  contentMd: true,
  summaryFa: true,
  changeSummaryFa: true,
  isCurrent: true,
  revision: true,
  createdByAdminId: true,
  publishedByAdminId: true,
  createdAt: true,
  updatedAt: true,
  publishedAt: true,
  archivedAt: true,
  _count: { select: { consents: true } },
} as const;

type PolicyRow = Prisma.PolicyVersionGetPayload<{ select: typeof POLICY_SELECT }>;

function toSummary(row: PolicyRow): PolicySummary {
  return {
    id: row.id,
    type: row.type,
    version: row.version,
    status: row.status,
    titleFa: row.titleFa,
    contentMd: row.contentMd,
    summaryFa: row.summaryFa,
    changeSummaryFa: row.changeSummaryFa,
    isCurrent: row.isCurrent,
    revision: row.revision,
    createdByAdminId: row.createdByAdminId,
    publishedByAdminId: row.publishedByAdminId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    publishedAt: row.status === 'DRAFT' ? null : row.publishedAt,
    archivedAt: row.archivedAt,
    acceptanceCount: row._count.consents,
  };
}

/**
 * What goes in the audit row.
 *
 * The **length** of the content rather than the content. A legal document is up to
 * 60 kB and `audit_log` is a table staff export; copying two of them into every
 * edit would make the trail unreadable and the exports enormous. The version row
 * itself is immutable once published, so the text is always recoverable from the
 * thing the row points at — which is a stronger guarantee than a copy.
 */
function auditShape(row: PolicyRow): Record<string, Prisma.InputJsonValue> {
  return {
    type: row.type,
    version: row.version,
    status: row.status,
    titleFa: row.titleFa ?? '',
    isCurrent: row.isCurrent,
    revision: row.revision,
    contentLength: row.contentMd.length,
    label: policyLabel(row.type, row.version),
  };
}
