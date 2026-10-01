import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, type App } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { PERMISSIONS } from '@payetam/shared';
import { useSessionStore } from '@/stores/session';
import MessagesView from './MessagesView.vue';

const request = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();

vi.mock('@/api/client', () => ({
  request: (path: string, options?: unknown) => request(path, options),
  messageOf: (_cause: unknown, fallback: string) => fallback,
  setUnauthenticatedHandler: () => undefined,
  newIdempotencyKey: () => 'test-key-00000000',
}));

/**
 * «پیام به این کاربر» — the user page and the requests page link here with the
 * person already filled in, because the only other way was to copy a 36-character
 * id by hand. Sending is unchanged: preview, draft, then confirm from the list.
 */

const MILAD = 'f60ed962-621f-40b5-9bd8-9a82aab50df9';

let app: App | null = null;

async function mount(path: string, recipients = 1): Promise<HTMLElement> {
  request.mockImplementation((url: string) => {
    if (url === '/messages/preview') {
      return Promise.resolve({ recipients, appliedFilters: [], bodyText: 'سلام', parseMode: null });
    }
    return Promise.resolve({ campaigns: [], total: 0 });
  });

  const pinia = createPinia();
  setActivePinia(pinia);
  useSessionStore().session = {
    email: 'ops@payetam.test',
    displayName: 'ops',
    roles: [],
    permissions: [PERMISSIONS.MESSAGE_SEND],
  };
  // Every mutation button is disabled without the CSRF token a real `/me` hands out.
  useSessionStore().canMutate = true;

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/messages', name: 'messages', component: MessagesView }],
  });
  await router.push(path);

  const root = document.createElement('div');
  document.body.append(root);
  app = createApp({ render: () => h(RouterView) });
  app.use(pinia);
  app.use(router);
  app.mount(root);
  await vi.waitFor(() => expect(root.querySelector('textarea[dir="ltr"]')).not.toBeNull());
  return root;
}

async function previewWith(root: HTMLElement, text: string): Promise<void> {
  const body = root.querySelector<HTMLTextAreaElement>('textarea:not([dir])');
  body!.value = text;
  body!.dispatchEvent(new Event('input'));
  await nextTick();
  const button = [...root.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes('پیش‌نمایش گیرندگان'),
  );
  button!.click();
}

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
  request.mockReset();
});

describe('MessagesView, opened for one person', () => {
  it('fills the recipient in from the link', async () => {
    const root = await mount(`/messages?to=${MILAD}`);

    const ids = root.querySelector<HTMLTextAreaElement>('textarea[dir="ltr"]');
    expect(ids?.value).toBe(MILAD);
    const users = root.querySelector<HTMLInputElement>('input[type="radio"][value="users"]');
    expect(users?.checked).toBe(true);
  });

  it('says plainly when the message would reach nobody', async () => {
    const root = await mount(`/messages?to=${MILAD}`, 0);

    await previewWith(root, 'سلام میلاد');

    await vi.waitFor(() => expect(root.textContent).toContain('به این کاربر نمی‌رسد'));
  });

  it('opens empty without a link', async () => {
    const root = await mount('/messages');

    expect(root.querySelector<HTMLTextAreaElement>('textarea[dir="ltr"]')?.value).toBe('');
  });
});
