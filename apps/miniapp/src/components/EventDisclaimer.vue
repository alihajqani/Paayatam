<script setup lang="ts">
import { EVENT_DISCLAIMER_FA, EVENT_DISCLAIMER_SHORT_FA } from '@payetam/shared';

/**
 * "Payetam is not responsible; take care" — above every event (report 8).
 *
 * ── Why a component and not a line of markup ─────────────────────────────────
 *
 * It appears on the event page, above every list of events, and on the screen
 * that has just created one. A liability sentence copied into four templates is a
 * sentence that ends up in three versions, and the one missing a clause is the one
 * somebody quotes back. The text itself is in `@payetam/shared` because the bot
 * and the channel renderer say the same thing and must say it identically.
 *
 * ── The two sizes ───────────────────────────────────────────────────────────
 *
 * `compact` is the one-line form, for the head of a list where the full paragraph
 * would push the first event below the fold and train people to scroll past it.
 * The full form is used where somebody is deciding — the event page — because that
 * is the screen the sentence is actually for.
 *
 * `role="note"` rather than `alert`: it is standing context, not a response to
 * anything the user just did, and an alert role would have a screen reader
 * interrupt itself on every navigation.
 */
defineProps<{ compact?: boolean }>();
</script>

<template>
  <p
    class="rounded-xl bg-tg-secondary-bg px-4 py-3 text-tg-hint"
    :class="compact ? 'text-xs' : 'text-sm leading-6'"
    role="note"
  >
    {{ compact ? EVENT_DISCLAIMER_SHORT_FA : EVENT_DISCLAIMER_FA }}
  </p>
</template>
