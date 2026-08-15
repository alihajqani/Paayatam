# ADR-0003: Vue 3 frontends and the Telegram Native Design System

- **Status:** Accepted (2026-08-15)
- **Decides:** D2 (frontend framework), D3 (Mini App design language)
- **Note:** This ADR replaces the React proposal in the original plan, at the user's explicit direction.

## Context

Two frontends are needed: the **Mini App** (runs inside Telegram's WebView, used by every end user) and the
**Admin Panel** (desktop, used by a handful of staff).

The Mini App is not an ordinary web app. It is embedded in Telegram, and users judge it against the Telegram
client it is displayed inside. Anything that looks like a website in a WebView reads as broken. The user's
requirement is explicit: it must feel **completely native, modern, responsive, RTL-first and
human-friendly**.

## Decision

**Vue 3 (Composition API, `<script setup>`) + Vite + Pinia + Vue Router + TailwindCSS for both frontends.
The Mini App strictly follows the Telegram Native Design System.**

### Shared stack

- Vue 3 Composition API with `<script setup>` and full TypeScript.
- Pinia for client state; TanStack Query (Vue) for server state, caching and retries.
- `vee-validate` driven by the **same zod schemas** the backend validates with, imported from
  `packages/shared`. One schema, two enforcement points — the client cannot drift from the server.
- Vite for both apps, sharing a base config.

### Mini App — Telegram Native Design System (non-negotiable rules)

1. **All colour comes from Telegram.** `WebApp.themeParams` is mapped once into CSS custom properties
   (`--tg-theme-bg-color`, `--tg-theme-text-color`, `--tg-theme-hint-color`, `--tg-theme-link-color`,
   `--tg-theme-button-color`, `--tg-theme-button-text-color`, `--tg-theme-secondary-bg-color`,
   `--tg-theme-header-bg-color`, `--tg-theme-accent-text-color`, `--tg-theme-destructive-text-color`).
   Tailwind consumes them through `theme.extend.colors`. **No hardcoded hex in any component** —
   lint-enforced. The app therefore matches the user's Telegram theme instantly, light or dark, including
   custom themes we have never seen.
2. **Native chrome, not custom chrome.** `MainButton` for the primary action of every screen and form;
   `BackButton` for navigation instead of an in-page back arrow; `HapticFeedback` on meaningful state
   changes; `showConfirm` / `showPopup` for destructive confirmations; `expand()` and
   `disableVerticalSwipes()` on mount; layout driven by `viewportStableHeight`.
3. **RTL-first.** `dir="rtl"` at the root. **Logical CSS properties only** — `margin-inline-start`, never
   `margin-left`. Vazirmatn as the font, self-hosted. Persian digits are produced by a formatter at the view
   layer while every internal value stays Latin, so sorting and arithmetic are never affected by presentation.
4. **Human-friendly by default.** Every list has explicit loading, empty, error and retry states. Every
   destructive action confirms through the native popup. Every form disables its submit control while in
   flight — with server-side `Idempotency-Key` as the real guarantee, since a disabled button is a courtesy,
   not a control.
5. **Physical details.** Safe-area insets respected; 44 px minimum touch targets; `prefers-reduced-motion`
   honoured; skeletons rather than spinners for content that has a known shape.

### Admin Panel

The same Vue stack, but a conventional desktop-first, LTR-capable layout built around data tables, filters
and bulk actions. It deliberately does **not** use Telegram theming — it is not a Telegram surface, and
inheriting an end user's theme there would be actively confusing.

## Consequences

**Positive**
- One frontend framework for two apps; shared components, tooling, lint rules and CI.
- Theme-token discipline means the Mini App needs no dark-mode work: Telegram supplies the palette.
- zod schemas shared with the backend eliminate an entire class of validation drift.
- Vue's SFC structure and Pinia keep the Mini App small and readable, which matters because the WebView
  bundle is downloaded over Iranian mobile networks.

**Negative**
- Diverges from `shifaa-landing`, the workspace's only existing frontend, which is React/Next.js. Accepted:
  it is a marketing site with no shared code.
- The TanStack Query and vee-validate Vue adaptors are less widely used than their React counterparts, so
  fewer examples exist. Low risk for the surface area we use.
- Telegram's WebApp SDK is typed loosely. It gets a thin typed wrapper in `apps/miniapp/src/telegram/` so
  SDK quirks are isolated in one file rather than scattered through components.
- Binding to `themeParams` means we cannot guarantee contrast: a user's custom theme could be unreadable.
  Mitigation: a computed contrast check falls back to a safe pair when the theme's own contrast ratio is
  below 4.5:1.

## Alternatives considered

- **React + Vite** (the original proposal). Rejected at the user's direction. No technical objection —
  the architecture is framework-agnostic behind `packages/shared`.
- **Nuxt.** Rejected: SSR gains nothing inside a Telegram WebView that authenticates via `initData` after
  load, and it adds a server process to operate.
- **Custom design system with our own palette.** Rejected. It would look like a website inside Telegram and
  would break for every user with a non-default theme.
- **A single app serving both Mini App and Admin.** Rejected: shipping admin code in an end-user bundle is
  an unnecessary disclosure of the admin surface.
