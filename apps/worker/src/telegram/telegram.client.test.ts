import { describe, expect, it } from 'vitest';
import type { Bot } from 'grammy';
import type { Env } from '@payetam/config';
import { TelegramClient } from './telegram.client';

/**
 * What `send` puts on the wire.
 *
 * A grammY transformer stands in for Telegram: it records the call and answers
 * as Telegram would, so nothing leaves the process and the payload asserted is
 * the one the real API would have received.
 */
function capturing(): { client: TelegramClient; calls: Record<string, unknown>[] } {
  const client = new TelegramClient({ TELEGRAM_BOT_TOKEN: '1:test' } as unknown as Env);
  const calls: Record<string, unknown>[] = [];
  (client as unknown as { bot: Bot }).bot.api.config.use((_prev, _method, payload) => {
    calls.push(payload);
    return Promise.resolve({ ok: true, result: { message_id: 99 } } as never);
  });
  return { client, calls };
}

describe('send, as a reply (v0.18.5)', () => {
  /**
   * The message answered is the asker's own, and they may have deleted it
   * since. Without `allow_sending_without_reply` Telegram refuses the whole
   * send, and the answer would be lost over a quote.
   */
  it('replies to the question, and still sends if the question is gone', async () => {
    const { client, calls } = capturing();

    await expect(
      client.send(5n, 'پاسخ', undefined, { parseMode: 'HTML', replyTo: 41 }),
    ).resolves.toEqual({ kind: 'SENT', messageId: 99 });

    expect(calls[0]?.['reply_parameters']).toEqual({
      message_id: 41,
      allow_sending_without_reply: true,
    });
  });

  it('sends everything else as it always did', async () => {
    const { client, calls } = capturing();

    await client.send(5n, 'اعلان', undefined, { parseMode: 'HTML' });

    expect(calls[0]).not.toHaveProperty('reply_parameters');
  });
});
