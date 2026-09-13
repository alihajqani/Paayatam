import { describe, expect, it } from 'vitest';
import { stepByKey } from '../wizard';
import { directMessageWizard, isDirectMessageMode } from './direct-message';

function promptFor(mode: string): string {
  const step = stepByKey(directMessageWizard, 'body');
  if (step === null) throw new Error('no body step');
  return step.prompt({ mode: mode as never });
}

/**
 * The compose form names who the message goes to (plan 13).
 *
 * It has three openers now, and the prompt is the only thing on screen that says
 * which one was pressed: a host writing to a guest who is told «برای میزبان
 * بنویسید» would reasonably think the message is going to themselves.
 */
describe('the direct message prompt', () => {
  it('addresses the host for a new thread from a guest', () => {
    expect(promptFor('new')).toContain('میزبان');
  });

  it('addresses the guest when a host writes to one', () => {
    const text = promptFor('guest');
    expect(text).toContain('مهمان');
    expect(text).not.toContain('میزبان');
  });

  it('keeps the warning about contact details in every mode', () => {
    for (const mode of ['new', 'reply', 'guest']) {
      expect(promptFor(mode), mode).toContain('مسئولیت خودتان');
    }
  });

  it('accepts the guest mode a button seeds', () => {
    expect(isDirectMessageMode('guest')).toBe(true);
    expect(isDirectMessageMode('host')).toBe(false);
  });
});
