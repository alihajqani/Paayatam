import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConversationKind } from '@payetam/db';
import { PrismaService } from '@payetam/db';
import { CLOCK, type Clock } from '@payetam/platform';
import { isWizardControl } from '@payetam/telegram';
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
import { editEventWizard } from './wizards/edit-event';
import { editProfileWizard } from './wizards/edit-profile';
import { writeReviewWizard } from './wizards/write-review';
import { fileReportWizard } from './wizards/file-report';
import { adminCaseWizard } from './wizards/admin-case';
import { redeemCodeWizard } from './wizards/redeem-code';
import { bugReportWizard } from './wizards/bug-report';

/**
 * Where the machine records which fields the user answered.
 *
 * Underscored because it shares a namespace with the wizard's own fields and is
 * not one of them: nothing in a `WizardStep` reads or writes it.
 */
export const TOUCHED_KEY = '_touched';

/** Which of a form's fields the user actually answered, as opposed to inherited. */
export function touchedFields(form: Record<string, unknown>): Set<string> {
  const raw = form[TOUCHED_KEY];
  return new Set(Array.isArray(raw) ? (raw as string[]) : []);
}

/** How long a half-filled form survives (ADR-0017 §3). */
export const DRAFT_TTL_DAYS = 7;

/** Every wizard the bot knows, by the enum the row stores. */
const WIZARDS: Partial<Record<ConversationKind, WizardDefinition<Record<string, unknown>>>> = {
  CREATE_EVENT: createEventWizard as unknown as WizardDefinition<Record<string, unknown>>,
  EDIT_PROFILE: editProfileWizard as unknown as WizardDefinition<Record<string, unknown>>,
  WRITE_REVIEW: writeReviewWizard as unknown as WizardDefinition<Record<string, unknown>>,
  FILE_REPORT: fileReportWizard as unknown as WizardDefinition<Record<string, unknown>>,
  ACCEPT_POLICIES: acceptPoliciesWizard as unknown as WizardDefinition<Record<string, unknown>>,
  EDIT_EVENT: editEventWizard as unknown as WizardDefinition<Record<string, unknown>>,
  /**
   * A moderator's decision (ADR-0018). Registered here like every other wizard,
   * which is the point: the staff form goes through the same idempotency, the
   * same single edited message and the same seven-day sweep as a user's, and
   * **authorisation is not in it** — `BotService` resolves an admin session for
   * every step and `AdminOperationsService` asserts the permission at submit.
   */
  ADMIN_CASE: adminCaseWizard as unknown as WizardDefinition<Record<string, unknown>>,
  /**
   * A gift or referral code, typed in (v0.6.4).
   *
   * The smallest wizard here — one field — and registered rather than special
   * cased for the property the others use it for: a code typed into the chat is
   * claimed by the form instead of being relayed into an anonymous conversation,
   * which is what `handle` returning non-null buys every wizard.
   */
  REDEEM_CODE: redeemCodeWizard as unknown as WizardDefinition<Record<string, unknown>>,
  /**
   * A bug report and its screenshots (v0.6.5).
   *
   * The only wizard whose steps see `{ kind: 'photo' }` inputs. Registered here
   * like every other one, so it inherits the redelivery guard, the single edited
   * message and the seven-day sweep rather than growing its own.
   */
  BUG_REPORT: bugReportWizard as unknown as WizardDefinition<Record<string, unknown>>,
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
    /**
     * Fields the caller already knows, merged over the empty form.
     *
     * `targetPublicId` names *what* a wizard is about; this is for the rest of
     * the context a caller holds and a step cannot ask for. `FILE_REPORT` is the
     * case that needed it: a public id does not carry its table, so whether the
     * thing being reported is an event, a conversation or a user is known only
     * to the button that was tapped — and asking the user to restate it would be
     * asking them a question the product already has the answer to.
     *
     * Merged over rather than replacing, so a wizard's own defaults survive a
     * caller that seeds one field.
     */
    initialForm: Record<string, unknown> = {},
  ): Promise<ConversationOutcome> {
    const definition = this.definitionFor(kind);
    const form = { ...definition.empty(), ...initialForm };
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

    /**
     * A tap from a keyboard the conversation has moved past.
     *
     * ── Why this needs handling at all ──────────────────────────────────────
     *
     * A wizard callback names the step it was built for. Normally that is the
     * step the conversation is on — the keyboard is edited in place, so there is
     * only ever one. But an old message can still be on screen: the user
     * scrolled up, or an edit failed and a fresh message was sent, or they
     * pressed twice before the redraw landed.
     *
     * Handing that to the current step produces a refusal *about the wrong
     * field*: tapping «رایگان» from an old cost keyboard while the wizard sits on
     * the title step answers «نام فعالیت را بنویسید و بفرستید», which is
     * bewildering. Production did exactly this, and it read as «the Free button
     * is broken».
     *
     * So a mismatched step key **re-renders** instead. The update is consumed —
     * it is a real update and must not be replayed — and the user sees where
     * they actually are.
     */
    if (
      input.kind === 'callback' &&
      input.action !== undefined &&
      // A control verb belongs to no particular step — «می‌پذیرم» and «رد کردن»
      // are answers wherever they are offered.
      !isWizardControl(input.action) &&
      input.action !== step.key
    ) {
      await this.save(userId, snapshot, updateId);
      const { position, total } = progressOf(definition, step.key, snapshot.form);
      return { kind: 'step', step, snapshot, position, total };
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

    /**
     * Which fields the user has actually answered, as opposed to which the form
     * happens to hold.
     *
     * ── Why an edit wizard cannot work without this ─────────────────────────
     *
     * `EDIT_EVENT` **prefills** the draft from the event, so "the form has a
     * value" stops meaning "the user chose it". Without a record of what was
     * answered, skipping the time steps still writes the time back — and because
     * the wizard offers whole hours only, an event at 22:45 silently moves to
     * 22:00. «رد کردن» must mean *leave this as it is*, and this is what makes it
     * true.
     *
     * It lives on the form rather than in a column because it is exactly as
     * ephemeral as the form is, and it is written by the machine rather than by
     * a step so no wizard has to remember to maintain it.
     */
    const touched = new Set([
      ...(Array.isArray(snapshot.form[TOUCHED_KEY])
        ? (snapshot.form[TOUCHED_KEY] as string[])
        : []),
      ...Object.keys(result.patch),
    ]);
    const form = { ...snapshot.form, ...result.patch, [TOUCHED_KEY]: [...touched] };
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

  /**
   * Merge values into the open draft that a step could not have fetched.
   *
   * ── Why this exists ─────────────────────────────────────────────────────────
   *
   * A step's `accept` is a pure function, which is what makes it testable without
   * a database — and what stops it loading anything. `EDIT_EVENT` needs exactly
   * that: once the host picks which event, the form has to be **prefilled** with
   * what that event currently says, or the summary would offer to replace every
   * field with nothing.
   *
   * So the caller does the load and hands the result here. The alternative — an
   * async `accept` — would make every step in every wizard able to reach the
   * database to serve the one that has to, and the purity is worth more than the
   * symmetry.
   *
   * It does **not** touch `last_update_id`: this is not an update being applied,
   * it is the same update's work finishing.
   */
  async patchForm(
    userId: string,
    patch: Record<string, unknown>,
  ): Promise<ConversationSnapshot | null> {
    const row = await this.prisma.conversationState.findUnique({ where: { userId } });
    if (row === null) return null;

    const snapshot = this.toSnapshot(row);
    const merged: ConversationSnapshot = { ...snapshot, form: { ...snapshot.form, ...patch } };
    const body = this.cipher.encrypt(JSON.stringify(merged.form));

    await this.prisma.conversationState.update({
      where: { userId },
      data: {
        formDataCiphertext: new Uint8Array(body.ciphertext),
        formDataNonce: new Uint8Array(body.nonce),
        keyVersion: body.keyVersion,
      },
    });
    return merged;
  }

  /** Record which message the wizard is drawn on, so the next step edits it. */
  async rememberMessage(userId: string, telegramMessageId: number): Promise<void> {
    await this.prisma.conversationState.updateMany({
      where: { userId },
      data: { lastMessageId: telegramMessageId },
    });
  }

  /** Record what is being edited, once the picking step has answered. */
  async rememberTarget(userId: string, targetPublicId: string): Promise<void> {
    await this.prisma.conversationState.updateMany({
      where: { userId },
      data: { targetPublicId },
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
