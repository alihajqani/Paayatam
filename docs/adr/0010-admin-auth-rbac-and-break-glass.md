# ADR-0010: Admin authentication, RBAC, and break-glass chat access

- **Status:** Accepted (2026-08-15)
- **Decides:** D11 (admin authentication)
- **Invariant owned:** deny by default; every admin action is authorised in the service layer and audited

## Context

The admin panel can suspend users, adjust coin balances, override Trust Scores, approve or reject events,
and — most sensitively — read private conversations between users who were promised anonymity.

A compromised admin account is therefore worse than a compromised user account by orders of magnitude.

Two tempting shortcuts must be rejected explicitly:

1. **Telegram login for admins.** Convenient, and wrong: it makes admin access a downstream consequence of
   Telegram account security. A SIM swap or a session hijack on a staff member's personal Telegram would
   yield the moderation panel.
2. **A role column on the user table.** It merges the end-user identity system with the staff identity
   system, so any privilege-escalation bug in user-facing code becomes an admin compromise.

## Decision

### Separate identity system

`admin_user` is a **distinct table with no foreign key to `user`**. An admin is never a user row. The two
authentication systems share no code path, no token format and no session store namespace.

- **Password:** argon2id (memory-hard), per-user salt, minimum length enforced, checked against a
  common-password list.
- **TOTP 2FA: mandatory**, not optional. `totp_secret_enc` is AES-256-GCM encrypted at rest.
- **Lockout:** 5 failed attempts ⇒ progressive lockout, recorded in `audit_log`.
- **Sessions:** server-side in Redis, short idle timeout, **cookies** (`HttpOnly`, `Secure`, `SameSite=Lax`)
  with **CSRF tokens** — unlike the Mini App, which uses bearer tokens (ADR-0004). The admin panel is a
  normal browser app, so it has normal browser threats.
- **Optional IP allowlist** via configuration for teams that can use one.

### RBAC — deny by default

Four roles, least privilege:

| Role | Can | Cannot |
|---|---|---|
| `SUPER_ADMIN` | everything, including role management | — |
| `MODERATOR` | moderation queue, reports, hide/reject events, blacklist, chat unseal | adjust coins, manage roles |
| `SUPPORT` | view users, view ledgers, respond to reports | **adjust coins**, unseal chats, ban |
| `ANALYST` | read-only aggregates and dashboards | any mutation, any PII, any chat |

Enforcement rules:

1. Permissions are **fine-grained strings** (`event.moderate`, `coin.adjust`, `chat.read`, `user.ban`),
   granted to roles, not hardcoded to role names. Adding a permission does not require new code paths.
2. **Checked in the service layer**, not only in a controller guard. A controller guard protects one route;
   a service check protects every caller, including future jobs and scripts.
3. **Deny by default.** An endpoint with no declared permission is unreachable, and a test asserts that no
   endpoint lacks a declaration.
4. **Four-eyes on role changes.** A `SUPER_ADMIN` cannot unilaterally grant themselves new capabilities;
   role modification requires a second admin's approval.
5. **An RBAC matrix test** covers every role × every admin endpoint, asserting allow or deny. This is the
   only way a matrix like this stays correct as endpoints are added.

### Break-glass chat access

Reading private messages requires **all** of:

1. the `chat.read` permission, **and**
2. an **open `moderation_case`** referencing that chat, **and**
3. a **written reason** submitted with the request.

The grant is **time-boxed to 15 minutes**. **Every individual message read writes its own `audit_log` row** —
not one row for the session, one per message. A weekly digest of all unseal events goes to `SUPER_ADMIN`, so
misuse is visible to someone other than the person doing it.

### Audit log

Append-only (trigger-enforced), monthly-partitioned, 24-month retention. Every admin mutation records actor,
action, target, before/after state, hashed IP and request id. Coin adjustments additionally require a
mandatory free-text reason.

## Consequences

**Positive**
- Admin compromise no longer follows from Telegram account compromise.
- Service-layer checks mean a new controller, job or CLI cannot accidentally bypass authorisation.
- Chat access is possible when genuinely needed for abuse investigation, but never casually, never silently,
  and never unbounded.
- The RBAC matrix test converts a documentation promise into a build failure.

**Negative**
- Staff must manage a separate credential and an authenticator app. Deliberate friction, proportionate to
  what the panel can do.
- Mandatory TOTP means account recovery needs a documented, verified-out-of-band procedure — otherwise the
  recovery path becomes the weakest link. Documented in the runbook (M16).
- Per-message audit rows on unseal produce volume. Bounded by the 15-minute window and monthly partitioning.
- Four-eyes role changes need at least two `SUPER_ADMIN` accounts to exist from day one, including in
  disaster scenarios.

## Alternatives considered

- **Telegram login for admins.** Rejected — see Context.
- **A `role` column on `user`.** Rejected — merges the two identity systems.
- **Optional 2FA.** Rejected: optional controls are not controls. The panel can move currency and read
  private messages.
- **Unrestricted chat reading for moderators.** Rejected: it would make the product's central privacy promise
  false, since anonymity would hold against other users but not against staff.
- **SSO / OAuth via an external provider.** Reasonable at larger scale, rejected for MVP: an external identity
  dependency plus sanction-related availability risk for a four-person admin team.
