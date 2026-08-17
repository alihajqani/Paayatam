import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type {
  OwnReviewView,
  PendingReviewsResponse,
  PendingReviewView,
  SubmitReviewRequest,
  UserReviewsResponse,
} from '@payetam/shared';
import { newIdempotencyKey, request } from '@/api/client';

/**
 * Blind reviews (M11, ADR-0011 D7/D7a).
 *
 * Two properties this store must not undermine, because both are enforced on the
 * server and a client that assumed otherwise would render a lie:
 *
 *  - **Nothing of the counterparty's review is readable before reveal.** There is no
 *    contract for it anywhere in `@payetam/shared`; that absence is the feature, and
 *    it is why nothing here tries to fetch one.
 *  - **An edit window is not an edit right.** `editableUntil` goes null once the hour
 *    passes *or* the pair has revealed, and the server decides which — so the UI asks
 *    the field rather than doing its own arithmetic on `submittedAt`.
 */
export const useReviewsStore = defineStore('reviews', () => {
  const pending = ref<PendingReviewView[]>([]);
  const own = ref<Record<string, OwnReviewView | null>>({});
  const loading = ref(false);
  const submitting = ref(false);

  /** Only those whose window has actually opened; the rest are shown as waiting. */
  const openNow = computed(() => {
    const now = Date.now();
    return pending.value.filter((review) => new Date(review.opensAt).getTime() <= now);
  });

  async function loadPending(): Promise<void> {
    loading.value = true;
    try {
      const response = await request<PendingReviewsResponse>('/me/reviews/pending');
      pending.value = response.reviews;
    } finally {
      loading.value = false;
    }
  }

  async function loadOwn(participantPublicId: string): Promise<OwnReviewView | null> {
    const review = await request<OwnReviewView | null>(
      `/participants/${participantPublicId}/review`,
    );
    own.value = { ...own.value, [participantPublicId]: review };
    return review;
  }

  async function submit(
    participantPublicId: string,
    body: SubmitReviewRequest,
  ): Promise<OwnReviewView> {
    submitting.value = true;
    try {
      const review = await request<OwnReviewView>(`/participants/${participantPublicId}/review`, {
        method: 'POST',
        body,
        // One review per (participation, reviewer) is already a unique index, so this
        // is belt and braces — but the reward attached to it makes a double-submit
        // over a dropped connection worth naming rather than merely surviving.
        idempotencyKey: newIdempotencyKey(),
      });
      own.value = { ...own.value, [participantPublicId]: review };
      pending.value = pending.value.filter(
        (item) => item.participantPublicId !== participantPublicId,
      );
      return review;
    } finally {
      submitting.value = false;
    }
  }

  /** Within the hour, and only while the server still says so. */
  async function edit(
    participantPublicId: string,
    body: SubmitReviewRequest,
  ): Promise<OwnReviewView> {
    submitting.value = true;
    try {
      const review = await request<OwnReviewView>(`/participants/${participantPublicId}/review`, {
        method: 'PUT',
        body,
      });
      own.value = { ...own.value, [participantPublicId]: review };
      return review;
    } finally {
      submitting.value = false;
    }
  }

  /** The public reviews of one user — no reviewer named, by contract. */
  async function forUser(userPublicId: string): Promise<UserReviewsResponse> {
    return request<UserReviewsResponse>(`/users/${userPublicId}/reviews`);
  }

  return {
    pending,
    openNow,
    own,
    loading,
    submitting,
    loadPending,
    loadOwn,
    submit,
    edit,
    forUser,
  };
});
