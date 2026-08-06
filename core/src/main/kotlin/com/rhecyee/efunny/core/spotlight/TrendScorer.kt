package com.rhecyee.efunny.core.spotlight

import com.rhecyee.efunny.core.model.RawPost
import com.rhecyee.efunny.core.model.ScoredPost
import java.time.Clock
import java.time.Duration

/**
 * Ranks a source's candidates against each other.
 *
 * The rule that shapes this class: a YouTube view is not a Reddit upvote, so raw
 * engagement is never compared across sources. Scoring normalises *within* a
 * source and emits a percentile, which is the only number the compiler is
 * allowed to compare between sources.
 */
class TrendScorer(private val clock: Clock) {

    /** Scores one source's pool. Callers must not mix sources in a single call. */
    fun score(posts: List<RawPost>): List<ScoredPost> {
        if (posts.isEmpty()) return emptyList()

        val now = clock.instant()
        val velocities = posts.map { it to velocity(it, now) }

        // Percentile by count of strictly-slower peers, so ties share a score
        // rather than being ordered arbitrarily by list position.
        val sorted = velocities.map { it.second }.sorted()
        val denominator = (posts.size - 1).coerceAtLeast(1).toDouble()

        return velocities.map { (post, v) ->
            val strictlyLower = sorted.count { it < v }
            ScoredPost(
                post = post,
                velocity = v,
                score = if (posts.size == 1) 1.0 else strictlyLower / denominator,
            )
        }.sortedByDescending { it.score }
    }

    /**
     * Engagement per hour of age. Dividing by age is what makes this "trending"
     * rather than "popular": a post pulling 10k views in two hours beats one that
     * took twenty hours to reach the same number.
     *
     * Age is floored at one hour so a minutes-old post with a handful of views
     * cannot divide its way to the top of the pool.
     */
    private fun velocity(post: RawPost, now: java.time.Instant): Double {
        val ageHours = Duration.between(post.publishedAt, now)
            .toMinutes()
            .coerceAtLeast(0) / 60.0
        val age = ageHours.coerceAtLeast(1.0)

        // No engagement signal exists in an RSS feed. Rather than inventing one,
        // these rank purely on freshness -- and the UI labels them "Latest".
        val engagement = post.engagement ?: return 1.0 / age
        return engagement / age
    }
}
