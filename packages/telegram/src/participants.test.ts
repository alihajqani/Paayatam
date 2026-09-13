import { describe, expect, it } from 'vitest';
import { formatParticipants, type ParticipantLine } from './participants';

function line(over: Partial<ParticipantLine> = {}): ParticipantLine {
  return {
    displayName: 'سارا',
    trustScore: 70,
    foundingTier: null,
    status: 'PENDING',
    waitlistRank: null,
    ...over,
  };
}

/**
 * The guest list is the **host's** screen, so it speaks to the host (review M3).
 *
 * It was drawn with the guest's map, which put «شما لغو کردید» beside a guest who
 * had withdrawn and «در انتظار پاسخ میزبان» beside a request waiting on the very
 * person reading it.
 */
describe('formatParticipants', () => {
  it('says a pending request is waiting on the reader', () => {
    const text = formatParticipants('قهوه', [line({ status: 'PENDING' })]);
    expect(text).toContain('در انتظار پاسخ شما');
    expect(text).not.toContain('پاسخ میزبان');
  });

  it('says a guest who withdrew did so themselves', () => {
    const text = formatParticipants('قهوه', [line({ status: 'CANCELLED_BY_PARTICIPANT' })]);
    expect(text).toContain('خودش لغو کرد');
    expect(text).not.toContain('شما لغو کردید');
  });
});
