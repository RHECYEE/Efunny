package com.rhecyee.efunny.core.model

import java.time.Instant

/**
 * The kinds of feeler EFunny knows how to run.
 *
 * [INSTAGRAM_REELS], [TIKTOK] and [FACEBOOK_GROUP] are declared but permanently
 * unavailable in v1 -- see `feelers/ClosedPlatformFeelers.kt` for why each one is
 * dark. They exist as real types so the seven-slot shape stays intact and so
 * enabling one later is a fetch body, not a refactor.
 */
enum class SourceType {
    YOUTUBE_SHORTS,
    REDDIT,
    RSS,
    INSTAGRAM_REELS,
    TIKTOK,
    FACEBOOK_GROUP,
}

/**
 * One configured source. Sources are data, not classes: adding an RSS site or
 * swapping a subreddit is a row edit, which is what makes "configurable
 * websites" work without a code change.
 *
 * [params] is type-specific: `url` for RSS, `subreddit` for Reddit, `query` for
 * YouTube.
 */
data class SourceConfig(
    val id: Long,
    val type: SourceType,
    val displayName: String,
    val params: Map<String, String> = emptyMap(),
    val quotaPerDrop: Int = 1,
    val enabled: Boolean = true,
    val position: Int = 0,
)

/**
 * A candidate post as a feeler found it, before any cross-source reasoning.
 *
 * [engagement] is deliberately nullable and deliberately pre-computed by the
 * feeler. Each platform's formula belongs with the platform that understands its
 * units, and `null` is a real state, not a zero: an RSS feed carries no
 * engagement signal at all, so those posts rank on recency and the UI labels
 * them "Latest" rather than claiming a trend the data cannot support.
 */
data class RawPost(
    val sourceConfigId: Long,
    val externalId: String,
    val title: String,
    val permalink: String,
    val publishedAt: Instant,
    val engagement: Double? = null,
    val thumbnailUrl: String? = null,
    val author: String? = null,
)

/** A [RawPost] ranked against the other candidates from its own source. */
data class ScoredPost(
    val post: RawPost,
    /** Engagement per hour of age, or a pure recency signal when engagement is null. */
    val velocity: Double,
    /** Percentile rank within this source's candidate pool, 0.0..1.0. */
    val score: Double,
)

/** The lookback a drop considers. Always 24h in v1, but passed explicitly so feelers never assume. */
data class TimeWindow(val from: Instant, val to: Instant) {
    operator fun contains(instant: Instant): Boolean =
        !instant.isBefore(from) && !instant.isAfter(to)

    companion object {
        fun lastHours(now: Instant, hours: Long): TimeWindow =
            TimeWindow(now.minusSeconds(hours * 3600), now)
    }
}
