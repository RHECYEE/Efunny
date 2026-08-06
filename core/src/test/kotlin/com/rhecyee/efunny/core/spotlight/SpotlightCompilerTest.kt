package com.rhecyee.efunny.core.spotlight

import com.rhecyee.efunny.core.TestPosts
import com.rhecyee.efunny.core.feelers.FeelerResult
import com.rhecyee.efunny.core.model.RawPost
import com.rhecyee.efunny.core.model.SourceConfig
import com.rhecyee.efunny.core.model.SourceType
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SpotlightCompilerTest {

    private val now = Instant.parse("2026-08-06T12:00:00Z")
    private val compiler = SpotlightCompiler(TrendScorer(Clock.fixed(now, ZoneOffset.UTC)))

    private fun source(id: Long) = SourceConfig(
        id = id,
        type = SourceType.RSS,
        displayName = "Source $id",
        position = id.toInt(),
    )

    private fun posts(sourceId: Long, count: Int) = TestPosts.pool(sourceId, count, now)

    private fun healthy(id: Long, count: Int = 10) =
        SourceOutcome(source(id), FeelerResult.Success(posts(id, count)))

    private fun down(id: Long, reason: String = "offline") =
        SourceOutcome(source(id), FeelerResult.Unavailable(reason))

    @Test
    fun `seven healthy sources give exactly one post each`() {
        val drop = compiler.compile((1L..7L).map { healthy(it) })

        assertEquals(SpotlightSpec.POSTS_PER_DROP, drop.entries.size)
        assertEquals(0, drop.shortfall)
        assertEquals(0, drop.backfilled, "nobody needed covering for")
        assertEquals(
            (1L..7L).toSet(),
            drop.entries.map { it.post.sourceConfigId }.toSet(),
            "every source should be represented exactly once",
        )
    }

    @Test
    fun `still reaches seven when two sources are unavailable`() {
        val outcomes = (1L..5L).map { healthy(it) } + down(6) + down(7, "no API")

        val drop = compiler.compile(outcomes)

        assertEquals(7, drop.entries.size, "backfill should cover the two dead sources")
        assertEquals(0, drop.shortfall)
        assertEquals(2, drop.backfilled)
        assertEquals(mapOf("Source 6" to "offline", "Source 7" to "no API"), drop.unavailable)
    }

    @Test
    fun `no source takes a second slot until every source has had a first`() {
        // Source 1 is overflowing, source 2 has a single post. Source 2's one
        // post must still make the cut before source 1 takes seconds.
        val outcomes = listOf(healthy(1, count = 10), SourceOutcome(source(2), FeelerResult.Success(posts(2, 1))))

        val drop = compiler.compile(outcomes, target = 4)

        assertEquals(4, drop.entries.size)
        val bySource = drop.entries.groupingBy { it.post.sourceConfigId }.eachCount()
        assertEquals(1, bySource[2L], "the thin source keeps its slot")
        assertEquals(3, bySource[1L], "the rich source absorbs the rest")
    }

    @Test
    fun `degrades gracefully rather than padding when everything is dry`() {
        val outcomes = listOf(healthy(1, count = 2)) + (2L..7L).map { down(it) }

        val drop = compiler.compile(outcomes)

        assertEquals(2, drop.entries.size, "only two real posts existed")
        assertEquals(5, drop.shortfall, "the gap is reported, not filled with filler")
        assertEquals(6, drop.unavailable.size)
    }

    @Test
    fun `excludes posts already shown in earlier drops`() {
        val deduper = Deduper()
        val alreadyShown = posts(1, 3).map { deduper.fingerprint(it) }

        val drop = compiler.compile(listOf(healthy(1, count = 10)), previouslyShown = alreadyShown, target = 3)

        assertEquals(3, drop.entries.size)
        assertTrue(
            drop.entries.none { it.post.externalId in setOf("s1-p1", "s1-p2", "s1-p3") },
            "the 05:00 picks must not come round again at 15:00",
        )
    }

    @Test
    fun `collapses the same joke cross-posted to two sources`() {
        val shared = "Local man discovers one weird trick to avoid doing the dishes forever"
        val a = RawPost(1, "a1", shared, "https://a.example/1", now.minusSeconds(3600), 900.0)
        val b = RawPost(2, "b1", "$shared 😂", "https://b.example/1", now.minusSeconds(3600), 800.0)

        val drop = compiler.compile(
            listOf(
                SourceOutcome(source(1), FeelerResult.Success(listOf(a))),
                SourceOutcome(source(2), FeelerResult.Success(listOf(b))),
            ),
            target = 7,
        )

        assertEquals(1, drop.entries.size, "an added emoji does not make it a different post")
        assertEquals("a1", drop.entries.single().post.externalId, "the higher-scoring copy survives")
    }

    @Test
    fun `disabled sources contribute nothing`() {
        val outcomes = listOf(
            healthy(1),
            SourceOutcome(source(2).copy(enabled = false), FeelerResult.Success(posts(2, 10))),
        )

        val drop = compiler.compile(outcomes, target = 7)

        assertTrue(drop.entries.none { it.post.sourceConfigId == 2L })
    }

    @Test
    fun `entries come out ranked best first`() {
        val drop = compiler.compile((1L..7L).map { healthy(it) })
        assertTrue(
            drop.entries.zipWithNext().all { (a, b) -> a.score >= b.score },
            "the feed should read strongest first",
        )
    }
}
