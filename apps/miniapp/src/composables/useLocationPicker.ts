import { computed, ref, watch, type Ref } from 'vue';
import { useSessionStore } from '@/stores/session';

/**
 * The province → city → district cascade, shared by the three screens that ask
 * where somebody is (M21).
 *
 * Before M21 the catalog held one active city and every picker was a `<select>`
 * over it. It now holds 1,252, and a flat list that long is not a control anybody
 * can use on a phone — scrolling past نظرآباد to reach یزد is not "choosing a
 * city". So the province becomes the first choice and narrows the second to
 * ~40 options.
 *
 * A composable rather than a component, because the three call sites disagree
 * about everything *except* this logic: Discover styles its selects for a filter
 * sheet and offers «همه», the profile and create-event forms style theirs for a
 * form and require a choice. Sharing the markup would have meant a component with
 * a prop for each of those disagreements; sharing the derivation means each
 * template stays the plain markup it already was.
 *
 * `cityId` is passed in rather than owned here, because it is the value the
 * caller submits — the province is scaffolding for picking it and is never sent
 * anywhere.
 */
export function useLocationPicker(cityId: Ref<string>) {
  const session = useSessionStore();

  const provinces = computed(() => session.catalog?.provinces ?? []);
  const allCities = computed(() => session.catalog?.cities ?? []);

  const provinceId = ref('');

  /**
   * Cities of the chosen province — and every city while none is chosen.
   *
   * "Every city" rather than "none" so the control degrades into the pre-M21
   * behaviour instead of into an empty list: a screen that has not loaded a
   * province yet, or a deployment where nobody has run `seed:geography`, still
   * shows something pickable.
   */
  const cities = computed(() => {
    if (provinceId.value === '') return allCities.value;
    return allCities.value.filter((city) => city.provinceId === provinceId.value);
  });

  const districts = computed(
    () => allCities.value.find((city) => city.id === cityId.value)?.districts ?? [],
  );

  /**
   * Follow the city when it is set from outside — a profile being edited arrives
   * with a `cityId` and no province, and the province select would otherwise sit
   * on «انتخاب کنید» next to a city that is already chosen.
   *
   * `immediate` covers the case where the value was already there before this ran.
   */
  watch(
    [cityId, allCities],
    () => {
      if (cityId.value === '') return;
      const city = allCities.value.find((candidate) => candidate.id === cityId.value);
      if (city?.provinceId != null && city.provinceId !== provinceId.value) {
        provinceId.value = city.provinceId;
      }
    },
    { immediate: true },
  );

  /**
   * Clear the city when the province moves — unless the city is already in it,
   * which is what the watcher above just did.
   *
   * Without this, picking تهران then switching to فارس leaves تهران submitted
   * under a province that does not contain it, and the form looks consistent
   * while being wrong.
   */
  function onProvinceChange(): void {
    if (cityId.value === '') return;
    const stillValid = cities.value.some((city) => city.id === cityId.value);
    if (!stillValid) cityId.value = '';
  }

  return { provinces, cities, districts, provinceId, onProvinceChange };
}
