import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { FileReportRequest, FileReportResponse, ReportTargetType } from '@payetam/shared';
import { request } from '@/api/client';

/**
 * Which endpoint a target type reports to. One report per (target, reporter).
 *
 * `MESSAGE` is absent, and the map is a `Partial` because of it: v0.8.0 removed
 * the anonymous conversation and `POST /chats/:id/report` with it, so there is no
 * longer anything a user can report under that type. The enum value stays — it is
 * a Postgres enum with rows behind it, and a moderator still reads cases about
 * conversations that were reported while they existed.
 */
const PATH_FOR: Partial<Record<ReportTargetType, (publicId: string) => string>> = {
  EVENT: (publicId) => `/events/${publicId}/report`,
  USER: (publicId) => `/users/${publicId}/report`,
  REVIEW: (publicId) => `/reviews/${publicId}/report`,
};

/**
 * Reporting (M12).
 *
 * The response says whether *this* report was the one that crossed the auto-hide
 * threshold, and nothing else about the others: a count would let somebody probe how
 * close a rival's event is to being hidden. The UI therefore has exactly two things
 * to say, and this store passes through which one applies.
 *
 * No idempotency key: one report per (target, reporter) is a unique index, so a
 * duplicate is already impossible in the database rather than merely discouraged.
 */
export const useModerationStore = defineStore('moderation', () => {
  const submitting = ref(false);

  async function report(
    target: ReportTargetType,
    publicId: string,
    body: FileReportRequest,
  ): Promise<FileReportResponse> {
    const path = PATH_FOR[target];
    // A target this build cannot report. Refused here rather than sent to a route
    // that does not exist, so the caller gets a reason instead of a 404.
    if (path === undefined) throw new Error(`no report endpoint for ${target}`);

    submitting.value = true;
    try {
      return await request<FileReportResponse>(path(publicId), {
        method: 'POST',
        body,
      });
    } finally {
      submitting.value = false;
    }
  }

  return { submitting, report };
});
