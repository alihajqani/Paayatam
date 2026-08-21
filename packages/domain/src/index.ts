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

export { OutboxService } from './outbox/outbox.service';
export type { DomainEvent } from './outbox/outbox.service';
export { OutboxModule } from './outbox/outbox.module';

export { CatalogService } from './catalog/catalog.service';
export type { CatalogSnapshot, NamedRef, ResolvedLocation } from './catalog/catalog.service';
export { SettingsService, SETTING_DEFAULTS } from './catalog/settings.service';
export type { SettingKey } from './catalog/settings.service';
export { CatalogModule } from './catalog/catalog.module';

export { CoinService, reversalKey } from './economy/coin.service';
export type { CoinEntry, CoinMovement, CoinMovementInput } from './economy/coin.service';
export {
  TrustService,
  TRUST_ALGO_VERSION,
  TRUST_MIN_SCORE,
  TRUST_MAX_SCORE,
  TRUST_INITIAL_REASON,
  TRUST_PROFILE_COMPLETE_REASON,
  clampScore,
  trustInitialKey,
} from './economy/trust.service';
export type { TrustEntry, TrustMovement, TrustMovementInput } from './economy/trust.service';
export {
  PenaltyService,
  bucketForLateness,
  CANCEL_PENALTY_REASON,
  NO_SHOW_PENALTY_REASON,
  HOST_PENALTY_REASON,
  HOST_REFUND_REASON,
  hostPenaltyKey,
  participantPenaltyKey,
} from './economy/penalty.service';
export type { ChargedPenalty, PenaltyPrice } from './economy/penalty.service';
export {
  ReferralService,
  REFERRAL_REFERRER_REASON,
  REFERRAL_REFERRED_REASON,
  normalizeCode,
  referredRewardKey,
  referrerRewardKey,
} from './economy/referral.service';
export type { ReferralClaim, ReferralSummary } from './economy/referral.service';
export {
  GiftCodeService,
  GIFT_CODE_REASON,
  giftCodeRedemptionKey,
} from './economy/gift-code.service';
export type { RedeemedGiftCode } from './economy/gift-code.service';
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
export {
  EventService,
  EVENT_BOOST_REASON,
  EVENT_VIP_REASON,
  boostSpendKey,
  extendedBoost,
  vipSpendKey,
} from './events/event.service';
export type {
  BoostKind,
  CancelledParticipant,
  CreateEventInput,
  UpdateEventInput,
  EventCancellation,
  EventDetail,
  HostCancellationPreview,
} from './events/event.service';
export { EventLifecycleService, ATTENDANCE_REASON } from './events/lifecycle.service';
export type { SettlementResult } from './events/lifecycle.service';
export { EventsModule } from './events/events.module';

export {
  PARTICIPANT_TRANSITIONS,
  SEAT_HOLDING_STATUSES,
  LIVE_PARTICIPANT_STATUSES,
  assertParticipantTransition,
  holdsSeat,
} from './participation/state-machine';
export { ParticipationService } from './participation/participation.service';
export type {
  ParticipationDetail,
  ParticipantSummary,
  CancellationPreview,
} from './participation/participation.service';
export { ParticipationModule } from './participation/participation.module';

export {
  CHAT_TRANSITIONS,
  LIVE_CHAT_STATUSES,
  assertChatTransition,
  isLiveChat,
} from './chat/state-machine';
export { HOST_ALIAS, HOST_ALIAS_INDEX, guestAlias, toPersianDigits } from './chat/alias';
export { REDACTION_PLACEHOLDER, sanitizeInbound } from './chat/sanitizer';
export type { Redaction, RedactionKind, SanitizeOptions, SanitizedMessage } from './chat/sanitizer';
export type { InboundTextMessage, MessageEntity } from './chat/inbound-message';
export { CURRENT_KEY_VERSION, MessageCipher } from './chat/message-cipher';
export type { EncryptedBody } from './chat/message-cipher';
export {
  CHAT_ANONYMOUS_INTRO,
  CHAT_CLOSED_NOTICE,
  CHAT_MESSAGE_DELETED,
  CHAT_OPENED,
  chatContactShared,
} from './chat/messages';
export { ChatService, RETENTION_DAYS_AFTER_CLOSE, masksContactDetails } from './chat/chat.service';
export type { ChatMessageDetail, ChatPage, ChatSummary, CreatedChat } from './chat/chat.service';
export { ChatModule } from './chat/chat.module';

