import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PrismaService } from '@payetam/db';
import type { Env } from '@payetam/config';
import { ENV } from '@payetam/platform';
import type {
  DiscoveredEvent,
  DiscoveryFilters,
  RankExplanation,
  RankingWeights,
  SearchProvider,
  SearchRequest,
  TimeOfDay,
} from './search-provider';

/**
 * Discovery over Postgres FTS + pg_trgm (ADR-0012).
 *
 * Raw SQL, and unavoidably so: the ranking score is a computed expression that
 * both the ORDER BY and the keyset predicate refer to, which Prisma's query
 * builder cannot express. Every fragment below is a tagged `Prisma.sql`
 * template, so every value is a bound parameter — there is no string
 * concatenation anywhere in this file, which is what keeps T5.2 true while
 * writing SQL by hand.
 *
 * **The score is defined once**, in `scoreSql`, and used by both `search` and
 * `explain`. A second copy for the explain endpoint would be a formula that
 * drifts from the one that actually ranks, which makes "explain" a lie.
 *
 * A note on casts: `EXTRACT(EPOCH …)` returns `numeric` in modern Postgres, and
 * node-postgres hands `numeric` back as a *string* to avoid precision loss. Every
 * component is therefore cast to `double precision` explicitly — without that,
 * scores arrive as strings and sort lexicographically, which looks like a
 * ranking bug and is really a driver detail.
 */
@Injectable()
export class PostgresSearchProvider implements SearchProvider {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async search(request: SearchRequest): Promise<DiscoveredEvent[]> {
    const rows = await this.prisma.$queryRaw<SearchRow[]>(
      Prisma.sql`
        WITH scored AS (
          SELECT ${SELECT_COLUMNS},
                 ${this.scoreSql(request)} AS score
          FROM "event" e
          ${JOINS}
          WHERE ${this.whereSql(request)}
        )
        SELECT * FROM scored
        WHERE ${this.keysetSql(request)}
        ORDER BY ${this.orderSql(request)}
        LIMIT ${request.limit}
        OFFSET ${request.offset ?? 0}
      `,
    );

    return rows.map((row) => toDiscoveredEvent(row, request));
  }

  /**
   * One published event by its public id.
   *
   * Applies the same visibility predicate as `search` minus the upcoming filter:
   * a link to an event that started an hour ago should still open. What it must
   * not do is reveal a `PENDING_MODERATION` or `HIDDEN` event to someone holding
   * the id — that is the host's own view (`GET /me/events`), not this one.
   */
  async findPublished(publicId: string): Promise<DiscoveredEvent | null> {
    const rows = await this.prisma.$queryRaw<SearchRow[]>(
      Prisma.sql`
        SELECT ${SELECT_COLUMNS}, 0::double precision AS score
        FROM "event" e
        ${JOINS}
        WHERE e."public_id" = ${publicId}
          AND e."status" = 'PUBLISHED'
          AND e."deleted_at" IS NULL
        LIMIT 1
      `,
    );

    const row = rows[0];
    return row ? toDiscoveredEvent(row, { sort: 'SOONEST' }) : null;
  }

  /**
   * One published activity by the short code a `/event_…` command carries.
   *
   * ── Why the predicate is a prefix and not a join ────────────────────────────
   *
   * A Telegram command is at most 32 characters and a UUID is 36, so the link in
   * a list cannot carry a public id. `@payetam/telegram`'s `publicIdPrefixOf`
   * turns the ten hex digits it *can* carry back into the first eleven
   * characters of the stored id, and this asks for equality on exactly that —
   * `substr(...) = $1` rather than `LIKE $1 || '%'`, because an expression index
   * can serve the first under any collation and the second only under `C`.
   * Migration 0040 creates that index.
   *
   * The visibility predicate is `findPublished`'s, word for word, and for the
   * same reason: a code is a shorter way of naming an activity, not a wider way
   * of reading one. A `PENDING_MODERATION` activity is invisible here exactly as
   * it is there.
   *
   * `LIMIT 1` on a prefix that is unique in practice but not by constraint —
   * forty bits, so about one in two hundred thousand at ten thousand activities.
   * If two ever collide, one link opens the other activity; nothing is disclosed
   * that a public id would not have disclosed, and both are published.
   */
  async findPublishedByPrefix(prefix: string): Promise<DiscoveredEvent | null> {
    const rows = await this.prisma.$queryRaw<SearchRow[]>(
      Prisma.sql`
        SELECT ${SELECT_COLUMNS}, 0::double precision AS score
        FROM "event" e
        ${JOINS}
        WHERE substr(e."public_id", 1, 11) = ${prefix}
          AND e."status" = 'PUBLISHED'
          AND e."deleted_at" IS NULL
        ORDER BY e."public_id"
        LIMIT 1
      `,
    );

    const row = rows[0];
    return row ? toDiscoveredEvent(row, { sort: 'SOONEST' }) : null;
  }

