package com.rhecyee.efunny.core.spotlight

import com.rhecyee.efunny.core.TestPosts
import com.rhecyee.efunny.core.feelers.Feeler
import com.rhecyee.efunny.core.feelers.FeelerResult
import com.rhecyee.efunny.core.model.SourceConfig
import com.rhecyee.efunny.core.model.SourceType
import com.rhecyee.efunny.core.model.TimeWindow
import com.rhecyee.efunny.core.schedule.DropSchedule
import kotlinx.coroutines.test.runTest
import java.time.Clock
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The test that pins the headline number end to end:
 *
 *     7 sources x 3 posts each = 21 posts per day, in 3 sets of 7.
 *
 * If this passes, the product definition holds. If someone changes a quota, a
 * dedup rule or the round-robin and breaks the arithmetic, this is what fails.
 */
class FullDayTest {

    private val dayStart = Instant.parse("2026-08-06T11:00:00Z") // 05:00 MDT

    /** Seven sources, each with a deep enough pool to last all three drops. */
    private val configs = (1L..7L).map { id ->
        SourceConfig(
            id = id,
            type = SourceType.RSS,
            displayName = "Source $id",
            position = id.toInt(),
        )
    }

    private class PoolFeeler(private val perSource: Int) : Feeler {
        override val type = SourceType.RSS
        override suspend fun fetch(config: SourceConfig, window: TimeWindow): FeelerResult =
            FeelerResult.Success(TestPosts.pool(config.id, perSource, window.to))
    }

    @Test
    fun `a full day produces 21 distinct posts, three from every source`() = runTest {
        val deduper = Deduper()
        val schedule = DropSchedule(ZoneId.of("America/Denver"))

        val shown = mutableListOf<PostFingerprint>()
        val drops = mutableListOf<CompiledDrop>()

        var cursor = dayStart.minusSeconds(60)
        repeat(SpotlightSpec.DROPS_PER_DAY) {
            val at = schedule.nextAfter(cursor).at
            val service = SpotlightService(
                feelers = mapOf(SourceType.RSS to PoolFeeler(perSource = 10)),
                compiler = SpotlightCompiler(TrendScorer(Clock.fixed(at, ZoneOffset.UTC)), deduper),
                clock = Clock.fixed(at, ZoneOffset.UTC),
            )

            val drop = service.runDrop(configs, previouslyShown = shown.toList())
            drops += drop
            shown += drop.entries.map { deduper.fingerprint(it.post) }
            cursor = at
        }

        assertEquals(SpotlightSpec.DROPS_PER_DAY, drops.size)
        drops.forEachIndexed { index, drop ->
            assertEquals(SpotlightSpec.POSTS_PER_DROP, drop.entries.size, "drop $index should hold 7")
            assertEquals(0, drop.shortfall, "drop $index fell short")
        }

        val all = drops.flatMap { it.entries }.map { it.post.externalId }
        assertEquals(SpotlightSpec.POSTS_PER_DAY, all.size, "the day should total 21")
        assertEquals(all.size, all.toSet().size, "no post may appear in two drops")

        val perSource = drops.flatMap { it.entries }.groupingBy { it.post.sourceConfigId }.eachCount()
        assertEquals(7, perSource.size, "all seven sources should appear")
        perSource.forEach { (sourceId, count) ->
            assertEquals(3, count, "source $sourceId owes exactly 3 posts a day")
        }
    }

    @Test
    fun `a dead source costs the day its three posts but never the drop size`() = runTest {
        val deduper = Deduper()
        val dead = object : Feeler {
            override val type = SourceType.YOUTUBE_SHORTS
            override suspend fun fetch(config: SourceConfig, window: TimeWindow) =
                FeelerResult.Unavailable("No API key set")
        }

        val withDeadSource = configs.dropLast(1) +
            configs.last().copy(type = SourceType.YOUTUBE_SHORTS)

        val service = SpotlightService(
            feelers = mapOf(
                SourceType.RSS to PoolFeeler(perSource = 10),
                SourceType.YOUTUBE_SHORTS to dead,
            ),
            compiler = SpotlightCompiler(TrendScorer(Clock.fixed(dayStart, ZoneOffset.UTC)), deduper),
            clock = Clock.fixed(dayStart, ZoneOffset.UTC),
        )

        val drop = service.runDrop(withDeadSource)

        assertEquals(7, drop.entries.size, "backfill keeps the set whole")
        assertEquals(1, drop.backfilled)
        assertTrue(drop.unavailable.containsValue("No API key set"))
    }

    @Test
    fun `one source throwing does not take the whole drop down`() = runTest {
        val exploding = object : Feeler {
            override val type = SourceType.YOUTUBE_SHORTS
            override suspend fun fetch(config: SourceConfig, window: TimeWindow): FeelerResult =
                throw IllegalStateException("malformed JSON")
        }

        val service = SpotlightService(
            feelers = mapOf(
                SourceType.RSS to PoolFeeler(perSource = 10),
                SourceType.YOUTUBE_SHORTS to exploding,
            ),
            compiler = SpotlightCompiler(TrendScorer(Clock.fixed(dayStart, ZoneOffset.UTC))),
            clock = Clock.fixed(dayStart, ZoneOffset.UTC),
        )

        val drop = service.runDrop(
            configs.dropLast(1) + configs.last().copy(type = SourceType.YOUTUBE_SHORTS),
        )

        assertEquals(7, drop.entries.size)
        assertTrue(
            drop.unavailable.values.any { it.contains("malformed JSON") },
            "the failure should be reported against its source, not swallowed",
        )
    }
}
