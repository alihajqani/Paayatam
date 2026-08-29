import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import { setGateHandler } from './api/client';
import { useSessionStore } from './stores/session';
import { initTelegram } from './telegram/webapp';
import './styles/main.css';

// Before mount: the theme has to be on the document element for the first paint,
// or the app flashes white inside a dark client.
initTelegram();

const app = createApp(App);
const pinia = createPinia();

app.use(pinia).use(router);

/**
 * Recovering from a policy the user has not accepted yet (report 1).
 *
 * ── What was broken ──────────────────────────────────────────────────────────
 *
 * Every piece existed except the one that connects them. `pendingPolicies` is
 * read once at sign-in, so an admin publishing a new version mid-session left the
 * client believing nothing was outstanding while the server refused every gated
 * write with `POLICY_VERSION_STALE`. The user got «قوانین به‌روزرسانی شده است»
 * on a screen with no document and no accept button, and could not get to one:
 * `/terms` is only reached when the router already knows a policy is pending,
 * which is exactly the thing the client had no way to learn.
 *
 * ── Why it is registered here ────────────────────────────────────────────────
 *
 * The refusal can come back from any gated write, so the recovery has to sit
 * under all of them rather than in each view. Here is the one place that runs
 * once, has the router and the store, and is not itself a screen.
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 *
 * Re-reads `/me/policies` — the endpoint carries `@AllowPendingTerms` precisely
 * so somebody in this state can call it — and navigates only if something really
 * is outstanding. A refusal the client cannot corroborate changes nothing, which
 * matters because `TERMS_NOT_ACCEPTED` can also mean "this session is not what
 * you think it is", and bouncing somebody to a screen with an empty document
 * would be a worse dead end than the one being fixed.
 *
 * `/terms` rather than `stepFor`'s answer, because the guard runs on the way in
 * and will redirect again if the user belongs somewhere else — so this states the
 * intention and lets the one function that owns routing have the last word.
 *
 * Guarded against re-entry, because a screen that fires three requests on mount
 * would otherwise queue three reloads and three navigations.
 */
let recovering = false;

setGateHandler(() => {
  if (recovering) return;
  recovering = true;

  const session = useSessionStore(pinia);
  void session
    .loadMyPolicies()
    .then(async () => {
      if (session.pendingPolicies.length === 0) return;
      // `replace`, not `push`: the request that was refused is not something to
      // come back to with the browser's back button.
      await router.replace('/terms');
    })
    .catch(() => undefined)
    .finally(() => {
      recovering = false;
    });
});

app.mount('#app');
