import { describe, expect, it } from 'vitest';
import { stepByKey } from '../wizard';
import { isNoShowClaimMode, noShowClaimWizard } from './no-show-claim';

const step = stepByKey(noShowClaimWizard, 'statement');

function prompt(mode: string): string {
  if (step === null) throw new Error('no statement step');
  return step.prompt({ mode: mode as never });
}

/** The one question all three claims ask (plan 08): what happened, in a sentence. */
describe('the no-show claim form', () => {
  it('asks each side its own question', () => {
    expect(prompt('dispute')).toContain('حاضر بودید');
    expect(prompt('absent')).toContain('میزبان');
    expect(prompt('response')).toContain('توضیح');
  });

  it('says a moderator reads it, and that nothing moves until then', () => {
    for (const mode of ['dispute', 'absent', 'response']) {
      expect(prompt(mode), mode).toContain('داور');
    }
  });

  it('takes a sentence, and refuses a word or a page', () => {
    if (step === null) throw new Error('no statement step');
    expect(step.accept({ kind: 'text', value: 'بله' }, {})).toMatchObject({ ok: false });
    expect(step.accept({ kind: 'text', value: 'ا'.repeat(501) }, {})).toMatchObject({ ok: false });
    expect(step.accept({ kind: 'text', value: '  من ساعت هفت آنجا بودم.  ' }, {})).toEqual({
      ok: true,
      patch: { statement: 'من ساعت هفت آنجا بودم.' },
    });
  });

  it('refuses a photo with a sentence about text', () => {
    if (step === null) throw new Error('no statement step');
    expect(step.accept({ kind: 'photo', value: 'file-id' }, {})).toMatchObject({ ok: false });
  });

  it('knows its three modes and nothing else', () => {
    expect(['dispute', 'absent', 'response'].every(isNoShowClaimMode)).toBe(true);
    expect(isNoShowClaimMode('report')).toBe(false);
  });
});
