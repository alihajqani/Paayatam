import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type {
  CancellationPreviewResponse,
  CreateEventRequest,
  DiscoveredEventView,
  DiscoveryQueryRequest,
  DiscoveryResponse,
  EventParticipantsResponse,
  EventView,
  HostCancellationPreviewResponse,
  MyEventsResponse,
  ParticipantSummaryView,
  UpdateEventRequest,
} from '@payetam/shared';
import { request } from '@/api/client';

/**
 * Discovery and event authoring.
 *
 * One store for both because they are two views of the same noun and always change
 * together — a host who publishes an event expects to find it in the list.
 *
 * Discovery is cursor-paginated (M5). The cursor is opaque by contract: it is held
 * and handed back, never parsed. `hasMore` is derived from its presence rather than
 * from comparing counts, because the server is the only thing that knows whether a
 * page was the last one.
 */

/** The filter set the discovery screen edits. Empty values are omitted from the query. */
export interface DiscoveryFilters {
  q: string;
  cityId: string;
  districtId: string;
  categoryId: string;
  timeOfDay: string;
  costType: string;
  hasCapacity: boolean;
  ageFits: boolean;
  sort: string;
}

export function emptyFilters(): DiscoveryFilters {
  return {
    q: '',
    cityId: '',
    districtId: '',
    categoryId: '',
    timeOfDay: '',
    costType: '',
    // Defaulting these on is a product decision, not a technical one: an event
    // somebody cannot join or does not fit is noise on a first screen.
    hasCapacity: true,
    ageFits: true,
    sort: 'RELEVANCE',
  };
}

/** Only the fields that carry a value, so the URL says what was actually asked. */
function toQueryString(filters: DiscoveryFilters, cursor: string | null): string {
  const params = new URLSearchParams();
  const put = (key: keyof DiscoveryQueryRequest, value: string): void => {
    if (value !== '') params.set(key, value);
  };

  put('q', filters.q.trim());
  put('cityId', filters.cityId);
  put('districtId', filters.districtId);
  put('categoryId', filters.categoryId);
  put('timeOfDay', filters.timeOfDay);
  put('costType', filters.costType);
  put('sort', filters.sort);
  // The server parses these as the literal strings 'true'/'false' — it refuses
  // `z.coerce.boolean()` precisely so `hasCapacity=false` cannot mean its opposite.
  if (filters.hasCapacity) params.set('hasCapacity', 'true');
  if (filters.ageFits) params.set('ageFits', 'true');
  if (cursor !== null) params.set('cursor', cursor);

  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export const useEventsStore = defineStore('events', () => {
  const filters = ref<DiscoveryFilters>(emptyFilters());
  const results = ref<DiscoveredEventView[]>([]);
  const cursor = ref<string | null>(null);
  const discovering = ref(false);
  const loadingMore = ref(false);

  const detail = ref<DiscoveredEventView | null>(null);
  const loadingDetail = ref(false);

  const myEvents = ref<EventView[]>([]);
  const loadingMine = ref(false);

  const participants = ref<ParticipantSummaryView[]>([]);
  const loadingParticipants = ref(false);

  const hasMore = computed(() => cursor.value !== null);
  const isEmpty = computed(() => !discovering.value && results.value.length === 0);

  /** First page. Replaces whatever was there, so a filter change cannot append. */
  async function discover(): Promise<void> {
    discovering.value = true;
    try {
      const response = await request<DiscoveryResponse>(
        `/events${toQueryString(filters.value, null)}`,
      );
      results.value = response.events;
      cursor.value = response.nextCursor ?? null;
    } finally {
      discovering.value = false;
    }
  }

  async function loadMore(): Promise<void> {
    if (cursor.value === null || loadingMore.value) return;
    loadingMore.value = true;
    try {
      const response = await request<DiscoveryResponse>(
        `/events${toQueryString(filters.value, cursor.value)}`,
      );
      results.value = [...results.value, ...response.events];
      cursor.value = response.nextCursor ?? null;
    } finally {
      loadingMore.value = false;
    }
  }

  function resetFilters(): void {
    filters.value = emptyFilters();
  }

  async function loadEvent(publicId: string): Promise<DiscoveredEventView> {
    loadingDetail.value = true;
    try {
      const event = await request<DiscoveredEventView>(`/events/${publicId}`);
      detail.value = event;
      return event;
    } finally {
      loadingDetail.value = false;
    }
  }

  async function loadMyEvents(): Promise<void> {
    loadingMine.value = true;
    try {
      const response = await request<MyEventsResponse>('/me/events');
      myEvents.value = response.events;
    } finally {
      loadingMine.value = false;
    }
  }

  async function create(body: CreateEventRequest): Promise<EventView> {
    const event = await request<EventView>('/events', { method: 'POST', body });
    // Prepend rather than refetch: the host has just been told it exists, and a
    // list that does not show it reads as a failure.
    myEvents.value = [event, ...myEvents.value];
    return event;
  }

  async function update(publicId: string, body: UpdateEventRequest): Promise<EventView> {
    const event = await request<EventView>(`/events/${publicId}`, { method: 'PATCH', body });
    myEvents.value = myEvents.value.map((existing) =>
      existing.publicId === publicId ? event : existing,
    );
    return event;
  }

  /** The dry run the cancellation dialog is built on (M10). Never mutates anything. */
  async function cancelPreview(publicId: string): Promise<HostCancellationPreviewResponse> {
    return request<HostCancellationPreviewResponse>(`/events/${publicId}/cancel-preview`);
  }

  async function cancel(publicId: string, reason: string): Promise<void> {
    await request(`/events/${publicId}/cancel`, { method: 'POST', body: { reason } });
    await loadMyEvents();
  }

  async function loadParticipants(eventPublicId: string): Promise<void> {
    loadingParticipants.value = true;
    try {
      const response = await request<EventParticipantsResponse>(
        `/events/${eventPublicId}/participants`,
      );
      participants.value = response.participants;
    } finally {
      loadingParticipants.value = false;
    }
  }

  return {
    filters,
    results,
    cursor,
    discovering,
    loadingMore,
    hasMore,
    isEmpty,
    detail,
    loadingDetail,
    myEvents,
    loadingMine,
    participants,
    loadingParticipants,
    discover,
    loadMore,
    resetFilters,
    loadEvent,
    loadMyEvents,
    create,
    update,
    cancelPreview,
    cancel,
    loadParticipants,
  };
});

export type { CancellationPreviewResponse };
