import { TEMPLATES, render } from '@payetam/telegram';
import { describe, expect, it } from 'vitest';
import { DEEP_LINKS } from './webapp';

/**
 * Every «باز کردن برنامه» button lands somewhere real.
 *
 * ── The failure this exists to stop ──────────────────────────────────────────
 *
 * `openAppButton` builds `https://t.me/<bot>?startapp=<target>` from whatever a
 * template names, and `deepLinkTarget()` resolves it against a **fixed
 * allowlist** — the payload is attacker-supplied, so a path would let a stranger
 * choose which screen somebody else's app opens on. The consequence is that a
 * template naming a target the allowlist does not carry produces a button that
 * silently lands on the splash. Silently: nothing throws, nothing logs, and the
 * button looks exactly right.
 *
 * That is not hypothetical. Every notification button in this product did it
 * until 2026-08-28, and the two halves live in different packages — the
 * catalogue in `@payetam/telegram`, the allowlist here — so nothing about
 * editing one suggests opening the other.
 *
 * ── Why the assertion is over `TEMPLATES` ────────────────────────────────────
 *
 * Totality is the point. A test naming the targets it knows about would pass on
 * the day somebody adds the template it does not know about, which is the only
 * day it matters. `Object.values(TEMPLATES)` grows on its own, exactly as the
 * escaping check in `escape.test.ts` does.
 */
describe('notification deep links', () => {
  const templates = Object.values(TEMPLATES);

  it('covers every template', () => {
    expect(templates.length).toBeGreaterThan(0);
  });

  it.each(templates)('%s resolves to a real screen', (templateKey) => {
    /**
     * A payload rich enough that every branch names its deep link. `chatPublicId`
     * is the one field a relay template needs before it builds one; the rest are
     * ignored by templates that do not read them.
     *
     * No template renders an *open-app* button any more (v0.4.6), and the deep
     * link is kept anyway — this check is the reason. It is what caught two
     * templates pointing at a `/participants` route that never existed, and it
     * would catch the next one whether or not a button spends the target.
     */
    const rendered = render(templateKey, {
      chatPublicId: 'abcd2345',
      text: 'متن',
      eventPublicId: 'efgh6789',
    });

    // A template that renders nothing at all is a separate bug, and one the
    // escaping test already covers. Here it simply has no target to check.
    if (rendered?.deepLink === undefined) return;

    // `chats/<id>` and the like: the allowlist keys the fixed prefix, and the
    // id is what the screen reads from the route. Compare the part that must
    // match a key.
    const target = rendered.deepLink;
    const known = target in DEEP_LINKS || target.split('/')[0]! in DEEP_LINKS;

    expect(
      known,
      `template ${templateKey} points at "${target}", which DEEP_LINKS does not carry`,
    ).toBe(true);
  });
});