  async explain(
    publicId: string,
    request: Omit<SearchRequest, 'limit' | 'after'>,
  ): Promise<RankExplanation | null> {
    const full = { ...request, limit: 1 } as SearchRequest;

    const rows = await this.prisma.$queryRaw<ExplainRow[]>(
      Prisma.sql`
        SELECT
          ${this.timeProximitySql(request.epoch)}   AS "timeProximity",
          ${POPULARITY_SQL}                          AS "popularity",
          ${this.recencySql(request.epoch)}          AS "recency",
          ${trustSql(request.weights.neutralTrust)}   AS "trust",
          ${this.interestMatchSql(request.viewerCategoryIds)} AS "interestMatch",
          ${this.textRelevanceSql(request.filters.query)}     AS "textRelevance",
          ${this.scoreSql(full)}                     AS "score"
        FROM "event" e
        -- The one join this query needs. It does not use the shared JOINS,
        -- because category and city names are not part of any score component --
        -- but the trust term reads a column, so the row it reads has to be here
        -- or the explanation would not compile.
        LEFT JOIN "trust_score" ts ON ts."user_id" = e."host_user_id"
        WHERE e."public_id" = ${publicId}
          AND e."status" = 'PUBLISHED'
          AND e."deleted_at" IS NULL
        LIMIT 1
      `,
    );

    const row = rows[0];
    if (!row) return null;

    return {
      score: row.score,
      components: {
        timeProximity: row.timeProximity,
        popularity: row.popularity,
        recency: row.recency,
        trust: row.trust,
        interestMatch: row.interestMatch,
        textRelevance: request.filters.query === undefined ? null : row.textRelevance,
      },
      weights: request.weights,
    };
  }

  // ── the score ──────────────────────────────────────────────────────────────

  /**
   * The weighted business score, plus text relevance when there is a query.
   *
   * With a query, relevance is half the score and the business signals are the
   * other half. Text has to weigh heavily or a search for «شطرنج» returns
   * whatever is soonest; it must not weigh entirely, or an imminent, popular
   * event loses to a stale one that happened to repeat the word.
   */
  private scoreSql(request: SearchRequest): Prisma.Sql {
    const w = request.weights;
    const business = Prisma.sql`(
        ${w.timeProximity}::double precision * ${this.timeProximitySql(request.epoch)}
      + ${w.popularity}::double precision    * ${POPULARITY_SQL}
      + ${w.recency}::double precision       * ${this.recencySql(request.epoch)}
      + ${w.trust}::double precision         * ${trustSql(w.neutralTrust)}
      + ${w.interestMatch}::double precision * ${this.interestMatchSql(request.viewerCategoryIds)}
    )`;

    if (request.filters.query === undefined) {
      return Prisma.sql`(${business})::double precision`;
    }

    return Prisma.sql`(
      0.5 * ${this.textRelevanceSql(request.filters.query)} + 0.5 * ${business}
    )::double precision`;
  }

  /**
   * Exponential decay over hours until the event starts, halving roughly every
   * five days. Sooner is better, and the curve is gentle enough that a good
   * event next week still beats a mediocre one tomorrow.
   */
  private timeProximitySql(epoch: Date): Prisma.Sql {
    return Prisma.sql`exp(
      -1.0 * GREATEST(EXTRACT(EPOCH FROM (e."starts_at" - ${epoch}::timestamptz)), 0)::double precision
      / 604800.0
    )::double precision`;
  }

  /** Decay over how long ago it was published, so new listings surface. */
  private recencySql(epoch: Date): Prisma.Sql {
    return Prisma.sql`(CASE
      WHEN e."published_at" IS NULL THEN 0.0
      ELSE exp(
        -1.0 * GREATEST(EXTRACT(EPOCH FROM (${epoch}::timestamptz - e."published_at")), 0)::double precision
        / 259200.0
      )
    END)::double precision`;
  }

