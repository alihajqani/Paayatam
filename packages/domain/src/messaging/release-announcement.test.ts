import { describe, expect, it } from 'vitest';
import { announcementText } from './release-announcement.service';

describe('announcementText', () => {
  /** The plain message, unchanged, for every release without notes. */
  it('asks for /start and lists nothing when the version has no notes', () => {
    const text = announcementText('v9.9.9');

    expect(text).toBe(
      `<b>پایتم آپدیت شد</b> 🎉\n\n` +
        `نسخهٔ تازه (<code>v9.9.9</code>) اومد.\n\n` +
        `یه بار <b>/start</b> رو بزن تا ربات از نو باز بشه. ` +
        `دکمه‌های پیام‌های قدیمی شاید دیگه کار نکنن.`,
    );
  });

  it('says what changed in v0.24.0, and still ends on /start', () => {
    const text = announcementText('v0.24.0');

    expect(text).toContain('چی عوض شده');
    expect(text).toContain('سن طرف مقابل');
    expect(text).toContain('بلاک');
    expect(text.trimEnd()).toMatch(/دیگه کار نکنن\.$/);
    // The voice guide forbids the long dash in Persian text.
    expect(text).not.toContain('—');
  });
});
