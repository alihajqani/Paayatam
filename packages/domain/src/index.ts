export { InitDataValidator, DEFAULT_MAX_AGE_SECONDS } from './identity/init-data.validator';
export type { InitDataUser, ParsedInitData } from './identity/init-data.validator';

export { InitDataReplayGuard, INIT_DATA_REPLAY_PREFIX } from './identity/replay-guard';
export { SessionService, parseDuration } from './identity/session.service';
export type { SessionTokens, AccessTokenClaims } from './identity/session.service';

export { UserService, isUniqueViolation } from './identity/user.service';
export type { PublicUser } from './identity/user.service';

export { ConsentService } from './identity/consent.service';
export type { CurrentPolicy, ConsentContextInfo } from './identity/consent.service';

export { IdentityModule, INIT_DATA_VALIDATOR } from './identity/identity.module';

export { AuditService } from './audit/audit.service';
export type { AuditEntry } from './audit/audit.service';
export { AuditModule } from './audit/audit.module';

export { CatalogService } from './catalog/catalog.service';
export type { CatalogSnapshot, NamedRef, ResolvedLocation } from './catalog/catalog.service';
export { SettingsService, SETTING_DEFAULTS } from './catalog/settings.service';
export type { SettingKey } from './catalog/settings.service';
export { CatalogModule } from './catalog/catalog.module';

export { CoinService } from './economy/coin.service';
export type { CoinMovement, CoinMovementInput } from './economy/coin.service';
export { EconomyModule } from './economy/economy.module';

export { ageFromBirthYear, gregorianYearIn, isOldEnough } from './profile/age';
export {
  ProfileService,
  ONBOARDING_REWARD_REASON,
  onboardingRewardKey,
} from './profile/profile.service';
export type {
  CompleteProfileInput,
  ProfileCompletion,
  ProfileDetail,
} from './profile/profile.service';
export { ProfileModule } from './profile/profile.module';

export { gregorianYearIn as gregorianYearInZone, startOfDayIn } from './time';

export { assertTransition, canTransition, terminalStates } from './state-machine';
export type { TransitionTable } from './state-machine';

export {
  normalize,
  tokenize,
  toNfc,
  foldArabicLetters,
  removeDiacritics,
  foldZeroWidth,
  unifyDigits,
  unifyPunctuation,
  collapseWhitespace,
  collapseRepetition,
  mapHomoglyphs,
  foldCase,
} from './moderation/persian-normalizer';
export { BlacklistService } from './moderation/blacklist.service';
export type { Blacklist, BlacklistMatch, BlacklistRule } from './moderation/blacklist.service';
export { ModerationService, decisionFor } from './moderation/moderation.service';
export type { ContentScan, ModerationDecision } from './moderation/moderation.service';
export { ModerationModule } from './moderation/moderation.module';

export {
  EVENT_TRANSITIONS,
  ACTIVE_EVENT_STATUSES,
  assertEventTransition,
} from './events/state-machine';
export { EventService } from './events/event.service';
export type { CreateEventInput, UpdateEventInput, EventDetail } from './events/event.service';
export { EventsModule } from './events/events.module';
