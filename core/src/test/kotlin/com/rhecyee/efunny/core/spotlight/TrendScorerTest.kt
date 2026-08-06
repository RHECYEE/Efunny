package com.rhecyee.efunny.core.spotlight

import com.rhecyee.efunny.core.model.RawPost
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class TrendScorerTest {

    private val now = Instant.parse("2026-08-06T12:00:00Z")
    private val scorer = TrendScorer(Clock.fixed(now, ZoneOffset.UTC))

    private fun post(id: String, ageHours: Long, engagement: Double?) = RawPost(
        sourceConfigId = 1,
        externalId = id,
        title = "Post $id",
        permalink = "https://example.com/$id",
        publishedAt = now.minusSeconds(ageHours * 3600),
        engagement = engagement,
    )

    @Test
    fun `a fast riser beats an older post with more total engagement`() {
        // This is the whole point of dividing by age. 12k views in 2 hours is
        // trending; 20k views accumulated over 20 hours is merely popular.
        val fastRiser = post("fast", ageHours = 2, engagement = 12_000.0)
        val slowGiant = post("slow", ageHours = 20, engagement = 20_000.0)

        val ranked = scorer.score(listOf(slowGiant, fastRiser))

        assertEquals("fast", ranked.first().post.externalId)
        assertTrue(ranked.first().velocity > ranked.last().velocity)
    }

    @Test
    fun `age is floored at one hour so a minutes-old post cannot divide its way to the top`() {
        val brandNew = post("new", ageHours = 0, engagement = 5.0)
        val solid = post("solid", ageHours = 3, engagement = 3_000.0)

        val ranked = scorer.score(listOf(brandNew, solid))

        assertEquals("solid", ranked.first().post.externalId, "5 views should not outrank 3000")
        assertEquals(5.0, ranked.last().velocity, "floored at 1h, not divided by ~0")
    }

    @Test
    fun `posts with no engagement signal fall back to pure recency`() {
        // RSS feeds carry no engagement data at all. Ranking these by recency is
        // honest; inventing an engagement number would not be.
        val older = post("older", ageHours = 10, engagement = null)
        val newer = post("newer", ageHours = 2, engagement = null)

        val ranked = scorer.score(listOf(older, newer))

        assertEquals("newer", ranked.first().post.externalId)
    }

    @Test
    fun `scores are percentiles within the source, spanning zero to one`() {
        val posts = (1..5).map { post("p$it", ageHours = 1, engagement = it * 100.0) }

        val ranked = scorer.score(posts)

        assertEquals(1.0, ranked.first().score)
        assertEquals(0.0, ranked.last().score)
        assertTrue(ranked.all { it.score in 0.0..1.0 })
        assertEquals(listOf("p5", "p4", "p3", "p2", "p1"), ranked.map { it.post.externalId })
    }

    @Test
    fun `ties share a score rather than being ordered by list position`() {
        val ranked = scorer.score(
            listOf(
                post("a", ageHours = 2, engagement = 100.0),
                post("b", ageHours = 2, engagement = 100.0),
            ),
        )
        assertEquals(ranked[0].score, ranked[1].score)
    }

    @Test
    fun `a lone candidate scores top of its own pool`() {
        val ranked = scorer.score(listOf(post("only", ageHours = 4, engagement = 7.0)))
        assertEquals(1, ranked.size)
        assertEquals(1.0, ranked.single().score)
    }

    @Test
    fun `an empty pool scores to nothing`() {
        assertEquals(emptyList(), scorer.score(emptyList()))
    }
}