  /** 1 when the event's category is one the viewer declared an interest in. */
  private interestMatchSql(viewerCategoryIds: string[]): Prisma.Sql {
    if (viewerCategoryIds.length === 0) {
      // A viewer with no interests scores zero here rather than being handed an
      // empty `= ANY('{}')`, which is the same answer with a wasted comparison.
      return Prisma.sql`0.0::double precision`;
    }
    return Prisma.sql`(CASE
      WHEN e."category_id" IN (${Prisma.join(viewerCategoryIds)}) THEN 1.0 ELSE 0.0
    END)::double precision`;
  }

  /**
   * FTS rank and trigram similarity, whichever is stronger.
   *
   * `GREATEST` rather than a sum: they measure the same thing two ways, and an
   * exact phrase match should not be beaten by a document that scores mediocrely
   * on both.
   */
  private textRelevanceSql(query: string | undefined): Prisma.Sql {
    if (query === undefined) return Prisma.sql`0.0::double precision`;
    return Prisma.sql`GREATEST(
      ts_rank(e."search_vector", plainto_tsquery('simple', ${query})),
      similarity(e."title_normalized", ${query})
    )::double precision`;
  }

  // ── filters, keyset and ordering ───────────────────────────────────────────

  private whereSql(request: SearchRequest): Prisma.Sql {
    const f = request.filters;
    const conditions: Prisma.Sql[] = [
      Prisma.sql`e."status" = 'PUBLISHED'`,
      Prisma.sql`e."deleted_at" IS NULL`,
      // Discovery is a list of things you can still go to.
      Prisma.sql`e."starts_at" > ${request.epoch}::timestamptz`,
    ];

    if (f.query !== undefined) {
      // Full-text OR trigram: FTS catches word matches, trigram catches typos
      // and partial words that no stemmer is available to handle.
      conditions.push(
        Prisma.sql`(
          e."search_vector" @@ plainto_tsquery('simple', ${f.query})
          OR e."title_normalized" % ${f.query}
        )`,
      );
    }
    if (f.cityId !== undefined) conditions.push(Prisma.sql`e."city_id" = ${f.cityId}`);
    if (f.districtId !== undefined) conditions.push(Prisma.sql`e."district_id" = ${f.districtId}`);
    if (f.categoryId !== undefined) conditions.push(Prisma.sql`e."category_id" = ${f.categoryId}`);
    if (f.dateFrom !== undefined) {
      conditions.push(Prisma.sql`e."starts_at" >= ${f.dateFrom}::timestamptz`);
    }
    if (f.dateTo !== undefined) {
      conditions.push(Prisma.sql`e."starts_at" <= ${f.dateTo}::timestamptz`);
    }
    if (f.timeOfDay !== undefined) conditions.push(this.timeOfDaySql(f.timeOfDay));
    if (f.hasCapacity === true) {
      conditions.push(Prisma.sql`e."accepted_count" < e."capacity"`);
    }
    if (f.costType !== undefined) {
      conditions.push(Prisma.sql`e."cost_type" = ${f.costType}::"cost_type"`);
    }
    if (f.costMax !== undefined) {
      // A free event satisfies any budget; SPLIT has no figure yet, so it is not
      // excluded by one either.
      conditions.push(Prisma.sql`(e."cost_amount" IS NULL OR e."cost_amount" <= ${f.costMax})`);
    }
    if (f.genderPreference !== undefined) {
      conditions.push(
        Prisma.sql`e."gender_preference" = ${f.genderPreference}::"gender_preference"`,
      );
    }
    if (f.ageFits !== undefined) {
      conditions.push(
        Prisma.sql`(e."min_age" IS NULL OR ${f.ageFits} >= e."min_age")
                   AND (e."max_age" IS NULL OR ${f.ageFits} <= e."max_age")`,
      );
    }

    return Prisma.join(conditions, ' AND ');
  }

  /**
   * The hour bands, read in the *viewer's* timezone rather than UTC.
   *
   * «عصر پنجشنبه» means an evening in Tehran. Computing the band from the stored
   * UTC hour would put a 19:00 Tehran event in the afternoon bucket for the
   * three and a half hours that matter most.
   */
  private timeOfDaySql(timeOfDay: TimeOfDay): Prisma.Sql {
    const hour = Prisma.sql`EXTRACT(HOUR FROM e."starts_at" AT TIME ZONE ${this.env.APP_TIMEZONE})`;
    switch (timeOfDay) {
      case 'MORNING':
        return Prisma.sql`${hour} BETWEEN 5 AND 11`;
      case 'AFTERNOON':
        return Prisma.sql`${hour} BETWEEN 12 AND 16`;
      case 'EVENING':
        return Prisma.sql`${hour} BETWEEN 17 AND 21`;
      case 'NIGHT':
        return Prisma.sql`(${hour} >= 22 OR ${hour} <= 4)`;
    }
  }

