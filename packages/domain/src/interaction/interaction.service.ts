import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@payetam/db';
import type { InteractionKind, InteractionOutcome } from '@payetam/shared';

/** One handled update, as `bot_interaction` stores it. */
export interface InteractionRecord {
  /** Telegram's update id — the idempotency key. */
  updateId: number;
  /** The internal user id, or null when the sender has no usable account. */
  userId: string | null;
  kind: InteractionKind;
  action: string;
  ref: string | null;
  createdAccount: boolean;
  messageId: number | null;
  wizardKind: string | null;
  wizardStep: string | null;
  /** The form this update submitted, whatever was drawn afterwards. */
  finishedWizard: string | null;
  outcome: InteractionOutcome;
  detail: string | null;
  screen: string | null;
  durationMs: number;
}

/**
 * The one writer of `bot_interaction` (migration 0065).
 *
 * ── It cannot fail an update ────────────────────────────────────────────────
 *
 * `record` resolves `false` instead of throwing, whatever the database says.
 * The caller is `BotService.dispatch`, which has already answered the person by
 * the time it gets here; a counter that could turn a delivered reply into a
 * failed webhook call would be the report breaking the product it reports on.
 * What is lost when it fails is one row, and an error line says so.
 *
 * ── Redelivery ──────────────────────────────────────────────────────────────
 *
 * `update_id` is UNIQUE and the insert skips duplicates, so Telegram retrying
 * an update writes nothing the second time. The first row wins: it is what the
 * person actually saw happen.
 *
 * ── What it does not check ──────────────────────────────────────────────────
 *
 * That `action`, `ref`, `detail` and `screen` are names rather than something
 * somebody typed. The table's CHECK constraints do, and a row that fails one is
 * refused here like any other database error — a lost count, never a stored
 * message.
 */
@Injectable()
export class InteractionService {
  private readonly logger = new Logger(InteractionService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** True when a row was written; false for a redelivery or a refused row. */
  async record(interaction: InteractionRecord): Promise<boolean> {
    try {
      const written = await this.prisma.botInteraction.createMany({
        data: [
          {
            updateId: BigInt(interaction.updateId),
            userId: interaction.userId,
            kind: interaction.kind,
            action: interaction.action,
            ref: interaction.ref,
            createdAccount: interaction.createdAccount,
            messageId: interaction.messageId,
            wizardKind: interaction.wizardKind,
            wizardStep: interaction.wizardStep,
            finishedWizard: interaction.finishedWizard,
            outcome: interaction.outcome,
            detail: interaction.detail,
            screen: interaction.screen,
            durationMs: Math.max(0, Math.round(interaction.durationMs)),
          },
        ],
        skipDuplicates: true,
      });
      return written.count === 1;
    } catch (error) {
      this.logger.error(
        `Interaction for update ${String(interaction.updateId)} was not recorded: ${describeFailure(error)}`,
      );
      return false;
    }
  }
}

/**
 * What kind of failure it was, and nothing of what was being written.
 *
 * The error's class and Prisma's own code, which is enough to tell a refused
 * constraint from a database that could not be reached. **Never the message:**
 * a constraint error can quote the row, and a row refused for holding
 * somebody's text must not be copied into a log line on its way out.
 */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? `${error.constructor.name} ${code}` : error.constructor.name;
}
