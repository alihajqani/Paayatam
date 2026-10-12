import type { InteractionKind } from '@payetam/shared';
import {
  BOT_COMMANDS,
  MODERATION_MENU_COMMAND,
  decodeMenuCallback,
  isStartPayload,
  menuCommandFor,
  menuGroupKeyFor,
  parseBackCallback,
  parseCampaignTag,
  parseEventCommand,
  parseGuideCallback,
  parseMyEventCommand,
  parsePolicyCallback,
  parseSettingCallback,
  parseStartPayload,
  stripReferralPrefix,
} from '@payetam/telegram';
import type { BotIntent } from '@payetam/telegram';
import { isReferralCodeShape } from '../economy/referral.service';

/** What one update was, in the words `bot_interaction` stores. */
export interface IntentDescription {
  kind: InteractionKind;
  /** The name of what was pressed or sent, with every id taken out. */
  action: string;
  /** The public id, campaign tag or guide slug the action named. */
  ref: string | null;
  /** The message a tapped button sits on, when Telegram named one. */
  messageId: number | null;
}

/**
 * Name an inbound update, without keeping anything a person typed.
 *
 * ── Why it lives here and not beside the codecs ─────────────────────────────
 *
 * Everything it reads is in `@payetam/telegram` except one thing: whether a
 * `/start` payload has the shape of a referral code, which is the domain's
 * rule (`isReferralCodeShape`) and the same one `acquisitionFor` asks. That
 * package depends on neither app nor domain, so the function sits one layer up.
 *
 * ── What "named" means ──────────────────────────────────────────────────────
 *
 * An `action` is a word from a vocabulary this code controls: a published
 * command, a codec's verb, a wizard's step key. A value somebody chose — the
 * city in a form, a gender, a rating, the text after a slash — is never part of
 * it. `callback_data` and command names arrive from a client, so anything that
 * does not parse falls back to its prefix, or to `unknown`, rather than being
 * stored as written.
 *
 * Null for the one update that is not recorded: an edit, which the bot ignores
 * and Telegram sends for every edit in the chat.
 */
export function describeIntent(intent: BotIntent): IntentDescription | null {
  switch (intent.kind) {
    case 'START':
      return { kind: 'START', ...describeStart(intent.payload), messageId: null };

    case 'COMMAND':
      return {
        kind: 'COMMAND',
        action: `cmd:${commandName(intent.command)}`,
        ref: null,
        messageId: null,
      };

    case 'CALLBACK':
      return {
        kind: 'CALLBACK',
        ...describeCallback(intent.data),
        messageId: intent.messageId ?? null,
      };

    case 'TEXT': {
      // The reply keyboard sends its label as ordinary text. The order is
      // `onText`'s: a command button first, then a category button.
      const command = menuCommandFor(intent.message.text);
      if (command !== null) {
        return { kind: 'KEYBOARD', action: `kb:${command}`, ref: null, messageId: null };
      }
      const group = menuGroupKeyFor(intent.message.text);
      if (group !== null) {
        return { kind: 'KEYBOARD', action: `kb:group:${group}`, ref: null, messageId: null };
      }
      return { kind: 'TEXT', action: 'text:unclaimed', ref: null, messageId: null };
    }

    case 'PHOTO':
      return { kind: 'PHOTO', action: 'photo', ref: null, messageId: null };

    case 'UNSUPPORTED':
      return { kind: 'UNSUPPORTED', action: 'unsupported', ref: null, messageId: null };

    case 'BLOCK_CHANGED':
      return intent.blocked
        ? { kind: 'BLOCKED', action: 'blocked', ref: null, messageId: null }
        : { kind: 'UNBLOCKED', action: 'unblocked', ref: null, messageId: null };

    case 'EDITED_TEXT':
      return null;
  }
}

/**
 * A `/start` payload, in the order the bot routes it and `acquisitionFor`
 * files it: campaign, then the event links, then a referral code.
 *
 * Three link actions where acquisition has one source, because «شرکت می‌کنم»
 * and «جزئیات» are different taps even though they bring the same account.
 */
