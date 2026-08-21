# Runbook — backup and restore

The plan's M16 asks for "nightly `pg_dump` + WAL archiving with **an actually-rehearsed
restore recorded with a real duration**". This is that record, plus the procedure to
repeat it. The emphasis in the plan is the important part: a backup that has never been
restored from is a cron job, not a backup regime.

---

## What exists

| Mechanism | Cadence | Restores to | Recovers from |
| --- | --- | --- | --- |
| `tools/backup.sh` — `pg_dump -Fc` | nightly, 02:00 Tehran | last night | a dropped table, a bad migration, a corrupted data directory, a different Postgres version |
| WAL archiving — `archive_command` | continuous | any second | everything above **except** a corrupt base backup |

**Both, not either.** A dump alone means the product's worst day loses up to
twenty-four hours of events, joins and messages. WAL alone means a corrupt base
backup takes the whole archive with it, because every WAL segment is a delta against
a base that no longer restores.

Neither is a replica. A hot standby protects against the *machine* dying and against
nothing else — it replicates a dropped table faithfully and instantly. Replication is
an availability tool; these are recovery tools.

---

## The rehearsal, as actually performed

Run on the development machine against the local Postgres 16.15, 2026-08-17.

```
$ docker exec payetam-postgres bash /tmp/backup.sh
Dumping to /tmp/payetam-backups/payetam-20260817T071302Z.dump
Wrote /tmp/payetam-backups/payetam-20260817T071302Z.dump (147729 bytes), verified readable
PAYETAM_BACKUP_REMOTE is not set — backup exists only on this host

$ docker exec payetam-postgres bash /tmp/restore-rehearsal.sh /tmp/payetam-backups/payetam-20260817T071302Z.dump
Rehearsing restore of ... into payetam_restore_rehearsal
Restored in 2s: 42 tables, 6 triggers, 4 extensions
Dropped payetam_restore_rehearsal
REHEARSAL_SECONDS=2
```

> The transcript above is a **recorded run from 2026-08-17** and is left exactly as it
> happened. Its `42 tables` predates M18, which added `gift_code` and
> `gift_code_redemption`; the schema is now 45 tables and the same 6 triggers. That is
> the point of the check below being written against **the live database** rather than
> against a number in this file — a count that has to be edited every migration is a
> count that will eventually be wrong and trusted anyway.

**The measured number is 2 seconds, and it is honest about almost nothing.** The
development database holds a seeded catalog and a handful of rows; the dump is 144 kB.
What the rehearsal *does* establish — and what it was written to establish — is that
every step works at all:

- `pg_dump -Fc` produces an archive `pg_restore --list` can parse.
- `pg_restore --exit-on-error` completes with **no errors**, which is the check that
  catches the failures that actually happen: an extension the dump did not create
  before the schema that needs it, a `GRANT` to a role that does not exist on the
  target, an owner mismatch.
- **Every table, trigger and extension arrives — the same counts the live database
  reports.** The trigger count is the one worth naming and worth checking against the
  source rather than against a number in a document: the append-only guards on
  `coin_ledger`, `trust_score_ledger`, `consent`, `audit_log` and `chat_action` are
  created by migration rather than by the Prisma schema, plus `event_search_vector_sync`
  for Persian search. A restore that silently dropped them would leave a database that
  works perfectly and has lost the product's hardest guarantee (ADR-0007). The
  rehearsal script fails outright if `coin_ledger` comes back without its trigger.
- `citext` restores in the right order — `admin_user.email` is `citext`, and a dump
  that recreated the column before the extension is a restore that fails at 3 a.m.

**What it does not establish is duration at production scale, and no arithmetic here
would fix that.** A restore's time is dominated by index builds, which scale with row
count in a way a 144 kB dump cannot predict. The number to record is the one measured
against production-sized data, and the honest state of that row today is: *unmeasured*.

**Therefore, before launch:** run the rehearsal against a dump of the seeded
production database once §12's launch checklist has loaded M17's founding-team events,
and replace the paragraph above with that duration. Repeat quarterly and after any
migration that adds an index — those are the two things that move this number.

### Repeating it

The scripts take a host with the Postgres client tools installed. On this machine they
are only inside the container, which is why the rehearsal above copies them in:

