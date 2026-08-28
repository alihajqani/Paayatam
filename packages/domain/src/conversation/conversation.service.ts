import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConversationKind } from '@payetam/db';
import { PrismaService } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { MessageCipher } from '../chat/message-cipher';
import {
  apply,
  firstStep,
  nextStep,
  previousStep,
  progressOf,
  stepByKey,
  type WizardDefinition,
  type WizardInput,
  type WizardStep,
} from './wizard';
import { createEventWizard, type CreateEventForm } from './wizards/create-event';
import { acceptPoliciesWizard } from './wizards/accept-policies';
import { editProfileWizard } from './wizards/edit-profile';

/** How long a half-filled form survives (ADR-0017 §3). */
export const DRAFT_TTL_DAYS = 7;

/** Every wizard the bot knows, by the enum the row stores. */
const WIZARDS: Partial<Record<ConversationKind, WizardDefinition<Record<string, unknown>>>> = {
  CREATE_EVENT: createEventWizard as unknown as WizardDefinition<Record<string, unknown>>,
  EDIT_PROFILE: editProfileWizard as unknown as WizardDefinition<Record<string, unknown>>,
  ACCEPT_POLICIES: acceptPoliciesWizard as unknown as WizardDefinition<Record<string, unknown>>,
};

export interface ConversationSnapshot {
  kind: ConversationKind;
  step: string;
  form: Record<string, unknown>;
  lastMessageId: number | null;
  targetPublicId: string | null;
}

/**
 * What the caller should draw next.
 *
 * A closed set rather than a snapshot plus flags, so `BotService` handles each
 * case explicitly and adding a case fails the build there rather than falling
 * through a default.
 */
export type ConversationOutcome =
  /** Draw this step. `error` is a Persian sentence to put above the question. */
  | {
      kind: 'step';
      step: WizardStep<Record<string, unknown>>;
      snapshot: ConversationSnapshot;
      error?: string;
      position: number;
      total: number;
    }
  /** Everything required is answered: show the summary and the two buttons. */
  | { kind: 'summary'; snapshot: ConversationSnapshot }
  /** «ثبت» was pressed. The caller creates the thing and calls `finish`. */
  | { kind: 'submit'; snapshot: ConversationSnapshot }
  | { kind: 'cancelled' }
  /** The update had already been applied; redraw, change nothing. */
  | { kind: 'redelivery'; snapshot: ConversationSnapshot };

/**
 * The conversation store (ADR-0017).
 *
 * ── The three things this owns ──────────────────────────────────────────────
 *
 * **Persistence**, encrypted, with the seven-day clock on it. **Idempotency**,
 * which is `last_update_id` and is the property that replaces "the bot has no
 * memory". And **the walk** — which step is next given what has been answered,
 * delegated to the pure functions in `wizard.ts`.
 *
 * What it deliberately does *not* own is the *thing being built*. When a wizard
 * finishes, this service reports `submit` and the caller — `BotService` — calls
 * `EventService.create` with the assembled form. So no rule about what an event
 * may be lives here, and the bot creates events through exactly the path the API
 * uses. A `ConversationService` that knew how to create an event would be a
 * second, drifting copy of `EventService`.
 */
