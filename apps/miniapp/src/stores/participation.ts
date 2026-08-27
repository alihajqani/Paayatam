import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type {
  CancellationPreviewResponse,
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
export const useParticipationStore = defineStore('participation', () => {
  const mine = ref<ParticipationView[]>([]);
  const loading = ref(false);
  const joining = ref(false);

  /** Indexed by event, so a detail screen can ask "have I already asked?" in O(1). */
  const byEvent = computed(() => {
    const map = new Map<string, ParticipationView>();
    for (const participation of mine.value) map.set(participation.eventPublicId, participation);
    return map;
  });

  /** The states in which a request is still alive and a second one is meaningless. */
  const LIVE_STATUSES = new Set(['PENDING', 'WAITLISTED', 'ACCEPTED']);

  function liveFor(eventPublicId: string): ParticipationView | null {
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

  function remember(participation: ParticipationView): void {
    const index = mine.value.findIndex((existing) => existing.publicId === participation.publicId);
    if (index === -1) mine.value = [participation, ...mine.value];
    else mine.value = mine.value.map((existing, at) => (at === index ? participation : existing));
  }

  /**
   * Ask to join, and say hello in the same tap (report 6).
   *
   * ── Why the note is a second request and not a field ─────────────────────
   *
   * `POST /events/:id/join` takes no body by design — "everything that decides
   * the outcome is on the server; there is no field here for a client to be
   * wrong or dishonest about". A `note` on that request would put user text into
   * the one endpoint whose contract is that it carries none, and would need the
   * whole relay — the sanitizer, the contact masking, the cipher — reachable
   * from inside the join transaction to handle it.
   *
   * So the note goes through the **relay that already exists**, immediately
   * after, against the chat the join just created. Two requests, one user
   * action, and the message is masked and encrypted by exactly the same code
   * path as every other message in the conversation.
   *
   * ── Why a failed note does not fail the join ─────────────────────────────
   *
   * They are different outcomes and only one of them is scarce. The seat is
   * taken and the host has been notified; losing the greeting to a dropped
   * connection is a message the guest can retype in the bot, while rolling back
   * the request would hand the seat to somebody else over a network blip. So the
   * note is best-effort and the caller is told whether it arrived.
   */
  async function join(
    eventPublicId: string,
    note?: string,
  ): Promise<{ participation: ParticipationView; noteSent: boolean }> {
    joining.value = true;
    try {
      const participation = await request<ParticipationView>(`/events/${eventPublicId}/join`, {
        method: 'POST',
      });
      remember(participation);

      const trimmed = note?.trim() ?? '';
      if (trimmed === '' || participation.chatPublicId === null) {
        return { participation, noteSent: false };
      }

      try {
        await request(`/chats/${participation.chatPublicId}/messages`, {
          method: 'POST',
          body: { text: trimmed },
        });
        return { participation, noteSent: true };
      } catch {
        return { participation, noteSent: false };
      }
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
