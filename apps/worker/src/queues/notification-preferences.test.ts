import { describe, expect, it, vi } from 'vitest';
import { TEMPLATES } from '@payetam/telegram';
import { Processors } from './processors.service';

/**
 * The property that makes settings real rather than decorative.
 *
 * A preference nothing reads is a lie told in a settings screen, so this asserts
 * the one thing that matters: an opted-out category does not reach Telegram, and
 * an essential one does regardless.
 *
 * ── Why the check is at delivery ────────────────────────────────────────────
 *
 * The notification row is written either way. A preference is about delivery,
 * not about whether the product had something to say — «did we tell them?» six
 * weeks later should answer "we had this, and they had asked us not to" rather
 * than leaving no trace. Checking at enqueue would also mean changing a
 * preference could not affect anything already queued.
 */
function buildProcessors(options: {
  templateKey: string;
  notifyChat?: boolean;
  notifyEvents?: boolean;
  /** Whether this recipient's Telegram account is linked to a staff member. */
  linkedModerator?: boolean;
}): {
  processors: Processors;
  send: ReturnType<typeof vi.fn>;
  markSuppressed: ReturnType<typeof vi.fn>;
  isLinked: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockResolvedValue({ kind: 'SENT', messageId: 1 });
  const markSuppressed = vi.fn().mockResolvedValue(undefined);

  const notifications = {
    load: vi.fn().mockResolvedValue({
      id: 'n-1',
      userId: 'u-1',
      templateKey: options.templateKey,
      payload: { text: 'x', balance: 0 },
      telegramUserId: 573_914_882n,
      botBlocked: false,
    }),
    markSuppressed,
    markSent: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    markUndeliverable: vi.fn().mockResolvedValue(undefined),
  };

  const userSettings = {
    get: vi.fn().mockResolvedValue({
      notifyChat: options.notifyChat ?? true,
      notifyEvents: options.notifyEvents ?? true,
      notifyCampaigns: true,
    }),
  };

  const isLinked = vi.fn().mockResolvedValue(options.linkedModerator ?? false);
  const adminTelegram = { isLinked };

  const processors = new Processors(
    {} as never, // WorkerFactory
    {} as never, // QueueService
    {} as never, // OutboxRelayService
    notifications as never,
    userSettings as never,
    { send, botUsername: 'paayatambot' } as never,
    {} as never, // ParticipationService
    {} as never, // EventLifecycleService
    {} as never, // ReviewService
    {} as never, // ChannelService
    {} as never, // RetentionService
    {} as never, // MessagingService
    // ReleaseAnnouncementService: only `onModuleInit` reaches it, and no suite
    // here boots the module.
    {} as never,
    {} as never, // InvitationService
    {} as never, // MetricsRegistry
    {} as never, // CoinService
    {} as never, // TelegramLoggerService
    {} as never, // ConversationService
    {} as never, // HostRewardService
    {} as never, // ComebackService
    adminTelegram as never,
    {} as never, // ModerationDigestService
  );

  return { processors, send, markSuppressed, isLinked };
}

/** `onSend` is private; the job is what the queue hands it. */
async function runSend(processors: Processors): Promise<void> {
  const onSend = (processors as unknown as { onSend: (job: unknown) => Promise<void> }).onSend.bind(
    processors,
  );
  await onSend({ data: { notificationId: 'n-1' } });
}

describe('notification preferences', () => {
  it('does not send a direct message to somebody who turned messages off', async () => {
    const { processors, send, markSuppressed } = buildProcessors({
      templateKey: TEMPLATES.DIRECT_MESSAGE_RECEIVED,
      notifyChat: false,
    });

    await runSend(processors);

    expect(send).not.toHaveBeenCalled();
    expect(markSuppressed).toHaveBeenCalledWith('n-1');
  });

  it('still sends one to somebody who left them on', async () => {
    const { processors, send } = buildProcessors({
      templateKey: TEMPLATES.DIRECT_MESSAGE_RECEIVED,
    });

    await runSend(processors);

    expect(send).toHaveBeenCalledOnce();
  });

  /**
   * One preference silences one category. Turning off direct messages must not
   * stop an activity being cancelled under somebody.
   */
  it('does not let one preference silence another category', async () => {
    const { processors, send } = buildProcessors({
      templateKey: TEMPLATES.EVENT_CANCELLED,
      notifyChat: false,
    });

    await runSend(processors);

    expect(send).toHaveBeenCalledOnce();
  });

  /**
   * A preference silences things the product decided to send. It never silences
   * something somebody is entitled to know — a preference that could suppress
   * `CONTENT_HIDDEN` would hide a moderation decision from its subject.
   */
  it('never suppresses a moderation outcome, whatever is switched off', async () => {
    const { processors, send, markSuppressed } = buildProcessors({
      templateKey: TEMPLATES.CONTENT_HIDDEN,
      notifyChat: false,
      notifyEvents: false,
    });

    await runSend(processors);

    expect(send).toHaveBeenCalledOnce();
    expect(markSuppressed).not.toHaveBeenCalled();
  });

  /**
   * Nor an answer to something the user just did: somebody who turned off
   * campaigns a month ago and sends `/wallet` should get their wallet, not
   * silence from a bot that looks broken.
   */
  it('never suppresses a reply to a command', async () => {
    const { processors, send } = buildProcessors({
      templateKey: TEMPLATES.BOT_WALLET,
      notifyChat: false,
      notifyEvents: false,
    });

    await runSend(processors);

    expect(send).toHaveBeenCalledOnce();
  });
});

/**
 * The moderation button, and the bug that made it invisible (ADR-0018).
 *
 * ── What this is here to stop coming back ───────────────────────────────────
 *
 * `MODERATION_MENU_LABEL` was appended to a moderator's bottom keyboard until
 * v0.8.1 cut that keyboard down to one button, and it was not put back. For
 * three releases the constant, its translation and a test asserting the label
 * resolves to `moderate` all existed, and **nothing drew it** — so the only way
 * a linked moderator reached their queue was to know `/moderate` by heart, and
 * `/moderate` is deliberately unadvertised.
 *
 * `menu.test.ts` did not catch it because it asked what a tap *means*. This asks
 * the question that was missing: does anybody **see** it.
 */
describe('the moderation button on the bottom keyboard', () => {
  it('draws it for a linked moderator', async () => {
    const { processors, send } = buildProcessors({
      templateKey: TEMPLATES.CONTENT_HIDDEN,
      linkedModerator: true,
    });

    await runSend(processors);

    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      undefined,
      expect.objectContaining({ moderator: true }),
    );
  });

  it('does not draw it for anybody else', async () => {
    const { processors, send } = buildProcessors({
      templateKey: TEMPLATES.CONTENT_HIDDEN,
      linkedModerator: false,
    });

    await runSend(processors);

    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      undefined,
      expect.objectContaining({ moderator: false }),
    );
  });

  /**
   * The cheapness property, and the reason it is a test rather than a comment.
   *
   * `reply_markup` is one field: a message carrying its own inline keyboard
   * sends no `ReplyKeyboardMarkup` at all and cannot change what the client is
   * holding. Asking the database anyway would put a query on every wizard step
   * — the highest-frequency send this product has — to decide something the
   * send will not act on.
   */
  it('does not ask when the message carries its own inline keyboard', async () => {
    const { processors, send, isLinked } = buildProcessors({
      templateKey: TEMPLATES.BOT_NOTICE,
      linkedModerator: true,
    });

    await runSend(processors);

    expect(send).toHaveBeenCalledOnce();
    expect(isLinked).not.toHaveBeenCalled();
  });
});