@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: MessageCipher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The caller's conversation, or null when they are not in one. */
  async current(userId: string): Promise<ConversationSnapshot | null> {
    const row = await this.prisma.conversationState.findUnique({ where: { userId } });
    return row === null ? null : this.toSnapshot(row);
  }

  /**
   * Begin a wizard, replacing whatever was in progress.
   *
   * Replacing rather than refusing: somebody who types `/create_event` while
   * half-way through another one has said what they want, and «شما در حال انجام
   * کار دیگری هستید» is the product arguing with them about a form only they can
   * see. The row is UNIQUE on `user_id`, so this is an upsert by construction.
   */
  async start(
    userId: string,
    kind: ConversationKind,
    updateId: number,
    targetPublicId: string | null = null,
  ): Promise<ConversationOutcome> {
    const definition = this.definitionFor(kind);
    const form = definition.empty();
    const step = firstStep(definition, form);
    if (step === null) throw new Error(`wizard ${kind} has no reachable first step`);

    const snapshot: ConversationSnapshot = {
      kind,
      step: step.key,
      form,
      lastMessageId: null,
      targetPublicId,
    };
    await this.save(userId, snapshot, updateId);

    const { position, total } = progressOf(definition, step.key, form);
    return { kind: 'step', step, snapshot, position, total };
  }

  /**
   * Advance the conversation with one answer.
   *
   * Returns null when the user is not in a wizard, which is how `BotService`
   * tells "text meant for a form" from "text meant for a chat relay" — the
   * distinction the whole relay depends on.
   */
  async handle(
    userId: string,
    updateId: number,
    input: WizardInput,
  ): Promise<ConversationOutcome | null> {
    const row = await this.prisma.conversationState.findUnique({ where: { userId } });
    if (row === null) return null;

    const snapshot = this.toSnapshot(row);

    /**
     * The idempotency, and the whole of it.
     *
     * Telegram retries any webhook call that did not answer 200, and `update_id`
     * is monotonic per bot. An update we have already applied must **re-render**
     * rather than advance: advancing twice skips a question, and the user is
     * looking at the answer to one they were never asked.
     */
    if (BigInt(updateId) <= row.lastUpdateId) {
      this.logger.log(`Update ${String(updateId)} is a redelivery; redrawing`);
      return { kind: 'redelivery', snapshot };
    }

    const definition = this.definitionFor(snapshot.kind);
    const step = stepByKey(definition, snapshot.step);
    if (step === null) {
      // The step key came from a deploy that no longer exists. Starting over is
      // the only honest answer; silently resuming at a different step would be
      // asking a question whose answer goes into a field that moved.
      await this.clear(userId);
      return { kind: 'cancelled' };
    }

    if (input.action === 'cancel') {
      await this.clear(userId);
      return { kind: 'cancelled' };
    }

    if (input.action === 'back') {
      const previous = previousStep(definition, step.key, snapshot.form);
      const target = previous ?? step;
      const moved = { ...snapshot, step: target.key };
      await this.save(userId, moved, updateId);
      const { position, total } = progressOf(definition, target.key, snapshot.form);
      return { kind: 'step', step: target, snapshot: moved, position, total };
    }

    /**
     * `page` and `goto` change what is *drawn*, not what is *answered* — a page
     * of cities, a month of the calendar. They advance `last_update_id` because
     * they are real updates, but they leave the step and the form alone.
     */
    if (input.action === 'page' || input.action === 'goto') {
      await this.save(userId, snapshot, updateId);
      const { position, total } = progressOf(definition, step.key, snapshot.form);
      return { kind: 'step', step, snapshot, position, total };
    }

    if (input.action === 'confirm') {
      await this.save(userId, snapshot, updateId);
      return { kind: 'submit', snapshot };
    }

    /** «افزودن جزئیات بیشتر» from the summary: open the optional half. */
    if (input.action === 'details') {
      const form = { ...snapshot.form, wantsDetails: true };
      const opened = nextStep(definition, step.key, form);
      if (opened === null) return { kind: 'summary', snapshot: { ...snapshot, form } };

      const moved = { ...snapshot, form, step: opened.key };
      await this.save(userId, moved, updateId);
      const { position, total } = progressOf(definition, opened.key, form);
      return { kind: 'step', step: opened, snapshot: moved, position, total };
    }

    const result = apply(step, input, snapshot.form);
    if (!result.ok) {
      // The step is not advanced and the update *is* consumed: a rejected answer
      // is still an answer we have seen, and re-applying it on a redelivery
      // would show the same complaint twice.
      await this.save(userId, snapshot, updateId);
      const { position, total } = progressOf(definition, step.key, snapshot.form);
      return { kind: 'step', step, snapshot, error: result.error, position, total };
    }

    const form = { ...snapshot.form, ...result.patch };
    const following = nextStep(definition, step.key, form);

    if (following === null) {
      const done = { ...snapshot, form };
      await this.save(userId, done, updateId);
      return { kind: 'summary', snapshot: done };
    }

    const moved = { ...snapshot, form, step: following.key };
    await this.save(userId, moved, updateId);
    const { position, total } = progressOf(definition, following.key, form);
    return { kind: 'step', step: following, snapshot: moved, position, total };
  }

  /** Record which message the wizard is drawn on, so the next step edits it. */
  async rememberMessage(userId: string, telegramMessageId: number): Promise<void> {
    await this.prisma.conversationState.updateMany({
      where: { userId },
      data: { lastMessageId: telegramMessageId },
    });
  }

  /** The wizard is over — submitted, cancelled, or abandoned. */
  async clear(userId: string): Promise<void> {
    await this.prisma.conversationState.deleteMany({ where: { userId } });
  }

  /**
   * Delete every draft past its seven days.
   *
   * Returns the count so the caller can log it. Run from the worker's sweep, not
   * on a request: a user pressing a button should never pay for somebody else's
   * expired form.
   */
  async purgeExpired(limit = 500): Promise<number> {
    const stale = await this.prisma.conversationState.findMany({
      where: { expiresAt: { lte: this.clock.now() } },
      select: { id: true },
      take: limit,
    });
    if (stale.length === 0) return 0;

    const { count } = await this.prisma.conversationState.deleteMany({
      where: { id: { in: stale.map((row) => row.id) } },
    });
    return count;
  }

  private definitionFor(kind: ConversationKind): WizardDefinition<Record<string, unknown>> {
    const definition = WIZARDS[kind];
    if (definition === undefined) throw new Error(`no wizard is registered for ${kind}`);
    return definition;
  }

  private async save(
    userId: string,
    snapshot: ConversationSnapshot,
    updateId: number,
  ): Promise<void> {
    const body = this.cipher.encrypt(JSON.stringify(snapshot.form));
    const expiresAt = new Date(this.clock.now().getTime() + DRAFT_TTL_DAYS * 86_400_000);

    const data = {
      kind: snapshot.kind,
      step: snapshot.step,
      formDataCiphertext: new Uint8Array(body.ciphertext),
      formDataNonce: new Uint8Array(body.nonce),
      keyVersion: body.keyVersion,
      lastMessageId: snapshot.lastMessageId,
      targetPublicId: snapshot.targetPublicId,
      lastUpdateId: BigInt(updateId),
      expiresAt,
    };

    await this.prisma.conversationState.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  }

  private toSnapshot(row: {
    kind: ConversationKind;
    step: string;
    formDataCiphertext: Uint8Array;
    formDataNonce: Uint8Array;
    keyVersion: number;
    lastMessageId: number | null;
    targetPublicId: string | null;
  }): ConversationSnapshot {
    return {
      kind: row.kind,
      step: row.step,
      form: this.decode(row),
      lastMessageId: row.lastMessageId,
      targetPublicId: row.targetPublicId,
    };
  }

  /**
   * The stored form, or an empty one.
   *
   * A draft that cannot be decrypted or parsed is not a crash: the key was
   * rotated, or a deploy changed the shape. Starting the form again costs the
   * user their typing and is recoverable; a bot that throws on `/create_event`
   * for one person until somebody notices is not.
   */
  private decode(row: {
    formDataCiphertext: Uint8Array;
    formDataNonce: Uint8Array;
    keyVersion: number;
  }): Record<string, unknown> {
    try {
      const plaintext = this.cipher.decrypt({
        ciphertext: Buffer.from(row.formDataCiphertext),
        nonce: Buffer.from(row.formDataNonce),
        keyVersion: row.keyVersion,
      });
      const parsed: unknown = JSON.parse(plaintext);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      this.logger.warn('A conversation draft could not be read; starting its form again');
      return {};
    }
  }
}

/**
 * The stored form, read as the wizard that produced it.
 *
 * No cast: every field of `CreateEventForm` is optional, so the stored shape is
 * assignable as it stands. This exists to put the caller's assumption in one
 * named place — `BotService` knows which wizard it started, and this is where it
 * says so.
 */
export function asCreateEventForm(form: Record<string, unknown>): CreateEventForm {
  return form;
}
