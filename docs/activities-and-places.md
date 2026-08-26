# Activities and places

Where the product's two biggest lists live, and how to change them.

- **تفریحات** — the activity tags a host files an event under. Table: `category`.
- **علاقه‌مندی‌ها** — what a user says they like. Table: `interest`.
- **Places** — 31 provinces and 1,252 cities. Tables: `province`, `city`, `district`.

There are two ways to change any of this: **the admin panel** (no deploy) and **a seed
file** (a code change). Which one to use is not a style preference — see
[§4](#4-which-way-to-change-something).

---

## 1. The shape of it

```
province ──< city ──< district
                │
                └──< city_category >── category ──< interest
                                          │
                                          └──< event
```

`city.province_id` is **nullable and stays that way**. A city an admin creates before
anybody has decided which province it is filed under is a real state, not a broken one —
and a nullable column is what let migration 0020 land on a live database with no backfill
window. Clients group unfiled cities under «بدون استان» rather than dropping them.

`city_category` is a **restriction, not an allowlist**. A category with no rows there is
offered in every city, which is what all of them are by default. The inverse convention
would have meant backfilling 1,252 × N rows on deploy just to preserve existing behaviour,
and would have made "I added a city and every activity vanished" the default experience.

### The «سایر» flag

`category.allows_custom_label` is a boolean on the row, not a `slug === 'other'` check in
code. When it is set:

- the host is asked to name their activity, and it lands in `event.custom_category_label`;
- the label is **required** — a «سایر» event with no label tells a reader nothing;
- the label is blacklist-scanned exactly like the title (`ModerationService.scanEventContent`);
- the label is **not** in `search_vector`, deliberately — migration 0020 explains why
  widening the 0005 trigger was the wrong trade;
- the Mini App shows the label in place of the category name on cards and detail screens.

Because it is a flag rather than a slug comparison, renaming «سایر» or adding a second
catch-all needs no release.

---

## 2. Changing tags from the admin panel

**پنل مدیریت → سیستم → تفریحات** (`/activities`). Needs the `catalog.manage` permission,
held by `SUPER_ADMIN`. To give it to `MODERATOR`, add `PERMISSIONS.CATALOG_MANAGE` to that
role in `packages/domain/src/adminaccess/permissions.ts` and re-run `pnpm seed:rbac` — the
seed revokes as well as grants, so the table always matches the code.

| What | How | Notes |
|---|---|---|
| Add a tag | «تفریح تازه» | Slug is required and permanent. Defaults to active. |
| Rename / re-icon | «ویرایش» | The Persian name is free text; change it whenever. |
| Enable / disable | Click the status pill | Instant. The only way to retire a tag in use. |
| Reorder | ↑ / ↓ | Sends the whole order in one transaction. |
| «سایر» behaviour | «عنوان دلخواه» checkbox | Lets hosts type their own activity name. |
| Restrict to cities | «فقط شهرهای انتخاب‌شده» | Filter by province or search; empty = nowhere. |
| Delete | «حذف» | **Disabled when events reference the tag.** Deactivate instead. |

Every change writes an `audit_log` row (`catalog.tag.created` / `.updated` / `.deleted` /
`.reordered`) with the before and after. City restrictions are recorded as a *count*, not
400 uuids.

### Why the slug cannot be renamed

There is no slug field on the update endpoint at all — not one that validates and refuses.
An endpoint that can be *asked* to rename an identifier is one somebody eventually wires a
text input to. Slugs are what seed files, integration tests and this document refer to;
renaming one silently repoints all three at nothing. Deactivate the row and create a new
one.

### Why a tag in use cannot be deleted

`event.category_id` is `RESTRICT`. Everything ever filed under the tag would have to be
re-filed or destroyed, and neither is something a delete button should do quietly. The API
refuses with `CATALOG_TAG_IN_USE` and the count; the panel disables the button and says so
in the tooltip. `is_active` exists precisely so a retired tag keeps its history intact.

---

## 3. Changing things in code

### Activity tags and interests

**File: [`tools/seed-catalog.ts`](../tools/seed-catalog.ts)** — the `CATEGORIES` and
`INTERESTS` arrays.

```ts
{
  slug: 'cafe-hopping',      // permanent identifier — see the rules below
  nameFa: 'کافه‌گردی',        // the label; freely editable afterwards
  icon: '☕',                 // emoji or icon key. NEVER a URL (CSP, ADR-0003)
  isActive: true,
  sortOrder: 50,             // multiples of ten, so a row can be slotted between two
  allowsCustomLabel: false,  // true makes it a «سایر»-style catch-all
}
```

Then:

```bash
pnpm seed:catalog
```

Idempotent by slug — re-running updates names and ordering in place rather than creating a
second row. Ids stay stable across runs, which matters because events reference them.

An interest is the same shape with a `category` slug (or `null` for uncategorised):

```ts
{ slug: 'museum-visit', nameFa: 'بازدید از موزه', category: 'museum', sortOrder: 16 }
```

### Provinces and cities

**File: [`tools/data/iran-geography.json`](../tools/data/iran-geography.json)** — generated,
committed, and **not hand-edited**.

To correct or refresh it:

```bash
node tools/data/build-iran-geography.mjs   # rewrites the JSON from the pinned source
pnpm seed:geography                        # writes it to the database
```

The generator is [`tools/data/build-iran-geography.mjs`](../tools/data/build-iran-geography.mjs)
and its header documents the source (`@code-plate/iran-cities`, MIT), the slug collision
rule, and the three slugs it asserts must not change. Hand-editing the JSON works right
up until somebody regenerates it, which is why the corrections live in the generator as
`SLUG_OVERRIDES` and `CAPITAL_OF`.

> **On a server, set `PAYETAM_VERSION` and run from a terminal.** The `tools`
> service is tagged `payetam/tools:${PAYETAM_VERSION:-local}`, so a bare
> `compose.sh` call reaches whatever was last built on the host by hand rather
> than the release you just deployed. And every seed stops to make you type the
> database name — it refuses when stdin is not a terminal, so this cannot be
> scripted, deliberately. `DEPLOYMENT.md` §8 has the exact form.

`pnpm seed:geography` takes an activation mode:

| Command | Effect |
|---|---|
| `pnpm seed:geography` | Every city selectable (default) |
| `pnpm seed:geography --activate=capitals` | Only the 31 provincial capitals |
| `pnpm seed:geography --activate=none` | Rows exist; nothing becomes selectable |

**It can only ever widen availability.** A city that is active stays active whatever the
mode says — a seed that could switch a served city off is a seed that can take a city's
users offline by being run at the wrong moment. Deactivation is an admin act, one city at
a time.

### Districts

**File: [`tools/seed-catalog.ts`](../tools/seed-catalog.ts)** — the `DISTRICTS` map, keyed
by city slug. Only Tehran has any. They stayed in the hand-written seed rather than moving
to the generated dataset because that is exactly what they are: hand-authored, and the
thing somebody will want to edit next.

---

## 4. Which way to change something

| | Panel | Seed file |
|---|---|---|
| A tag for one city, added today | ✅ | ❌ deploy for a row |
| A tag every environment should have | ⚠️ prod only | ✅ dev, CI and prod agree |
| Turning something off in an incident | ✅ instant | ❌ |
| Fixing a wrong city name | ❌ not exposed | ✅ regenerate |

The rule underneath: **the seed is the floor, the panel is the delta.** A seed defines
what every database gets, including a fresh CI one; the panel is how production diverges
from that on purpose. Which is why `seed:catalog` deliberately does *not* deactivate rows
it does not know about — somebody who added a tag through the panel must not lose it
because a developer ran a seed.

---

## 5. Rules and conventions

### Slugs

- `^[a-z0-9]+(?:-[a-z0-9]+)*$` — lowercase ASCII, digits, single hyphens. 2–48 characters.
  The regex lives once, in `activityTagSlug` (`packages/shared/src/contracts/admin.ts`), and
  the panel checks the same rule while you type so you learn it before the 422.
- **ASCII, not Persian.** The Persian name is the label; the slug is what code refers to.
  A Persian slug in a URL is percent-encoded into unreadability.
- **Unique** per table, and **permanent**. City slugs are globally unique, which is why the
  generator falls back to `<province>-<city>` for the 26 names that collide nationally
  (four سردشت, two شهریار).
- Prefer a description over a category number: `cafe-hopping`, not `activity-5`.

### Persian names

- UTF-8, Persian orthography: **ی and ک**, never the Arabic ي and ك. The geography dataset
  was chosen partly because it already gets this right; the Statistical Centre extracts do
  not, and normalising a *display* name is how «آذربایجان» becomes «اذربایجان».
- Use ZWNJ (نیم‌فاصله, U+200C) where Persian wants it: «کافه‌گردی», «طبیعت‌گردی».
- Names are **not** unique and **not** identifiers. Two tags may legitimately read the same
  to a user while meaning different things to the catalog.
- [`docs/glossary-fa.md`](glossary-fa.md) has the typography rules and the agreed
  translations.

### Icons

An emoji or an icon key — **never a URL**. The Mini App's CSP forbids external hosts
(ADR-0003), so a URL here renders as nothing at all.

### Ordering

`sort_order` ascending, then `name_fa`. Seeds number in tens so a row can be slotted between
two without renumbering; the panel's reorder rewrites the whole list to multiples of ten for
the same reason. A catch-all like «سایر» belongs last (999) — a catch-all offered first is a
catch-all everybody picks, and the categories below it stop collecting anything.

### Active vs deleted

Deactivate. `is_active` exists so a row that stops being offered does not orphan the
profiles and events referencing it. Delete only a row nothing has ever used, and the API
will tell you which is which.

---

## 6. The API surface

Public, `GET /api/v1/catalog` — provinces, cities with districts, categories, interests,
promotion pricing. Active rows only. `Cache-Control: public, max-age=300`, and the one
proxied response nginx is allowed to gzip (~190 KiB → ~15 KiB); `docker/nginx.conf` and the
handler both explain why that exception is safe here and would not be elsewhere.

Admin, all under `catalog.manage`:

| Method | Path | Does |
|---|---|---|
| `GET` | `/admin/v1/activity-tags` | Every tag, active or not, with `eventCount` |
| `POST` | `/admin/v1/activity-tags` | Create one |
| `PATCH` | `/admin/v1/activity-tags/:id` | Change anything except the slug; omitted fields are left alone |
| `DELETE` | `/admin/v1/activity-tags/:id` | Refused with `CATALOG_TAG_IN_USE` when events reference it |
| `POST` | `/admin/v1/activity-tags/reorder` | The whole order, one transaction |
| `GET` | `/admin/v1/places` | Provinces and cities for the scope picker |

Errors a client should expect: `CATALOG_SLUG_TAKEN` (409), `CATALOG_TAG_IN_USE` (409),
`CUSTOM_LABEL_REQUIRED` (400), `CUSTOM_LABEL_NOT_ALLOWED` (400), `CITY_NOT_AVAILABLE` (400).

---

## 7. Where each piece lives

| Concern | File |
|---|---|
| Schema | `packages/db/prisma/schema.prisma` — `Province`, `City`, `Category`, `CityCategory` |
| Migration | `packages/db/prisma/migrations/00000000000020_provinces_and_activity_tags/` |
| Geography data | `tools/data/iran-geography.json` (+ its generator) |
| Geography seed | `tools/seed-geography.ts` |
| Tag & interest seed | `tools/seed-catalog.ts` |
| Public read model | `packages/domain/src/catalog/catalog.service.ts` |
| Admin write model | `packages/domain/src/adminaccess/catalog-admin.service.ts` |
| Wire contracts | `packages/shared/src/contracts/catalog.ts`, `…/admin.ts` |
| Admin screen | `apps/admin/src/views/ActivitiesView.vue` |
| Mini App cascade | `apps/miniapp/src/composables/useLocationPicker.ts` |
