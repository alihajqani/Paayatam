# Front-end performance — what was measured, changed, and deliberately not

M22 phase 3. Both bundles are downloaded over Iranian mobile networks (ADR-0003),
where the round trip is the expensive part and every kilobyte on the critical path
is paid for on a connection that may not finish it.

Everything below is reproducible:

```bash
pnpm --filter @payetam/miniapp build
pnpm --filter @payetam/admin build
```

---

## 1. What "critical" means here

Not the total build output. **What `index.html` tells the browser to fetch before
a single route resolves**: the entry module, every `<link rel="modulepreload">`,
and the stylesheet. Route chunks are excluded — they are fetched when a screen is
opened, which is the whole point of splitting them. The font is reported
separately because it is not JavaScript and does not block first paint.

## 2. Before and after

| | Before | After | Change |
| --- | ---: | ---: | ---: |
| **Mini App** critical, gzip | 73.66 kB | **48.78 kB** | **−33.8%** |
| **Mini App** all JS, gzip | 118.79 kB | 112.70 kB | −5.1% |
| **Admin** critical, gzip | 76.50 kB | **68.30 kB** | **−10.7%** |
| **Admin** all JS, gzip | 138.44 kB | 133.75 kB | −3.4% |
| Font (both), woff2 | 108.55 kB | 108.55 kB | unchanged — see §5 |

Two facts the byte counts do not show, and which matter more:

- **The admin panel's contracts are no longer in the Mini App.** Before this
  change, `totpCode`, `csrfToken`, `bodyText` and the gift-code schemas were all
  present in the Mini App's entry chunk — the panel's entire validation surface,
  shipped to every user's phone.
- **zod is no longer on the Mini App's critical path.** It is still shipped, and
  deliberately: the Mini App validates with the same schemas the backend does
  (ADR-0003), and that is worth its weight. It now arrives with the first *form*
  screen rather than with the splash.

## 3. The one-line cause, and the one-line fix

`packages/shared` is a barrel: `index.ts` re-exports every contract, the admin
panel's included. Both apps import from it, and rollup could not drop what they
did not use — because a zod schema is built by calling `z.object({…})` at module
scope, and a bare call expression is something a bundler must assume has side
effects unless told otherwise.

```json
"sideEffects": false
```

in `packages/shared/package.json` is that permission. It is true of every module
in the package: they declare constants, schemas and pure functions, and not one
of them touches a global, registers a handler, or patches a prototype.

This was worth more than any hand-written `manualChunks` split, and it will keep
paying: a contract added for one app no longer lands in the other's bundle.

## 4. Request deduplication

`apps/*/src/api/client.ts` now collapses **GETs that are already in flight**.
Two components mounting in the same tick, a `watch` that fires twice, a user
double-tapping on a slow connection — one request, one round trip, every caller
gets the same promise.

Three properties, all covered by tests:

- **It is not a cache.** The entry is dropped the moment the request settles, so
  the next call goes to the network. Nothing can serve a stale answer — which
  matters in a moderation queue more than the saved request does.
- **Mutations are never collapsed.** Two identical POSTs are two intentions. What
  makes a *repeat* of one safe is `Idempotency-Key`, a different mechanism with a
  different guarantee.
- **The identity is credential-scoped.** Changing the access token (Mini App) or
  the CSRF token (panel) clears what is in flight, so an answer fetched for one
  session is never handed to the next.

The panel keys on path **and query string**; the Mini App keys on path alone. That
difference is deliberate: every list screen in the panel is
`?query=&status=&limit=&offset=`, and collapsing two of those that differ only in
`offset` would serve page one to somebody who asked for page two.

## 5. The font, and why it is unchanged

At 108.55 kB the Vazirmatn variable woff2 is the single heaviest asset — larger
than all critical JavaScript in either app. It was left alone, and that is a
decision rather than an omission:

- **It is not on the critical path.** The `@font-face` sets `font-display: swap`,
  so text paints immediately in the system fallback and swaps when the font
  lands. Nothing waits for it.
- **Subsetting a Persian font is not safe here.** The obvious win is to keep only
  the glyphs the source uses — but this app renders *user* text: display names,
  event titles, city names, chat messages. A subset built from the repository
  would be correct until the first user typed something outside it.
- **The toolchain is not in the image.** Subsetting needs `fonttools`; the build
  stage is `node:22-alpine` with no Python. Adding it would put a second language
  runtime into the build for one asset.
- **It is paid once.** nginx serves `/assets/` with
  `Cache-Control: public, max-age=31536000, immutable`, so a returning user
  fetches nothing.

A safe subset — the Persian and Arabic blocks, Latin, digits and punctuation, with
the rest dropped — is a real future win. It belongs with the tooling to verify it,
not bolted onto a release.

## 6. What was checked and found already correct

Measuring first meant not rewriting things that were not broken:

- **Admin pagination and debounced search already exist** where they are needed —
  Users, Events, Audit, Ledger, Gift codes, Referrals and Places all pass
  `query`/`limit`/`offset` to the API and debounce the text input. Filtering is
  server-side, not a filter over a full fetch.
- **Reports and Cases deliberately have no debounce.** Their filters are `select`
  and date inputs. A discrete choice should act immediately; debouncing one only
  makes the screen feel broken.
- **The city picker filters client-side, on purpose.** The catalog is one cached
  fetch (~15 kB gzipped) and `foldedIncludes` runs over it locally, so typing
  costs no round trips at all — the plan's trade, and the right one on these
  networks.
- **The catalog is cached at both ends**: `Cache-Control: public, max-age=300` on
  the response, and held in the session store for the life of the Mini App.
- **No N+1 query was found.** No `Promise.all` over a `map` issuing per-row
  queries; the per-row `await`s that exist are bounded transactional updates.

## 7. Index coverage

Verified against the development database — every index the schema declares for
the M22 tables exists, and the planner uses it:

| Query | Plan |
| --- | --- |
| pending recipients for a campaign | `Index Scan using message_recipient_pending_idx` |
| has this user been invited to this event? | `Index Only Scan using event_invitation_event_id_user_id_key` |
| current policy for a type | `Index Scan using policy_version_authoring_idx` |
| city search | `Index Scan` (see caveat) |

**Caveat, stated plainly:** the development database holds 3 cities, 30 users and
42 events. At that size the planner's choice says little, and the GIN trigram
index on `city.name_normalized` — the one that matters for search across 1,252
cities — cannot be exercised meaningfully. What is verified is that the index
*exists* and that no query falls back to a sequential scan when scans are
disabled. Confirming the trigram plan needs production-scale data.
