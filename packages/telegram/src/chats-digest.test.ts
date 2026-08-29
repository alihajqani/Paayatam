import { describe, expect, it } from 'vitest';
import { formatMyChats, type MyChatLine } from './chats-digest';

function line(over: Partial<MyChatLine> = {}): MyChatLine {
  return {
    counterpartName: 'سارا',
    eventTitle: 'کوهنوردی',
    status: 'ANONYMOUS',
    unreadCount: 0,
    ...over,
  };
}

describe('formatMyChats', () => {
  it('says so plainly when there is no conversation', () => {
    expect(formatMyChats([])).toContain('گفتگوی بازی ندارید');
  });

  /** Who and what about: a name with no event is four identical rows to anybody with four chats. */
  it('names the counterpart and the event', () => {
    const text = formatMyChats([line()]);

    expect(text).toContain('سارا');
    expect(text).toContain('کوهنوردی');
  });

  /**
   * The status a live conversation usually has. `ChatsView` rendered the Latin
   * `ANONYMOUS` here until `CHAT_STATUS_FA` became total over the enum.
   */
  it('renders every status in Persian, including ANONYMOUS and BLOCKED', () => {
    expect(formatMyChats([line({ status: 'ANONYMOUS' })])).toContain('ناشناس');
    expect(formatMyChats([line({ status: 'OPEN' })])).toContain('باز');
    expect(formatMyChats([line({ status: 'CLOSED' })])).toContain('بسته‌شده');
    expect(formatMyChats([line({ status: 'BLOCKED' })])).toContain('مسدود');
  });

  it('shows an unread count in Persian digits', () => {
    expect(formatMyChats([line({ unreadCount: 4 })])).toContain('۴ پیام نخوانده');
  });

  /** A badge on every row is a badge on none. */
  it('says nothing about unread when there is none', () => {
    expect(formatMyChats([line({ unreadCount: 0 })])).not.toContain('نخوانده');
  });

  /** A display name is a stranger's words on their way into an HTML-parse-mode send. */
  it('escapes markup in a name and in a title', () => {
    const text = formatMyChats([
      line({ counterpartName: '<b>سارا</b>', eventTitle: '<i>کوه</i>' }),
    ]);

    expect(text).toContain('&lt;b&gt;سارا&lt;/b&gt;');
    expect(text).toContain('&lt;i&gt;کوه&lt;/i&gt;');
    expect(text).not.toContain('<b>سارا');
  });
});
