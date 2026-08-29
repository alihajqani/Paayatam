import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { MAX_PROFILE_INTERESTS } from '@payetam/shared';
import { useInterestPicker } from './useInterestPicker';

/**
 * The interest cap, tested where it is decided (report 4).
 *
 * The bug was not that the server accepted too many — it never did — but that the
 * client let a user build an invalid selection and only told them at submit time.
 * So what is asserted here is the *client* rule: the eleventh tap changes nothing,
 * the chip that would be the eleventh is disabled, and unticking is never blocked.
 */

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `interest-${String(index)}`);
}

describe('useInterestPicker', () => {
  it('adds and removes', () => {
    const selected = ref<string[]>([]);
    const picker = useInterestPicker(selected);

    expect(picker.toggle('a')).toBe(true);
    expect(selected.value).toEqual(['a']);
    expect(picker.isSelected('a')).toBe(true);

    expect(picker.toggle('a')).toBe(true);
    expect(selected.value).toEqual([]);
  });

  it('refuses the eleventh and leaves the selection untouched', () => {
    const selected = ref(ids(MAX_PROFILE_INTERESTS));
    const picker = useInterestPicker(selected);

    expect(picker.toggle('one-too-many')).toBe(false);
    expect(selected.value).toHaveLength(MAX_PROFILE_INTERESTS);
    expect(selected.value).not.toContain('one-too-many');
  });

  /** The whole point: the UI has to stop offering, not just refuse. */
  it('disables every unselected option at the cap, and no selected one', () => {
    const selected = ref(ids(MAX_PROFILE_INTERESTS));
    const picker = useInterestPicker(selected);

    expect(picker.full.value).toBe(true);
    expect(picker.isDisabled('interest-0')).toBe(false);
    expect(picker.isDisabled('something-else')).toBe(true);
  });

  /** Otherwise a full list is a dead end: nothing can be added and nothing removed. */
  it('always allows unticking, even at the cap', () => {
    const selected = ref(ids(MAX_PROFILE_INTERESTS));
    const picker = useInterestPicker(selected);

    expect(picker.toggle('interest-3')).toBe(true);
    expect(selected.value).toHaveLength(MAX_PROFILE_INTERESTS - 1);
    expect(picker.full.value).toBe(false);
    expect(picker.isDisabled('something-else')).toBe(false);
  });

  it('says the cap is reached, and says what to do after a refused tap', () => {
    const selected = ref(ids(MAX_PROFILE_INTERESTS - 1));
    const picker = useInterestPicker(selected);

    expect(picker.notice.value).toBeNull();

    picker.toggle('last-one');
    expect(picker.notice.value).toContain('سقف');

    picker.toggle('one-too-many');
    expect(picker.limitHit.value).toBe(true);
    expect(picker.notice.value).toContain('بردارید');
  });

  it('clears the refusal notice as soon as something works', () => {
    const selected = ref(ids(MAX_PROFILE_INTERESTS));
    const picker = useInterestPicker(selected);

    picker.toggle('one-too-many');
    expect(picker.limitHit.value).toBe(true);

    picker.toggle('interest-0');
    expect(picker.limitHit.value).toBe(false);
  });

  /** A profile edited before the cap existed can start over it. It must not get worse. */
  it('does not refuse unticking a selection that is already over the cap', () => {
    const selected = ref(ids(MAX_PROFILE_INTERESTS + 3));
    const picker = useInterestPicker(selected);

    expect(picker.full.value).toBe(true);
    expect(picker.toggle('interest-0')).toBe(true);
    expect(selected.value).toHaveLength(MAX_PROFILE_INTERESTS + 2);
  });
});
