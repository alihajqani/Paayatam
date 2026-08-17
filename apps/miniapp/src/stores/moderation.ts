import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { FileReportRequest, FileReportResponse, ReportTargetType } from '@payetam/shared';
import { request } from '@/api/client';

/** Which endpoint a target type reports to. One report per (target, reporter). */
const PATH_FOR: Record<ReportTargetType, (publicId: string) => string> = {
  EVENT: (publicId) => `/events/${publicId}/report`,
  USER: (publicId) => `/users/${publicId}/report`,
  REVIEW: (publicId) => `/reviews/${publicId}/report`,
  MESSAGE: (publicId) => `/chats/${publicId}/report`,
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
    submitting.value = true;
    try {
      return await request<FileReportResponse>(PATH_FOR[target](publicId), {
        method: 'POST',
        body,
      });
    } finally {
      submitting.value = false;
    }
  }

  return { submitting, report };
});
