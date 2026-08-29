import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { MembershipStateResponse } from '@payetam/shared';
import { request } from '@/api/client';

/**
 * Where the user stands with the required channels (v0.3.1).
 *
 * ── Its own store rather than a field on the session ─────────────────────────
 *
 * Two callers need it and they need different things from it. The router asks
 * "may this person be in the app at all?" on every navigation, which has to be a
 * synchronous read of something already loaded; `ChannelGate` asks "is *this*
 * operation blocked, and which channels are outstanding?" on a screen that can
 * afford to fetch. One store serves both because the answer is the same object —
 * and because two components each fetching it would ask twice on the screen that
 * renders both.
 *
 * ── It is a navigation aid, not the control ──────────────────────────────────
 *
 * `ChannelMembershipService.assertAllowed` runs inside the service that owns each
 * protected operation, so a client that skipped every screen here is still
 * refused. What this buys is that the user finds out *before* filling in a form,
 * and that they are shown a list of channels with buttons rather than a sentence.
 *
 * The one exception is `APP_ACCESS`, which has no server-side operation behind it
 * by design — see `GATED_ACTIONS` in the domain for why putting it in `AuthGuard`
 * would lock the product shut.
 */
export const useMembershipStore = defineStore('membership', () => {
  const state = ref<MembershipStateResponse | null>(null);
  const checking = ref(false);
  /** True once a load has settled, however it settled. The router waits on this. */
  const loaded = ref(false);

  /**
   * Whether the Mini App should refuse to render anything but the join screen.
   *
   * Three conditions, and all three are load-bearing: the requirement is on, it
   * covers `APP_ACCESS`, and this user is actually outstanding. A degraded probe
   * makes `allowed` true, so a Telegram outage does not empty the product.
   */
  const blocksApp = computed(
    () =>
      state.value !== null &&
      state.value.required &&
      state.value.requiredActions.includes('APP_ACCESS') &&
      !state.value.allowed,
  );

  /** The channels this user still owes, in the operator's order. */
  const outstanding = computed(
    () => state.value?.channels.filter((channel) => !channel.allowed) ?? [],
  );

  /**
   * Deliberately swallows its failure.
   *
   * The router reads `blocksApp` to decide where to send somebody, and a network
   * blip on this one call must not strand a signed-in user on a screen they cannot
   * leave. Failing to load leaves `state` null, which blocks nothing — the same
   * direction every other failure in this gate takes.
   */
  async function load(): Promise<void> {
    try {
      state.value = await request<MembershipStateResponse>('/me/channel-membership');
    } catch {
      state.value = null;
    } finally {
      loaded.value = true;
    }
  }

  /**
   * «بررسی دوباره» — ask Telegram again, now.
   *
   * The server clears its cached answer for **every** channel first, which is the
   * whole point: somebody who has just joined three of them must not be told for
   * another two minutes that they have joined none.
   *
   * Unlike `load`, this one throws: it is a button the user pressed, and a silent
   * failure would look like "you are still not a member".
   */
  async function recheck(): Promise<MembershipStateResponse> {
    checking.value = true;
    try {
      const next = await request<MembershipStateResponse>('/me/channel-membership/check', {
        method: 'POST',
      });
      state.value = next;
      loaded.value = true;
      return next;
    } finally {
      checking.value = false;
    }
  }

  /** Whether one specific operation is blocked right now. */
  function blocks(action: MembershipStateResponse['requiredActions'][number]): boolean {
    if (state.value === null || !state.value.required) return false;
    return state.value.requiredActions.includes(action) && !state.value.allowed;
  }

  return { state, checking, loaded, blocksApp, outstanding, load, recheck, blocks };
});