function describeStart(payload: string | null): { action: string; ref: string | null } {
  if (payload === null || payload.trim() === '') return { action: 'start:direct', ref: null };

  const tag = parseCampaignTag(payload);
  if (tag !== null) return { action: 'start:campaign', ref: tag };

  const link = parseStartPayload(payload);
  if (link !== null) return { action: `start:${link.action}`, ref: link.id };

  // Counted, never kept: a referral code names the person who shared it.
  if (isReferralCodeShape(stripReferralPrefix(payload))) {
    return { action: 'start:referral', ref: null };
  }

  return { action: 'start:other', ref: isStartPayload(payload) ? payload : null };
}

const PUBLISHED_COMMANDS: ReadonlySet<string> = new Set([
  ...BOT_COMMANDS.map((entry) => entry.command),
  MODERATION_MENU_COMMAND,
]);

/**
 * A command's name, when it is one the bot publishes.
 *
 * `/event_<code>` and `/myevent_<code>` are one action each however many
 * events there are. Anything else after a slash is something a person typed,
 * and is filed as `unknown` rather than stored.
 */
function commandName(command: string): string {
  if (PUBLISHED_COMMANDS.has(command)) return command;
  if (parseMyEventCommand(command) !== null) return 'myevent';
  if (parseEventCommand(command) !== null) return 'event';
  return 'unknown';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAMILY = /^[a-z]{2,8}$/;
const VERB = /^[a-z_]{2,16}$/;
/** A wizard's step key, by the wizard codec's own rule. */
const STEP = /^[a-z0-9_]{1,16}$/;

/**
 * Families whose second segment is data rather than a verb: a page number, a
 * packed set of filters, a choice. They are counted under the prefix alone.
 */
const BARE_FAMILIES: ReadonlySet<string> = new Set(['dc', 'mv', 'wl', 'ts', 'gn']);

/**
 * An inline button, as `<prefix>:<verb>` and the id it carried.
 *
 * One structural rule covers every family of the usual `prefix:verb:id` shape,
 * including one added after this was written — it is counted from its first
 * tap, and only lacks a Persian label until somebody adds one. The families
 * that pack something else into the second segment are handled by name.
 */
function describeCallback(data: string): { action: string; ref: string | null } {
  const parts = data.split(':');
  const family = parts[0] ?? '';
  if (!FAMILY.test(family)) return { action: 'unknown', ref: null };

  if (BARE_FAMILIES.has(family)) return { action: family, ref: null };

  switch (family) {
    case 'mn': {
      const menu = decodeMenuCallback(data);
      if (menu === null) return { action: family, ref: null };
      if (menu.kind === 'root') return { action: 'mn:root', ref: null };
      return menu.kind === 'group'
        ? { action: `mn:g:${menu.key}`, ref: null }
        : { action: `mn:c:${menu.command}`, ref: null };
    }

    case 'gd': {
      const guide = parseGuideCallback(data);
      if (guide === null) return { action: family, ref: null };
      return guide.kind === 'guide'
        ? { action: 'gd:guide', ref: guide.slug }
        : { action: `gd:${guide.kind}`, ref: null };
    }

    case 'pl': {
      const policy = parsePolicyCallback(data);
      return { action: policy === null ? family : `pl:${policy.doc}`, ref: null };
    }

    case 'st': {
      const setting = parseSettingCallback(data);
      return { action: setting === null ? family : `st:${setting.field}`, ref: null };
    }

    case 'bk': {
      const back = parseBackCallback(data);
      return { action: back === null ? family : `bk:${back.target}`, ref: null };
    }

    // `rp:aske:<id>` is the menu and `rp:eSPAM:<id>` a filed reason. Which
    // reason is in `report`; here it is one action or the other.
    case 'rp': {
      const verb = parts[1] ?? '';
      if (!/^[A-Za-z]{2,16}$/.test(verb)) return { action: family, ref: null };
      return { action: verb.startsWith('ask') ? 'rp:ask' : 'rp:reason', ref: firstUuid(parts) };
    }

    // The value is an answer to a form question, so it is dropped whatever it
    // is — including a uuid, which here is a city or a category, not a target.
    case 'wz': {
      const step = parts[1] ?? '';
      return { action: STEP.test(step) ? `wz:${step}` : family, ref: null };
    }
  }

  // `rv:rate4` is one action for all five ratings.
  const verb = (parts[1] ?? '').replace(/\d+$/, '');
  if (!VERB.test(verb)) return { action: family, ref: null };
  return { action: `${family}:${verb}`, ref: firstUuid(parts) };
}

function firstUuid(parts: readonly string[]): string | null {
  return parts.slice(1).find((part) => UUID.test(part)) ?? null;
}