  /**
   * "Strictly after the last row of the previous page."
   *
   * Written out rather than as a row comparison so each side can carry an
   * explicit cast — the score is `double precision` and the date keys are
   * `timestamptz`, and an unbound parameter would otherwise be inferred as text
   * and compared lexicographically.
   */
  private keysetSql(request: SearchRequest): Prisma.Sql {
    if (!request.after) return Prisma.sql`TRUE`;
    const { key, publicId } = request.after;

    switch (request.sort) {
      case 'RELEVANCE': {
        const score = Prisma.sql`${Number(key)}::double precision`;
        return Prisma.sql`(score < ${score}
          OR (score = ${score} AND "publicId" < ${publicId}))`;
      }
      case 'SOONEST': {
        const startsAt = Prisma.sql`${new Date(key)}::timestamptz`;
        return Prisma.sql`("startsAt" > ${startsAt}
          OR ("startsAt" = ${startsAt} AND "publicId" > ${publicId}))`;
      }
      case 'NEWEST': {
        const publishedAt = Prisma.sql`${new Date(key)}::timestamptz`;
        return Prisma.sql`("publishedAt" < ${publishedAt}
          OR ("publishedAt" = ${publishedAt} AND "publicId" < ${publicId}))`;
      }
    }
  }

  private orderSql(request: SearchRequest): Prisma.Sql {
    switch (request.sort) {
      case 'RELEVANCE':
        return Prisma.sql`score DESC, "publicId" DESC`;
      case 'SOONEST':
        return Prisma.sql`"startsAt" ASC, "publicId" ASC`;
      case 'NEWEST':
        return Prisma.sql`"publishedAt" DESC, "publicId" DESC`;
    }
  }
}

/**
 * The projection, named once.
 *
 * An allowlist of columns, per plan §3.6 layer 2. Absent by construction:
 * `host_user_id`, the internal `id`, the normalized text, `moderation_status`.
 * Adding a column to `event` cannot put it on the wire by accident.
 */
const SELECT_COLUMNS = Prisma.sql`
  e."public_id"                    AS "publicId",
  e."title",
  e."description",
  cat."id"                         AS "categoryId",
  cat."slug"                       AS "categorySlug",
  cat."name_fa"                    AS "categoryNameFa",
  e."custom_category_label"        AS "customCategoryLabel",
  ct."id"                          AS "cityId",
  ct."slug"                        AS "citySlug",
  ct."name_fa"                     AS "cityNameFa",
  d."id"                           AS "districtId",
  d."slug"                         AS "districtSlug",
  d."name_fa"                      AS "districtNameFa",
  -- The typed neighbourhood, for the overwhelmingly common case where the
  -- district catalogue is empty and there is nothing to join to (v0.6.5).
  e."district_label"               AS "districtLabel",
  e."starts_at"                    AS "startsAt",
  e."ends_at"                      AS "endsAt",
  e."capacity",
  e."accepted_count"               AS "acceptedCount",
  e."cost_type"                    AS "costType",
  e."cost_amount"                  AS "costAmount",
  e."cost_note"                    AS "costNote",
  e."gender_preference"            AS "genderPreference",
  e."min_age"                      AS "minAge",
  e."max_age"                      AS "maxAge",
  e."external_link"                AS "externalLink",
  e."published_at"                 AS "publishedAt",
  hu."public_id"                   AS "hostPublicId",
  COALESCE(hp."display_name", 'کاربر پایه‌تَم') AS "hostDisplayName",
  -- Deliberately NOT coalesced to the neutral score, unlike the trustSql helper
  -- below. Ranking has to resolve a missing row to something numeric or a new
  -- host sorts last; display must not, or a host who has never been judged is
  -- shown a number they never earned. Same LEFT JOIN, two different readings of
  -- the same NULL, and both are correct for what they do.
  ts."score"                       AS "hostTrustScore"
`;

/**
 * The host profile is a LEFT JOIN, not an inner one.
 *
 * Authoring requires a completed profile, so in normal operation the row is
 * always there. But M15's anonymisation clears profiles, and an inner join would
 * make every event by an anonymised host silently vanish from discovery rather
 * than showing a placeholder name.
 */
