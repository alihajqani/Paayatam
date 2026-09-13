import { describe, expect, it } from 'vitest';
import { TEMPLATES, render } from './templates';

const PARTICIPANT = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const base = { eventTitle: 'قهوه و بازی', participantPublicId: PARTICIPANT };

/**
 * The host decides from the notification, so it says who is asking (plan 11).
 *
 * It said «یک نفر می‌خواهد بپیوندد» over «پذیرش / رد», and a host had to
 * accept or refuse somebody they knew nothing about. The guest list already
 * shows the same three facts — name, Trust Score, founding tier — so nothing new
 * is disclosed; it is only moved to where the decision is taken.
 */
describe.each([TEMPLATES.PARTICIPATION_REQUESTED_HOST, TEMPLATES.WAITLIST_PROMOTED_HOST])(
  '%s',
  (templateKey) => {
    it('names who is asking, with their trust and tier', () => {
      const text = String(
        render(templateKey, {
          ...base,
          participantDisplayName: 'سارا',
          participantTrustScore: 70,
          participantFoundingTier: 2,
        })?.text,
      );
      expect(text).toContain('سارا');
      expect(text).toContain('۷۰ از ۱۰۰');
      expect(text).toContain('🥈 پیشگام');
    });

    /** Null is «تازه‌وارد», never zero — a new account has done nothing wrong. */
    it('calls an unjudged account new, never zero', () => {
      const text = String(
        render(templateKey, {
          ...base,
          participantDisplayName: 'سارا',
          participantTrustScore: null,
          participantFoundingTier: null,
        })?.text,
      );
      expect(text).toContain('تازه‌وارد');
      expect(text).not.toContain('۰ از ۱۰۰');
    });

    it('escapes a display name, which is somebody else’s words', () => {
      const text = String(
        render(templateKey, { ...base, participantDisplayName: '<b>x</b>' })?.text,
      );
      expect(text).toContain('&lt;b&gt;x&lt;/b&gt;');
    });

    it('keeps the decision buttons', () => {
      const data = (
        render(templateKey, { ...base, participantDisplayName: 'سارا' })?.keyboard ?? []
      )
        .flat()
        .map((button) => button.callbackData);
      expect(data).toEqual([`chat:accept:${PARTICIPANT}`, `chat:reject:${PARTICIPANT}`]);
    });
  },
);

describe('a request queued before the requester was named', () => {
  it('still renders, without a name', () => {
    expect(render(TEMPLATES.PARTICIPATION_REQUESTED_HOST, base)?.text).toContain('یک نفر');
  });
});