```bash
docker cp tools/backup.sh payetam-postgres:/tmp/backup.sh
docker cp tools/restore-rehearsal.sh payetam-postgres:/tmp/restore-rehearsal.sh
docker exec -e DATABASE_URL='postgresql://payetam:...@localhost:5432/payetam' \
            -e PAYETAM_BACKUP_DIR=/tmp/payetam-backups \
            payetam-postgres bash /tmp/backup.sh
docker exec -e DATABASE_URL='postgresql://payetam:...@localhost:5432/payetam' \
            payetam-postgres bash /tmp/restore-rehearsal.sh /tmp/payetam-backups/<dump>
```

On a production host, drop the `docker exec` and run them directly.

---

## Configuring WAL archiving

Not scripted, because it is Postgres configuration rather than a program, and a script
that edited `postgresql.conf` in place is a script that eventually corrupts it.

```conf
# postgresql.conf
wal_level = replica
archive_mode = on
# `test !` first: without it, a restart after an incident silently overwrites the
# archived segment with a partial one, and the corruption is undetectable until a
# restore needs that exact segment.
archive_command = 'test ! -f /var/lib/postgresql/wal-archive/%f && cp %p /var/lib/postgresql/wal-archive/%f'
archive_timeout = 300     # a segment at least every 5 minutes, so a quiet hour
                          # still bounds how much can be lost
```

`archive_timeout = 300` is the number that defines the actual recovery point. Without
it, a 16 MB segment is archived only when it fills — so a quiet Tuesday could leave
hours unarchived, and the "restores to any second" claim above would be false exactly
when traffic was low enough for nobody to notice.

**The archive must not live on the database's disk.** A `cp` to the same volume
protects against nothing this is for. `rsync` it off-host on the same schedule as the
dump.

### Point-in-time recovery

```bash
# 1. Stop the API and the worker first. A partially-recovered database serving
#    traffic is worse than a database that is down: the outbox would relay events
#    that had already been delivered, and every idempotency key would be wrong.
systemctl stop payetam-api payetam-worker

# 2. Restore the most recent base backup into a fresh data directory, then:
cat > "$PGDATA/recovery.signal" <<'EOF'
EOF
cat >> "$PGDATA/postgresql.conf" <<'EOF'
restore_command = 'cp /var/lib/postgresql/wal-archive/%f %p'
recovery_target_time = '2026-08-17 09:14:00+03:30'
recovery_target_action = 'promote'
EOF

# 3. Start Postgres. It replays WAL to the target and promotes.
# 4. Verify BEFORE letting the application near it — the checks in
#    tools/restore-rehearsal.sh, plus the ledger reconciliation:
#      SELECT u.id FROM "user" u
#      JOIN (SELECT user_id, SUM(amount) s FROM coin_ledger GROUP BY user_id) l
#        ON l.user_id = u.id
#      WHERE u.coin_balance <> l.s;
#    Zero rows, or the cached balances and the ledger disagree and the recovery
#    point is inside a transaction that should not have been split (ADR-0007).
```

`recovery_target_time` uses **Tehran** offset here because that is how the incident
will be described ("it started around a quarter past nine"). Postgres stores UTC
either way; writing the offset explicitly is what stops a three-and-a-half-hour
mistake.

---

## What is deliberately not here

- **Automated off-host verification.** `backup.sh` verifies the dump is *readable*
  and refuses to rotate older backups if it is not, but nothing restores it nightly.
  That needs a second machine, and until it exists the quarterly rehearsal is the
  control. Recorded as a gap rather than implied to be covered.
- **Encryption at rest for the dumps.** The dump contains `chat_message` ciphertext,
  which is useless without `CHAT_ENCRYPTION_KEY` — but it also contains display names,
  bios and `telegram_account` rows in the clear. `rsync --chmod=F600` is the current
  protection, which is filesystem permissions and nothing more. The backup destination
  should be an encrypted volume; that is a deployment decision, and this line exists so
  it is a decision rather than an oversight.
- **A tested `pg_upgrade` path.** The dump is version-portable, which is the escape
  hatch; a major-version upgrade rehearsal is not part of MVP.
