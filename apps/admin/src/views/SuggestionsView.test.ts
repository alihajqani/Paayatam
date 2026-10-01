import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, type App } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import { PERMISSIONS } from '@payetam/shared';
import { useSessionStore } from '@/stores/session';
import SuggestionsView from './SuggestionsView.vue';

const request = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();

vi.mock('@/api/client', () => ({
  request: (path: string, options?: unknown) => request(path, options),
  messageOf: (_cause: unknown, fallback: string) => fallback,
  setUnauthenticatedHandler: () => undefined,
  newIdempotencyKey: () => 'test-key-00000000',
}));

/**
 * Event suggestions (migration 0064). The operator finds a real programme, fills
 * a short form, and copies the link into a channel post they write by hand —
 * so the two things this screen must get exactly right are the link and the
 * time, which the operator types in Tehran's wall clock.
 */

const CITY = '0199a8f0-0000-7000-8000-000000000001';
const CATEGORY = '0199a8f0-0000-7000-8000-000000000002';
const SUGGESTION = '6d653636-1573-4746-9dd3-a2fb517bc8c9';

const LISTED = {
  publicId: SUGGESTION,
  cityId: CITY,
  cityNameFa: 'مشهد',
  categoryId: CATEGORY,
  categoryNameFa: 'سینما',
  title: 'اکران فیلم در هویزه',
  description: 'سانس هفت و نیم، بلیت را خودمان می‌خریم.',
  venueLabel: 'سینما هویزه',
  startsAt: '2026-10-09T16:00:00.000Z',
  durationHours: 2,
  capacity: 4,
  costType: 'FREE',
  costAmount: null,
  externalLink: null,
  createdAt: '2026-10-01T09:00:00.000Z',
  closedAt: null,
  isOpen: true,
  eventCount: 1,
  startPayload: `host_${SUGGESTION}`,
};

let app: App | null = null;

async function mount(): Promise<HTMLElement> {
  request.mockImplementation((url: string, options?: unknown) => {
    const method = (options as { method?: string } | undefined)?.method ?? 'GET';
    if (url === '/suggestions' && method === 'GET') {
      return Promise.resolve({
        suggestions: [LISTED],
        botUsername: 'paayatambot',
        cities: [{ id: CITY, nameFa: 'مشهد' }],
        categories: [{ id: CATEGORY, nameFa: 'سینما' }],
      });
    }
    return Promise.resolve({ ...LISTED, isOpen: false });
  });

  const pinia = createPinia();
  setActivePinia(pinia);
  useSessionStore().session = {
    email: 'ops@payetam.test',
    displayName: 'ops',
    roles: [],
    permissions: [PERMISSIONS.SUGGESTION_MANAGE],
  };
  useSessionStore().canMutate = true;

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/suggestions', name: 'suggestions', component: SuggestionsView }],
  });
  await router.push('/suggestions');

  const root = document.createElement('div');
  document.body.append(root);
  app = createApp({ render: () => h(RouterView) });
  app.use(pinia);
  app.use(router);
  app.mount(root);
  await vi.waitFor(() => expect(root.textContent).toContain('اکران فیلم در هویزه'));
  return root;
}

function field(root: HTMLElement, name: string): HTMLInputElement | HTMLSelectElement {
  const element = root.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`);
  if (element === null) throw new Error(`no field ${name}`);
  return element;
}

async function fill(root: HTMLElement, name: string, value: string): Promise<void> {
  const element = field(root, name);
  element.value = value;
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input'));
  await nextTick();
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(label),
  );
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
}

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
  request.mockReset();
});

describe('SuggestionsView', () => {
  it('shows the link to paste, built from the bot and the payload', async () => {
    const root = await mount();

    expect(root.textContent).toContain(`https://t.me/paayatambot?start=host_${SUGGESTION}`);
  });

  /** 19:30 typed in Tehran is 16:00 UTC; the API takes an instant. */
  it('sends the time the operator typed, as Tehran’s', async () => {
    const root = await mount();

    await fill(root, 'cityId', CITY);
    await fill(root, 'categoryId', CATEGORY);
    await fill(root, 'title', 'اکران فیلم در هویزه');
    await fill(root, 'description', 'سانس هفت و نیم، بلیت را خودمان می‌خریم.');
    await fill(root, 'venueLabel', 'سینما هویزه');
    await fill(root, 'date', '2026-10-09');
    await fill(root, 'time', '19:30');
    button(root, 'ساختن پیشنهاد').click();

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        '/suggestions',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({
            cityId: CITY,
            categoryId: CATEGORY,
            startsAt: '2026-10-09T16:00:00.000Z',
            durationHours: 2,
            capacity: 4,
            costType: 'FREE',
          }) as unknown,
        }),
      ),
    );
  });

  it('closes a suggestion', async () => {
    const root = await mount();

    button(root, 'بستن').click();

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        `/suggestions/${SUGGESTION}/close`,
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
  });
});
