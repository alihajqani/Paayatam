import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import './styles/main.css';

/**
 * No `initTelegram()`, and that is the whole difference from the Mini App's
 * entry point: this is not a Telegram surface (§3.7), so there is no theme to
 * apply before the first paint and no SDK to wait for.
 */
createApp(App).use(createPinia()).use(router).mount('#app');
