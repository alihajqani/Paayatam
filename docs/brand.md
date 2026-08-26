# Brand — the mark, the palette, and where the copies live

M22 phase 10. This is the design record for a product that had no logo in it: what
`logo.png` was turned into, what colours were taken out of it, and what has to be
redone if the logo ever changes.

This is the only record. There is deliberately no README beside the assets: the
`public/` directories are copied verbatim into the deployed bundles, so a note
left there is a note served to the internet at `/brand/README.md`.

---

## 1. The master

`logo.png` at the repository root. 1024×1024 RGBA: the mark drawn on a white disc,
on an off-white plate, with a drop shadow and a decorative sparkle.

It is **committed and deliberately not shipped.** At 1.3 MB it is roughly sixty
times the weight of everything derived from it, and the Mini App is downloaded
over Iranian mobile networks (ADR-0003). Nothing in `apps/` references it.

---

## 2. The palette

Six colours, **sampled rather than chosen.** The disc and the plate were removed
first — the same alpha ramp the asset transform uses — and k-means was run over
the remaining ribbon pixels with k=6. What follows is the cluster centres in
descending share of the mark:

| Token | Hex | Share | The ribbon |
| --- | --- | --- | --- |
| `--color-brand-amber` | `#f3b47f` | 25.9% | the pale warm sweep |
| `--color-brand-blue` | `#1d6bb9` | 22.7% | the deep blue |
| `--color-brand-rose` | `#cf5185` | 19.8% | the deep pink |
| `--color-brand-cyan` | `#57cce5` | 11.4% | the light blue |
| `--color-brand-pink` | `#ea81bf` | 10.9% | the light pink |
| `--color-brand-violet` | `#7f5fb3` | 9.5% | the purple |

k=6 because the mark has six ribbons. A larger k splits the amber into its own
gradient stops, which is a finding about a gradient rather than about a palette.

### The rule that keeps this from breaking anything

The Mini App's founding colour rule is that **no component may write a hex
value** — every colour is a `--tg-theme-*` token reported by the user's Telegram
client, which is what makes the app follow a custom theme with no dark-mode code
of its own (ADR-0003, `apps/miniapp/src/styles/main.css`).

These six are the only fixed colours in it, and the rule survives as written: they
are *tokens*, not literals in a component. What changes is that they are fixed
rather than reported, for a reason theming cannot cover — a brand is the one thing
on the screen that has to look the same to everybody. A logo that recoloured
itself per theme would not be a logo.

The constraint that makes that safe, and it is not negotiable:

> **No text is ever drawn in these colours, and no text is ever drawn on them.**

They appear in exactly two places, both decorative: the gradient hairline under
the app header, and the blurred halo behind the splash mark. Neither carries
information, so neither can fail a contrast check against a theme nobody has seen.
Any future use has to meet the same test.

### The admin panel's blue

`apps/admin` is not a Telegram surface and has its own palette (plan §3.7), so it
has no such constraint — but it does have the same rule in a different form: no
component may write a hex value; every colour is a token in
`apps/admin/src/styles/main.css`.

Its `--color-brand` is now the mark's blue rather than a blue that happened to be
near it:

| | Before | After | Contrast on the surface |
| --- | --- | --- | --- |
| Light | `#1f6feb` | `#1d6bb9` | 4.63:1 → **5.45:1** |
| Dark | `#4c8dff` | `#65a6e7` | 5.66:1 → **7.04:1** |

The dark value is the same hue (210°) and the same saturation as the light one,
lightened until it carries on a dark surface — derived, so a change to the logo
blue moves both. Every pairing clears WCAG AA and the ratios are recorded in
comments beside the tokens, so a future tweak has something to check itself
against rather than an eye.

The five non-blue ribbons are carried into the panel too, for the one place it
draws the hairline. Same decorative-only rule.

### 2.5 How the mark was made

The source is the mark on a **white disc, on an off-white plate, with a drop
shadow**. The disc and the plate are removed, leaving the ribbons on
transparency. Two reasons, and the second is the one that matters:

1. A white disc on a light Telegram theme is an invisible circle with a shadow.
2. The Mini App follows the user's Telegram theme, including custom ones nobody
   has seen. An asset that carries its own background can only ever be right
   against one of them.

The transform, in order:

1. **Alpha from signal.** For each pixel, `signal = max(saturation, 1 − max
   channel)`, smoothstepped from 0.10 to 0.22. Saturation alone would erase the
   pale amber ribbon; distance-from-white alone would erase nothing, because the
   plate is nearly white too. The maximum of the two keeps every ribbon and drops
   both backgrounds.
2. **A connected-component stencil.** The disc has a faint grey rim and a drop
   shadow, both of which clear that ramp. Flood-filling from a point inside the
   mark and dilating four pixels keeps the ribbons and their antialiasing, and
   nothing else. This is also what drops the decorative sparkle in the corner.
3. **Un-premultiplication against white.** The source pixels are the ribbons
   already composited over the white disc, so `C = (P − 255·(1−α)) / α`. Skipping
   this step leaves a white halo on every edge — invisible on a light theme and
   very visible on a dark one.
4. **Square crop** around the alpha bounding box with 6% air, then LANCZOS
   downsampling and WebP at quality 80.

Any image tool that can do "threshold to alpha, keep the largest component,
un-premultiply, resize" reproduces it.

---

## 3. Every place a copy lives

The panel and the Mini App are **separate nginx vhosts with separate roots**
(`/srv/www/admin` and `/srv/www/miniapp`, see `docker/sites-available/`), so a
path like `/brand/mark-96.webp` is resolved by whichever host served the page and
each root has to carry its own. Vite's `publicDir` is one directory per app and
cannot be pointed at two, so these are copies rather than a shared import.

| Path | What | Rendered at |
| --- | --- | --- |
| `logo.png` | the master, not shipped | — |
| `apps/miniapp/public/brand/mark-256.webp` | splash mark | 88 px |
| `apps/miniapp/public/brand/mark-96.webp` | header mark | 32 px |
| `apps/miniapp/public/favicon.png` | browser tab | 32 px |
| `apps/admin/public/brand/mark-96.webp` | sidebar mark (copy) | 24 px |
| `apps/admin/public/favicon.png` | browser tab (copy) | 32 px |

---

## 4. Regenerating after a logo change

This is a **design step, not a build step.** The assets are committed and no
toolchain in this repository produces them; there is nothing to run in CI. The
checklist:

1. Replace `logo.png`.
2. Redo the transform in §2.5 below.
3. Write the two WebPs and the favicon to the paths in §3, **including the two
   admin copies.**
4. Re-sample the palette: remove the disc and the plate, k-means with k=6 over the
   ribbon pixels, sort by share. Update the table in §2 and the tokens in both
   `styles/main.css`.
5. Re-check the admin contrast ratios and update the numbers in the comments
   beside those tokens. The light surface is `#ffffff`, the dark one `#14161a`.

---

## 5. Why WebP

The mark is smooth gradients. A 255-colour octree palette bands them visibly, and
full-colour PNG is 70 KB at 256 px against 14 KB for a WebP nobody can tell apart.
Every client that can run a Telegram Mini App has supported WebP for years.

The favicon stays PNG because that is what browsers accept as an icon.
