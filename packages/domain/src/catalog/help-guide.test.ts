import { describe, expect, it } from 'vitest';
import {
  HELP_GUIDE_BODY_MAX,
  HELP_GUIDE_TITLE_MAX,
  formatGuideNumber,
  helpGuidePlaceholderKeys,
  placeholderValues,
  placeholdersIn,
  renderGuideText,
  settingKeysFor,
  unknownPlaceholders,
} from './help-guide';
import { HELP_GUIDE_DEFAULTS } from './help-guide-defaults';
import { SETTING_DEFAULTS } from './settings.service';

const DEFAULT_VALUES = placeholderValues({ ...SETTING_DEFAULTS });

/**
 * The guide as shipped (migration 0063). These are the checks the panel runs
 * on an operator's edit, run on the text the code ships with — a default that
 * failed them could not be saved back unchanged.
 */
describe('HELP_GUIDE_DEFAULTS', () => {
  it('has unique, callback-safe slugs', () => {
    const slugs = HELP_GUIDE_DEFAULTS.map((guide) => guide.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9_-]{1,40}$/);
  });

  it.each(HELP_GUIDE_DEFAULTS.map((guide) => [guide.slug, guide] as const))(
    '%s fits the limits the panel enforces',
    (_slug, guide) => {
      expect(guide.title.length).toBeLessThanOrEqual(HELP_GUIDE_TITLE_MAX);
      expect(guide.body.length).toBeLessThanOrEqual(HELP_GUIDE_BODY_MAX);
      expect(unknownPlaceholders(guide.body)).toEqual([]);
    },
  );

  it.each(HELP_GUIDE_DEFAULTS.map((guide) => [guide.slug, guide] as const))(
    '%s renders with every placeholder filled',
    (_slug, guide) => {
      const text = renderGuideText(guide.body, DEFAULT_VALUES);
      expect(text).not.toContain('{{');
      expect(text).not.toMatch(/[0-9]/);
    },
  );

  /**
   * Persian writing rules the whole bot keeps: Persian digits in prose (a
   * Latin one flips a line's direction), Persian «ی» and «ک», and no dashes.
   */
  it.each(HELP_GUIDE_DEFAULTS.map((guide) => [guide.slug, guide] as const))(
    '%s is written in Persian characters',
    (_slug, guide) => {
      const prose = guide.body.replace(/\{\{[^}]*\}\}/g, '').replace(/\/[a-z_]+/g, '');
      expect(prose).not.toMatch(/[0-9]/);
      expect(`${guide.title}${prose}`).not.toMatch(/[يك—–]/);
    },
  );

  /**
   * The corrections made while checking the channel posts against the code.
   * Each was a sentence that was true of an earlier build or never true at all.
   */
  it('does not repeat what the code contradicts', () => {
    const all = HELP_GUIDE_DEFAULTS.map((guide) => guide.body).join('\n');
    // The event fee is quoted as one sum; the split is never shown to a host.
    expect(all).not.toContain('event_create_coins');
    expect(all).not.toContain('event_channel_publish_coins');
    // A full event's button in the bot is the waiting list's.
    expect(all).toContain('⏳ ثبت در نوبت انتظار');
    // There is no «سایر» with a name of your own (v0.6.7).
    expect(all).not.toContain('اسم دسته رو خودش');
    // The join charge is not a deposit returned on attendance.
    expect(all).not.toContain('ودیعه');
  });
});

describe('placeholders', () => {
  it('lists every setting and the derived sums', () => {
    const keys = helpGuidePlaceholderKeys();
    for (const key of Object.keys(SETTING_DEFAULTS)) expect(keys).toContain(key);
    expect(keys).toContain('derived.event_register_coins');
    expect(keys).toContain('derived.host_no_show_coins');
  });

  it('finds each key once, with or without |abs', () => {
    expect(placeholdersIn('{{a.b}} و {{ a.b }} و {{c.d|abs}}')).toEqual(['a.b', 'c.d']);
  });

  it('names what no setting answers to', () => {
    expect(unknownPlaceholders('{{economy.event_join_coins}} {{no.such_key}}')).toEqual([
      'no.such_key',
    ]);
  });

  it('reads the inputs of a derived value', () => {
    expect(settingKeysFor(['{{derived.event_register_coins}}']).sort()).toEqual([
      'economy.event_channel_publish_coins',
      'economy.event_create_coins',
    ]);
  });

  it('derives the sums from the settings', () => {
    expect(DEFAULT_VALUES['derived.event_register_coins']).toBe(
      SETTING_DEFAULTS['economy.event_create_coins'] +
        SETTING_DEFAULTS['economy.event_channel_publish_coins'],
    );
    expect(DEFAULT_VALUES['derived.host_no_show_coins']).toBe(
      Math.round(
        SETTING_DEFAULTS['cancellation.coins_no_show'] *
          SETTING_DEFAULTS['cancellation.host_penalty_multiplier'],
      ),
    );
  });
});

describe('renderGuideText', () => {
  it('writes the live value in Persian digits', () => {
    expect(renderGuideText('{{x}} سکه', { x: 25 })).toBe('۲۵ سکه');
  });

  it('drops the sign with |abs', () => {
    expect(renderGuideText('{{x|abs}} امتیاز', { x: -5 })).toBe('۵ امتیاز');
  });

  it('leaves a key with no value visible rather than blank', () => {
    expect(renderGuideText('{{gone.key}}', {})).toBe('{{gone.key}}');
  });
});

describe('formatGuideNumber', () => {
  it.each([
    [20, '۲۰'],
    [1.5, '۱٫۵'],
    [45_000, '۴۵٬۰۰۰'],
    [-2, '-۲'],
    [0, '۰'],
  ])('%s → %s', (value, expected) => {
    expect(formatGuideNumber(value)).toBe(expected);
  });
});