const JOINS = Prisma.sql`
  JOIN "category" cat ON cat."id" = e."category_id"
  JOIN "city" ct      ON ct."id" = e."city_id"
  LEFT JOIN "district" d ON d."id" = e."district_id"
  JOIN "user" hu      ON hu."id" = e."host_user_id"
  LEFT JOIN "user_profile" hp ON hp."user_id" = e."host_user_id"
  -- LEFT, because a host with no trust row is the common case: the row is
  -- created lazily by the first movement, so every host who has not completed a
  -- profile yet has none. They rank at the neutral score, not at zero.
  LEFT JOIN "trust_score" ts ON ts."user_id" = e."host_user_id"
`;

/**
 * Log-scaled join requests, saturating around fifty.
 *
 * Linear popularity would let one runaway event dominate every page; the log
 * curve means the difference between 0 and 5 requests matters far more than the
 * difference between 45 and 50, which is how attention actually behaves.
 *
 * `view_count` is deliberately not part of this. Incrementing it on every detail
 * read would take a row lock on `event` — the same row M6 locks for capacity —
 * and putting a write on the hottest read path to feed a ranking signal is a bad
 * trade. It can be fed by a batched job later.
 */
const POPULARITY_SQL = Prisma.sql`LEAST(ln(1 + e."request_count") / ln(51.0), 1.0)::double precision`;

/**
 * The host's reputation, normalised to 0–1 (M9).
 *
 * This was a constant `0.5` from M5 until now, deliberately: keeping the term in
 * the formula from the start meant the weight was real, configurable and visible
 * in `explain-rank` before there was anything to read, so this milestone changes
 * a constant into a column read rather than re-deriving the ranking.
 *
 * `COALESCE` to the neutral score is the part that matters for fairness. A host
 * with no `trust_score` row has not been judged, not been judged badly — and
 * plan §12 resolves "Trust Score in ranking" against "no unfair discrimination"
 * by capping trust at a tenth of the signal *and* giving new hosts a neutral
 * bucket. Reading a missing row as zero would bury every new host on the
 * platform, which is exactly the outcome that resolution exists to prevent.
 */
function trustSql(neutralTrust: number): Prisma.Sql {
  return Prisma.sql`(COALESCE(ts."score", ${neutralTrust}::int)::double precision / 100.0)`;
}

interface SearchRow {
  publicId: string;
  title: string;
  description: string;
  categoryId: string;
  categorySlug: string;
  categoryNameFa: string;
  customCategoryLabel: string | null;
  cityId: string;
  citySlug: string;
  cityNameFa: string;
  districtId: string | null;
  districtSlug: string | null;
  districtNameFa: string | null;
  districtLabel: string | null;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  acceptedCount: number;
  costType: DiscoveredEvent['costType'];
  costAmount: number | null;
  costNote: string | null;
  genderPreference: DiscoveredEvent['genderPreference'];
  minAge: number | null;
  maxAge: number | null;
  externalLink: string | null;
  publishedAt: Date | null;
  hostPublicId: string;
  hostDisplayName: string;
  hostTrustScore: number | null;
  score: number;
}

interface ExplainRow {
  timeProximity: number;
  popularity: number;
  recency: number;
  trust: number;
  interestMatch: number;
  textRelevance: number;
  score: number;
}

/**
 * `score` is dropped rather than spread through.
 *
 * It is an internal ranking artefact, and `DiscoveredEvent` does not declare it —
 * but a spread carries excess properties past TypeScript's checks, so without
 * this the returned object would have a field its own type says does not exist.
 * The wire view maps field by field and would not have passed it on, which is
 * exactly why it is worth removing here: a leak that only one layer stops is one
 * layer from being a leak. Where the score is genuinely needed it travels as
 * `sortKey`, which the cursor already exposes by design.
 */
function toDiscoveredEvent(
  row: SearchRow,
  request: { sort: SearchRequest['sort'] },
): DiscoveredEvent {
  const { score: _score, ...event } = row;
  return {
    ...event,
    sortKey: sortKeyFor(row, request.sort),
  };
}

/** The value the next cursor keys on, matching whatever the ORDER BY used. */
function sortKeyFor(row: SearchRow, sort: SearchRequest['sort']): number | string {
  switch (sort) {
    case 'RELEVANCE':
      return row.score;
    case 'SOONEST':
      return row.startsAt.toISOString();
    case 'NEWEST':
      return (row.publishedAt ?? row.startsAt).toISOString();
  }
}

export type { RankingWeights, DiscoveryFilters };
