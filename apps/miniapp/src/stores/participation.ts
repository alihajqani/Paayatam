import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type {
  CancellationPreviewResponse,
  MyParticipationView,
  MyParticipationsResponse,
  ParticipationView,
} from '@payetam/shared';
import { request } from '@/api/client';

/**
 * Asking to join, and what happened afterwards.
 *
 * The join endpoint answers 201 with either `PENDING` (a seat was held) or
 * `WAITLISTED` with a rank — from the caller's side it is one request and only the
 * server knows which it was, so the UI branches on the response rather than
 * predicting it from `remainingCapacity`. Predicting it would be wrong exactly when
 * it matters: two people tapping join on the last seat.
 */
/**
 * A list entry as the store holds it.
 *
 * **`event` is optional here and required on the wire, and the gap is real rather
 * than defensive.** `loadMine` gets the title from the server; an entry inserted
 * optimistically from a join response carries only what that response returned,
 * and inventing a title for it would be a lie the UI then renders. The one
 * consumer that runs before a reload is `liveFor`, which needs `status` and
 * `eventPublicId` — never a title — and the screen that shows titles calls
 * `loadMine` on mount.
 */
type StoredParticipation = ParticipationView & Partial<Pick<MyParticipationView, 'event'>>;

export const useParticipationStore = defineStore('participation', () => {
  const mine = ref<StoredParticipation[]>([]);
  const loading = ref(false);
  const joining = ref(false);

  /** Indexed by event, so a detail screen can ask "have I already asked?" in O(1). */
  const byEvent = computed(() => {
    const map = new Map<string, StoredParticipation>();
    for (const participation of mine.value) map.set(participation.eventPublicId, participation);
    return map;
  });

  /** The states in which a request is still alive and a second one is meaningless. */
  const LIVE_STATUSES = new Set(['PENDING', 'WAITLISTED', 'ACCEPTED']);

  function liveFor(eventPublicId: string): StoredParticipation | null {
    const existing = byEvent.value.get(eventPublicId);
    return existing && LIVE_STATUSES.has(existing.status) ? existing : null;
  }

  async function loadMine(): Promise<void> {
    loading.value = true;
    try {
      const response = await request<MyParticipationsResponse>('/me/participations');
      mine.value = response.participations;
    } finally {
      loading.value = false;
    }
  }

  /**
   * Merge rather than replace, so an action response does not erase the title the
   * list already loaded — `participation` has no `event` key, so the spread keeps
   * the one that is there.
   */
  function remember(participation: ParticipationView): void {
    const index = mine.value.findIndex((existing) => existing.publicId === participation.publicId);
    if (index === -1) mine.value = [participation, ...mine.value];
    else
      mine.value = mine.value.map((existing, at) =>
        at === index ? { ...existing, ...participation } : existing,
      );
  }

  /**
   * Ask to join, and nothing else (v0.8.0).
   *
   * It used to carry an optional note to the host, sent as a second request into
   * the anonymous conversation the join had just created — `POST /events/:id/join`
   * takes no body by design, so the greeting went through the relay rather than
   * through the join. Both the relay and the conversation are gone, and writing to
   * a host is now «پیام مستقیم به میزبان» in the bot, which needs no request first
   * and works for somebody who has not decided to join at all.
   */
  async function join(eventPublicId: string): Promise<ParticipationView> {
    joining.value = true;
    try {
      const participation = await request<ParticipationView>(`/events/${eventPublicId}/join`, {
        method: 'POST',
      });
      remember(participation);
      return participation;
    } finally {
      joining.value = false;
    }
  }

  /** The dry run behind the cancellation dialog: what it costs, before it costs it. */
  async function cancelPreview(publicId: string): Promise<CancellationPreviewResponse> {
    return request<CancellationPreviewResponse>(`/participants/${publicId}/cancel-preview`);
  }

  async function cancel(publicId: string, reason?: string): Promise<ParticipationView> {
    const participation = await request<ParticipationView>(`/participants/${publicId}/cancel`, {
      method: 'POST',
      ...(reason ? { body: { reason } } : {}),
    });
    remember(participation);
    return participation;
  }

  /**
   * The host's decision, from the Mini App.
   *
   * The same service the bot's inline buttons reach, so a host who accepts here and
   * a host who accepts from the notification take exactly one code path. Ownership
   * is asserted in the service (T3.2), not by this store being careful.
   */
  async function accept(participantPublicId: string): Promise<ParticipationView> {
    return request<ParticipationView>(`/participants/${participantPublicId}/accept`, {
      method: 'POST',
    });
  }

  async function reject(participantPublicId: string): Promise<ParticipationView> {
    return request<ParticipationView>(`/participants/${participantPublicId}/reject`, {
      method: 'POST',
    });
  }

  return {
    mine,
    loading,
    joining,
    byEvent,
    liveFor,
    loadMine,
    join,
    cancelPreview,
    cancel,
    accept,
    reject,
  };
});
