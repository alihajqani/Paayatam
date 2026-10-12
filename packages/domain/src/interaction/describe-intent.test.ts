import { describe, expect, it } from 'vitest';
import {
  encodeAdminCallback,
  encodeBackCallback,
  encodeBuyCallback,
  encodeChannelRecheckCallback,
  encodeChatCallback,
  encodeCodeCallback,
  encodeDirectCallback,
  encodeDiscoverCallback,
  encodeEventCallback,
  encodeGenderChoice,
  encodeGuideCallback,
  encodeGuideCommands,
  encodeGuideIndex,
  encodeMenuCommand,
  encodeMenuGroup,
  encodeMenuRoot,
  encodeMyEventsCallback,
  encodePolicyCallback,
  encodeProfileFieldCallback,
  encodeReportAsk,
  encodeReviewCallback,
  encodeReviewEditCallback,
  encodeSettingCallback,
  encodeSuggestionCallback,
  encodeTrustCallback,
  encodeWalletCallback,
  encodeWizardCallback,
  COMMAND_GROUPS,
  MAIN_MENU_LABEL,
} from '@payetam/telegram';
import type { BotIntent, BotSender } from '@payetam/telegram';
import { describeIntent } from './describe-intent';

const ID = '11111111-1111-4111-8111-111111111111';
const FROM: BotSender = { telegramUserId: 424242n };

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function start(payload: string | null): BotIntent {
  return { kind: 'START', from: FROM, payload };
}

function tap(data: string, messageId?: number): BotIntent {
  return {
    kind: 'CALLBACK',
    from: FROM,
    callbackQueryId: 'q1',
    data,
    ...(messageId === undefined ? {} : { messageId }),
  };
}

function text(body: string): BotIntent {
  return { kind: 'TEXT', from: FROM, message: { text: body }, replyToMessageId: null };
}

