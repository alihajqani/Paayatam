/**
 * Persian for every coin ledger type.
 *
 * ── Why this moved out of `LedgerView` ──────────────────────────────────────
 *
 * It lived there as a local `TYPES` map, and by the time a second screen needed
 * it the map was **missing five types**: the three M22 sinks, the join charge and
 * the campaign grant had all been added to the enum without anybody remembering
 * a Vue file three directories away. The filter dropdown silently could not
 * select them and a row of that type rendered its raw `SCREAMING_CASE` name.
 *
 * One map, in the format layer beside the other display helpers, so the next
 * type is added in one place — and `ledgerTypeLabel` falls back to the raw value
 * rather than to an empty cell, because a name a reader does not recognise is
 * still better than a blank.
 */
export const LEDGER_TYPE_LABELS: Record<string, string> = {
  ONBOARDING_REWARD: 'پاداش تکمیل نمایه',
  FOUNDING_REWARD: 'هدیهٔ کمپین هزار نفر',
  REFERRAL_REWARD: 'پاداش معرفی دوستان',
  REVIEW_REWARD: 'پاداش نوشتن نظر',
  GIFT_CODE_REDEEM: 'دریافت کد هدیه',
  HOST_REWARD: 'پاداش میزبانی',
  COMEBACK_GRANT: 'سکهٔ بازگشت',
  EVENT_DEPOSIT_REFUND: 'بازگشت سپردهٔ ثبت رویداد',
  HOST_CANCELLATION_REFUND: 'بازپرداخت لغو میزبان',
  ADMIN_ADJUSTMENT: 'اصلاح دستی مدیر',
  REVERSAL: 'برگشت تراکنش',
  EVENT_CREATE_SPEND: 'ثبت رویداد',
  CHANNEL_POST_SPEND: 'انتشار در کانال',
  INVITE_SPEND: 'دعوت هدفمند',
  EVENT_JOIN_SPEND: 'درخواست شرکت',
  BOOST_SPEND: 'ارتقای نمایش',
  VIP_SPEND: 'نمایش ویژه',
  CANCELLATION_PENALTY: 'جریمهٔ لغو',
  NO_SHOW_PENALTY: 'جریمهٔ غیبت',
};

export function ledgerTypeLabel(type: string): string {
  return LEDGER_TYPE_LABELS[type] ?? type;
}
