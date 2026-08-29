import { computed, ref, type Ref } from 'vue';
import { MAX_PROFILE_INTERESTS } from '@payetam/shared';

/**
 * Picking interests, with the cap enforced where the user can see it (report 4).
 *
 * ── What was wrong ───────────────────────────────────────────────────────────
 *
 * The two pickers — onboarding and editing — each had their own `toggleInterest`,
 * and neither knew about the limit. A user could tick fifteen chips, finish the
 * rest of the form, submit, and be told by a 400 that ten is the maximum. The
 * count above the list said «۱۵ از ۱۰» while they did it, which is the UI
 * agreeing that something is wrong and doing nothing about it.
 *
 * ── What this does instead ───────────────────────────────────────────────────
 *
 * At the cap, every **unselected** chip is disabled and a sentence says why.
 * Selected chips stay live, because the way out of a full list is to untick
 * something — disabling those too would be a dead end with no message.
 *
 * ── Why a composable rather than a component ─────────────────────────────────
 *
 * The two screens render the chips differently (one is a step in a wizard with a
 * `MainButton` under it, the other a form with a save bar) and share only the
 * rule. Extracting the rule makes it testable without mounting anything — this
 * repository has no component-test harness, and a limit that is only enforced in
 * a `.vue` file is a limit with no test.
 *
 * The server still enforces it: `interestIds: z.array(z.uuid()).min(1).max(…)`
 * refuses an over-long list whatever the client did. This is the half that stops
 * the user reaching that refusal.
 */
export function useInterestPicker(selected: Ref<string[]>, max = MAX_PROFILE_INTERESTS) {
  const full = computed(() => selected.value.length >= max);

  /**
   * Set when a tap was refused, cleared by the next successful one.
   *
   * A tap that does nothing is indistinguishable from a tap that missed, so the
   * refusal says something — even though the chip is also disabled, because a
   * disabled control on a touch screen is a control that silently ignores you.
   */
  const limitHit = ref(false);

  function isSelected(id: string): boolean {
    return selected.value.includes(id);
  }

  /** True when this chip must be rendered as unavailable. */
  function isDisabled(id: string): boolean {
    return full.value && !isSelected(id);
  }

  /**
   * Tick or untick one, and report whether anything changed.
   *
   * Returns false only when the cap refused the tap, which is what sets the
   * message. Unticking always works, at any count.
   */
  function toggle(id: string): boolean {
    const index = selected.value.indexOf(id);

    if (index !== -1) {
      selected.value.splice(index, 1);
      limitHit.value = false;
      return true;
    }

    if (full.value) {
      limitHit.value = true;
      return false;
    }

    selected.value.push(id);
    limitHit.value = false;
    return true;
  }

  /**
   * The Persian sentence for the current state, or null when there is nothing to say.
   *
   * Two different sentences: at the cap it is a statement of fact, and after a
   * refused tap it is an instruction. The second replaces the first, because
   * somebody who has just been refused needs to know what to do rather than what
   * is true.
   */
  const notice = computed<string | null>(() => {
    if (limitHit.value) {
      return `بیشتر از ${String(max)} علاقه‌مندی نمی‌توانید انتخاب کنید. برای انتخاب مورد تازه، یکی از موارد انتخاب‌شده را بردارید.`;
    }
    if (full.value) return `به سقف ${String(max)} علاقه‌مندی رسیده‌اید.`;
    return null;
  });

  return { max, full, limitHit, notice, isSelected, isDisabled, toggle };
}
