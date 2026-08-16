import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import { initTelegram } from './telegram/webapp';
import './styles/main.css';

// Before mount: the theme has to be on the document element for the first paint,
// or the app flashes white inside a dark client.
initTelegram();

createApp(App).use(createPinia()).use(router).mount('#app');