describe('describeIntent', () => {
  describe('/start', () => {
    it('calls a bare /start direct', () => {
      expect(describeIntent(start(null))).toEqual({
        kind: 'START',
        action: 'start:direct',
        ref: null,
        messageId: null,
      });
      expect(describeIntent(start('  '))?.action).toBe('start:direct');
    });

    it('names an ad link by its tag, one spelling per campaign', () => {
      expect(describeIntent(start('src_TgAds_1'))).toMatchObject({
        action: 'start:campaign',
        ref: 'tgads_1',
      });
    });

    /**
     * Three actions, where `user_acquisition` has one source for all of them:
     * that table answers "what brought the account", this answers "what was
     * tapped", and «شرکت می‌کنم» is a different tap from «جزئیات».
     */
    it('keeps the three event links apart and names what they point at', () => {
      expect(describeIntent(start(`event_${ID}`))).toMatchObject({
        action: 'start:event',
        ref: ID,
      });
      expect(describeIntent(start(`join_${ID}`))).toMatchObject({ action: 'start:join', ref: ID });
      expect(describeIntent(start(`host_${ID}`))).toMatchObject({ action: 'start:host', ref: ID });
    });

    /** A referral code names a person, so it is counted and not kept. */
    it('counts an invite link without keeping the code', () => {
      expect(describeIntent(start('ABCD2345'))).toMatchObject({
        action: 'start:referral',
        ref: null,
      });
      expect(describeIntent(start('ref_abcd2345'))).toMatchObject({
        action: 'start:referral',
        ref: null,
      });
    });

    it('keeps an unrecognised payload only when Telegram could have carried it', () => {
      expect(describeIntent(start('tgads1!'))).toMatchObject({ action: 'start:other', ref: null });
      expect(describeIntent(start('some-old-link_1'))).toMatchObject({
        action: 'start:other',
        ref: 'some-old-link_1',
      });
    });
  });

  describe('commands', () => {
    function command(name: string, argument: string | null = null): BotIntent {
      return { kind: 'COMMAND', from: FROM, command: name, argument };
    }

    it('names a command the bot publishes', () => {
      expect(describeIntent(command('discover'))).toEqual({
        kind: 'COMMAND',
        action: 'cmd:discover',
        ref: null,
        messageId: null,
      });
    });

    /** `/event_<code>` is one action however many events there are. */
    it('files every /event_<code> under one action', () => {
      expect(describeIntent(command('event_01a05d3478'))?.action).toBe('cmd:event');
      expect(describeIntent(command('myevent_01a05d3478'))?.action).toBe('cmd:myevent');
    });

    /** What somebody typed after a slash is their own text, and is not stored. */
    it('does not keep a command nobody published, nor any argument', () => {
      const made = describeIntent(command('my_phone_09120000000', 'secret words'));
      expect(made).toMatchObject({ action: 'cmd:unknown', ref: null });
      expect(JSON.stringify(made)).not.toContain('secret');
    });
  });

  describe('the reply keyboard', () => {
    it('is a button, although Telegram delivers it as text', () => {
      expect(describeIntent(text(MAIN_MENU_LABEL))).toMatchObject({
        kind: 'KEYBOARD',
        action: 'kb:menu',
      });
    });

    it('names a category button by its group', () => {
      const group = COMMAND_GROUPS[0];
      if (group === undefined) throw new Error('no command groups');
      expect(describeIntent(text(group.label))).toMatchObject({
        kind: 'KEYBOARD',
        action: `kb:group:${group.key}`,
      });
    });
  });

  describe('typed text', () => {
    /**
     * `unclaimed` until a form says otherwise: the bot adapter upgrades it to
     * `text:answer` when a wizard takes the message.
     */
    it('records that something was typed, and nothing of what', () => {
      const made = describeIntent(text('شمارهٔ من ۰۹۱۲۰۰۰۰۰۰۰ است'));
      expect(made).toEqual({ kind: 'TEXT', action: 'text:unclaimed', ref: null, messageId: null });
    });
  });

  describe('inline buttons', () => {
    it('keeps the verb, moves the id to ref, and carries the message', () => {
      expect(describeIntent(tap(encodeEventCallback('show', ID), 77))).toEqual({
        kind: 'CALLBACK',
        action: 'ev:show',
        ref: ID,
        messageId: 77,
      });
    });

    it.each([
      [encodeChatCallback('accept', ID), 'chat:accept', ID],
      [encodeEventCallback('joinyes', ID), 'ev:joinyes', ID],
      [encodeDirectCallback('reply', ID), 'dm:reply', ID],
      [encodeSuggestionCallback(ID), 'sg:host', ID],
      [encodeReviewCallback(4, ID), 'rv:rate', ID],
      [encodeReviewEditCallback(ID), 'rv:edit', ID],
      [encodeReportAsk('e', ID), 'rp:ask', ID],
      [encodeAdminCallback('list', null), 'ad:list', null],
      [encodeCodeCallback('gift'), 'cd:gift', null],
      [encodeBuyCallback(), 'by:coins', null],
      [encodeProfileFieldCallback('bio'), 'pf:bio', null],
      [encodeChannelRecheckCallback(), 'cg:recheck', null],
      [encodeMenuRoot(), 'mn:root', null],
      [encodeMenuGroup('events'), 'mn:g:events', null],
      [encodeMenuCommand('discover'), 'mn:c:discover', null],
      [encodeGuideIndex(), 'gd:index', null],
      [encodeGuideCommands(), 'gd:commands', null],
      [encodeGuideCallback('how-to-join'), 'gd:guide', 'how-to-join'],
      [encodePolicyCallback('p', 2), 'pl:p', null],
      [encodeSettingCallback('e', true), 'st:e', null],
      [encodeBackCallback('d', 1234), 'bk:d', null],
      [encodeMyEventsCallback(3), 'mv', null],
      [encodeWalletCallback(11), 'wl', null],
      [encodeTrustCallback(2), 'ts', null],
      [
        encodeDiscoverCallback({
          when: 'a',
          cost: 'a',
          page: 2,
          view: 'l',
          age: false,
          categoryId: null,
        }),
        'dc',
        null,
      ],
    ])('%s → %s', (data, action, ref) => {
      expect(describeIntent(tap(data))).toMatchObject({ kind: 'CALLBACK', action, ref });
    });

    /** Which gender somebody chose is their answer, not a button name. */
    it('does not say which gender was chosen', () => {
      expect(describeIntent(tap(encodeGenderChoice('FEMALE')))?.action).toBe('gn');
      expect(describeIntent(tap(encodeGenderChoice('MALE')))?.action).toBe('gn');
    });

    /**
     * A wizard button's value is an answer to a form question — a city, a date,
     * an age — so the step is named and the value is dropped, uuid or not.
     */
    it('names a wizard step and drops what was answered', () => {
      expect(
        describeIntent(tap(encodeWizardCallback({ action: 'city', value: ID }))),
      ).toMatchObject({ action: 'wz:city', ref: null });
      expect(
        describeIntent(tap(encodeWizardCallback({ action: 'confirm', value: '' }))),
      ).toMatchObject({ action: 'wz:confirm', ref: null });
    });

    /** A family added later still counts, under its prefix, until it is named. */
    it('files an unknown family of the usual shape under prefix and verb', () => {
      expect(describeIntent(tap(`zz:open:${ID}`))).toMatchObject({ action: 'zz:open', ref: ID });
    });

    /** `callback_data` arrives from a client; none of it may be stored as written. */
    it('never stores tampered data as an action', () => {
      for (const data of ['', ':::', 'ev:<script>:x', `mn:c:${'a'.repeat(60)}`, 'ΩΩ:ΩΩ', ID]) {
        const made = describeIntent(tap(data));
        expect(made?.action).toMatch(/^[a-z]{2,8}(:[a-z0-9_]{1,32}){0,2}$|^unknown$/);
        expect(made?.action).not.toMatch(UUID);
      }
    });
  });

  describe('everything else', () => {
    it('names a photo, an unsupported message and a block', () => {
      expect(describeIntent({ kind: 'PHOTO', from: FROM, fileId: 'f' })).toMatchObject({
        kind: 'PHOTO',
        action: 'photo',
      });
      expect(describeIntent({ kind: 'UNSUPPORTED', from: FROM })).toMatchObject({
        kind: 'UNSUPPORTED',
        action: 'unsupported',
      });
      expect(describeIntent({ kind: 'BLOCK_CHANGED', from: FROM, blocked: true })).toMatchObject({
        kind: 'BLOCKED',
        action: 'blocked',
      });
      expect(describeIntent({ kind: 'BLOCK_CHANGED', from: FROM, blocked: false })).toMatchObject({
        kind: 'UNBLOCKED',
        action: 'unblocked',
      });
    });

    /** The bot ignores edits, and Telegram sends one for every edit in the chat. */
    it('does not record an edit', () => {
      expect(
        describeIntent({ kind: 'EDITED_TEXT', from: FROM, message: { text: 'x' } }),
      ).toBeNull();
    });
  });
});
