package com.rhecyee.efunny.core.spotlight

/**
 * The headline numbers, in one place.
 *
 *     7 sources x 3 posts each = 21 posts per day
 *     delivered as 3 sets of 7 at 05:00 / 15:00 / 20:00 Mountain
 *     -> 1 post per source, per drop
 *
 * Both halves of the product definition are true at once here: every source
 * contributes exactly 3 posts a day, and the day totals 21.
 *
 * Nothing else in the codebase hardcodes 3, 7 or 21. Changing the daily shape is
 * an edit to this object plus the tests that assert on it.
 */
object SpotlightSpec {
    const val DROPS_PER_DAY = 3
    const val POSTS_PER_DROP = 7
    const val POSTS_PER_DAY = DROPS_PER_DAY * POSTS_PER_DROP

    /** Per source, per drop. Over three drops that is the "3 each" from the brief. */
    const val QUOTA_PER_SOURCE_PER_DROP = 1

    /** Every drop looks back a full day; cross-drop dedup stops it repeating itself. */
    const val LOOKBACK_HOURS = 24L

    /**
     * How many previous drops a candidate is checked against before it may be
     * shown again. Three drops is exactly one day, matching [LOOKBACK_HOURS].
     */
    const val DEDUP_AGAINST_PREVIOUS_DROPS = 3

    /**
     * Candidates each feeler is asked for. Far more than the quota of 1, because
     * a full day of already-shown posts gets filtered out first -- and because
     * backfill may ask a healthy source for several more when another is down.
     */
    const val CANDIDATES_PER_SOURCE = 50
}