export { encodeCursor, decodeCursor } from './discovery/cursor';
export type { DiscoveryCursor, DiscoverySort } from './discovery/cursor';
export { SEARCH_PROVIDER } from './discovery/search-provider';
export type {
  DiscoveredEvent,
  DiscoveryFilters,
  RankExplanation,
  RankingWeights,
  SearchProvider,
  SearchRequest,
  TimeOfDay,
} from './discovery/search-provider';
export { PostgresSearchProvider } from './discovery/postgres-search.provider';
export { DiscoveryService } from './discovery/discovery.service';
export type { DiscoveryPage, DiscoveryQuery } from './discovery/discovery.service';
export { DiscoveryModule } from './discovery/discovery.module';

export {
  ReviewService,
  REVIEW_REWARD_REASON,
  REVIEW_RATING_REASON,
  reviewRewardKey,
  reviewTrustKey,
} from './reviews/review.service';
export type {
  OwnReview,
  PendingReview,
  RevealedReview,
  ReviewerRole,
  SubmitReviewInput,
} from './reviews/review.service';
export {
  REVIEW_TRANSITIONS,
  REVIEW_PAIR_TRANSITIONS,
  REVEALED_PAIR_STATUSES,
  assertReviewTransition,
  assertReviewPairTransition,
} from './reviews/state-machine';
export { ReviewsModule } from './reviews/reviews.module';

export { ReportService } from './moderation/report.service';
export type { FileReportInput, FiledReport } from './moderation/report.service';

export {
  PERMISSIONS,
  ROLE_KEYS,
  ROLE_PERMISSIONS,
  ROLE_NAMES_FA,
  roleHas,
} from './adminaccess/permissions';
export type { Permission, RoleKey } from './adminaccess/permissions';
export { base32Decode, base32Encode, totpCode, verifyTotp } from './adminaccess/totp';
export { AdminCredentials, MIN_PASSWORD_LENGTH } from './adminaccess/admin-credentials';
export {
  AdminAccessService,
  MAX_FAILED_ATTEMPTS,
  permissionsFor,
} from './adminaccess/admin-access.service';
export type { AdminSession, LoginResult } from './adminaccess/admin-access.service';
export { AdminOperationsService, adminAdjustmentKey } from './adminaccess/admin-operations.service';
export type { CaseSummary } from './adminaccess/admin-operations.service';
export { GiftCodeAdminService } from './adminaccess/gift-code-admin.service';
export type { CreateGiftCodeInput, GiftCodeSummary } from './adminaccess/gift-code-admin.service';
export { ChatUnsealService } from './adminaccess/chat-unseal.service';
export type { UnsealGrant, UnsealedMessage } from './adminaccess/chat-unseal.service';
export { AdminAccessModule } from './adminaccess/adminaccess.module';

export { NotificationService } from './notifications/notification.service';
export type { NotificationToSend, QueuedNotification } from './notifications/notification.service';
export { planNotifications } from './notifications/fanout';
export type { PlannedNotification } from './notifications/fanout';
export { NotificationsModule } from './notifications/notifications.module';
export { OutboxRelayService } from './outbox/relay.service';
export type { RelayResult } from './outbox/relay.service';

export { ChannelService } from './channel/channel.service';
export type { PublishablePost, TakedownTarget } from './channel/channel.service';
export { ChannelModule } from './channel/channel.module';

export { AnonymizationService, ANONYMOUS_DISPLAY_NAME } from './privacy/anonymization.service';
export type { AnonymizationResult } from './privacy/anonymization.service';
export { RetentionService, RETENTION } from './privacy/retention.service';
export type { PurgeResult } from './privacy/retention.service';
export { PrivacyModule } from './privacy/privacy.module';
