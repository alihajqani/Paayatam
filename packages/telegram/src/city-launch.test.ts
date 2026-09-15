import { describe, expect, it } from 'vitest';
import { cityLaunchAnnouncement } from './city-launch';
import { MAIN_MENU_LABEL, menuPathFor } from './keyboards';

/** «پایه‌تَم در شیراز باز شد» — the message plan 17 promised and nothing sent. */
describe('cityLaunchAnnouncement', () => {
  it('names the city and says it is open', () => {
    const text = cityLaunchAnnouncement('شیراز');
    expect(text).toContain('پایه‌تَم در شیراز باز شد');
  });

  /** A path a reader can follow: the button under the compose box, then the group. */
  it('says where to find the activities, by the buttons that are drawn', () => {
    const text = cityLaunchAnnouncement('شیراز');
    expect(text).toContain(MAIN_MENU_LABEL);
    expect(text).toContain(menuPathFor('discover') ?? '—');
  });

  it('escapes a city name, which an operator typed', () => {
    expect(cityLaunchAnnouncement('<b>ش</b>')).toContain('&lt;b&gt;ش&lt;/b&gt;');
  });
});
