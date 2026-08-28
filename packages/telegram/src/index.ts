export { escapeHtml, toPersianDigits } from './escape';
export { TEMPLATES, render } from './templates';
export type { TemplateKey, RenderedMessage } from './templates';
export { renderChannelPost } from './channel';
export type { ChannelPostContent, RenderedChannelPost } from './channel';
export { renderEventInvitation } from './invitation';
export { formatMyRequests } from './requests';
export type { MyRequestLine } from './requests';
export { formatMyEvents } from './events-digest';
export type { MyEventLine } from './events-digest';
export { formatMyChats } from './chats-digest';
export type { MyChatLine } from './chats-digest';
export { formatDiscovered } from './discover-digest';
export type { DiscoverLine } from './discover-digest';
export { formatPendingReviews } from './reviews-digest';
export type { PendingReviewLine } from './reviews-digest';
export { buildDigest, TELEGRAM_MESSAGE_LIMIT } from './digest';
export type { DigestInput } from './digest';
export { BOT_COMMANDS, helpCommandLines } from './commands';
export type { BotCommand } from './commands';

// ── Conversation wizards (ADR-0017) ─────────────────────────────────────────
export {
  WIZARD_CONTROLS,
  encodeWizardCallback,
  isWizardControl,
  parseWizardCallback,
} from './wizard/callback';
export type { WizardCallback, WizardControl } from './wizard/callback';
export {
  PERSIAN_WEEKDAYS,
  addDays,
  formatJalali,
  isoDay,
  jalaliMonthDays,
  jalaliMonthName,
  nextJalaliMonth,
  parseIsoDay,
  persianWeekday,
  previousJalaliMonth,
  tehranToday,
  toJalali,
} from './wizard/jalali';
export type { JalaliDate } from './wizard/jalali';
export { CHOICES_PER_PAGE, calendarKeyboard, choiceKeyboard, controlRow } from './wizard/keyboards';
export type { Choice } from './wizard/keyboards';
export { formatTehran } from './datetime';
export type { EventInvitationContent } from './invitation';

export { parseUpdate } from './update';
export type {
  BotIntent,
  BotInboundText,
  BotMessageEntity,
  BotSender,
  ParsedUpdate,
} from './update';

export {
  CHAT_CALLBACK_ACTIONS,
  encodeChatCallback,
  isPublicId,
  parseChatCallback,
} from './callback-data';
export type { ChatCallback, ChatCallbackAction } from './callback-data';

export { chatKeyboard, hostDecisionKeyboard, openAppButton, openAppKeyboard } from './keyboards';
export type { InlineButton, InlineKeyboard } from './keyboards';
