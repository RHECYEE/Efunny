package com.rhecyee.efunny.core

import com.rhecyee.efunny.core.feelers.Credentials
import com.rhecyee.efunny.core.feelers.FacebookGroupsFeeler
import com.rhecyee.efunny.core.feelers.Feeler
import com.rhecyee.efunny.core.feelers.InstagramReelsFeeler
import com.rhecyee.efunny.core.feelers.RedditFeeler
import com.rhecyee.efunny.core.feelers.RssFeeler
import com.rhecyee.efunny.core.feelers.TikTokFeeler
import com.rhecyee.efunny.core.feelers.YouTubeShortsFeeler
import com.rhecyee.efunny.core.model.DefaultSources
import com.rhecyee.efunny.core.model.SourceType
import com.rhecyee.efunny.core.net.OkHttpClientHttp
import com.rhecyee.efunny.core.schedule.DropSchedule
import com.rhecyee.efunny.core.spotlight.Deduper
import com.rhecyee.efunny.core.spotlight.PostFingerprint
import com.rhecyee.efunny.core.spotlight.SpotlightCompiler
import com.rhecyee.efunny.core.spotlight.SpotlightService
import com.rhecyee.efunny.core.spotlight.SpotlightSpec
import com.rhecyee.efunny.core.spotlight.TrendScorer
import kotlinx.coroutines.runBlocking
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Runs a real day of drops against the live internet and prints the result.
 *
 * Deliberately a `main` rather than a test: it depends on the outside world, so
 * it must never gate CI. Run it on demand with
 *
 *     ./gradlew :core:liveBatch
 *
 * Keys are optional and read from the environment. Without them you see exactly
 * what a fresh install sees:
 *
 *     YOUTUBE_API_KEY=...  REDDIT_CLIENT_ID=...  ./gradlew :core:liveBatch
 */
object LiveBatch {

    @JvmStatic
    fun main(args: Array<String>) = runBlocking {
        val credentials = object : Credentials {
            override fun youtubeApiKey() = System.getenv("YOUTUBE_API_KEY")
            override fun redditClientId() = System.getenv("REDDIT_CLIENT_ID")
        }

        val http = OkHttpClientHttp()
        val deduper = Deduper()
        val clock = Clock.systemUTC()

        val feelers: Map<SourceType, Feeler> = mapOf(
            SourceType.RSS to RssFeeler(http),
            SourceType.REDDIT to RedditFeeler(http, credentials, clock),
            SourceType.YOUTUBE_SHORTS to YouTubeShortsFeeler(http, credentials),
            SourceType.INSTAGRAM_REELS to InstagramReelsFeeler(),
            SourceType.TIKTOK to TikTokFeeler(),
            SourceType.FACEBOOK_GROUP to FacebookGroupsFeeler(),
        )

        val service = SpotlightService(
            feelers = feelers,
            compiler = SpotlightCompiler(TrendScorer(clock), deduper),
            clock = clock,
        )

        println(banner(credentials))

        val schedule = DropSchedule(ZoneId.of("America/Denver"))
        val shown = mutableListOf<PostFingerprint>()
        var totalPosts = 0

        // Three drops back to back. They share a `shown` list, so this exercises
        // cross-drop dedup for real -- the 15:00 and 20:00 sets have to find
        // different posts from the same 24-hour windows.
        var cursor = clock.instant()
        repeat(SpotlightSpec.DROPS_PER_DAY) { index ->
            val slot = schedule.nextAfter(cursor)
            val drop = service.runDrop(DefaultSources.ALL, previouslyShown = shown.toList())

            println()
            println("=".repeat(78))
            println("DROP ${index + 1}/3  ${slot.slot.label} ${slot.slot.localTime}  Mountain")
            println("=".repeat(78))

            drop.entries.forEachIndexed { rank, scored ->
                val post = scored.post
                val source = DefaultSources.ALL.first { it.id == post.sourceConfigId }
                val age = Duration.between(post.publishedAt, clock.instant()).toHours()
                val signal = post.engagement
                    ?.let { "%,.0f".format(it) }
                    ?: "latest"

                println()
                println("  ${rank + 1}. [${source.displayName}] ${post.title.take(96)}")
                println("     ${age}h ago  |  $signal  |  score ${"%.2f".format(scored.score)}")
                println("     ${post.permalink}")
            }

            if (drop.unavailable.isNotEmpty()) {
                println()
                println("  -- sources that could not contribute --")
                drop.unavailable.forEach { (name, reason) -> println("     $name: $reason") }
            }
            println()
            println("  filled ${drop.entries.size}/${SpotlightSpec.POSTS_PER_DROP}" +
                "   backfilled ${drop.backfilled}   unfilled ${drop.shortfall}")

            shown += drop.entries.map { deduper.fingerprint(it.post) }
            // Real drops are 5-10 hours apart. Firing three inside a second is
            // what tripped Reddit's unauthenticated limit the first time this
            // ran, so the harness spaces them out to stay representative.
            if (index < SpotlightSpec.DROPS_PER_DAY - 1) kotlinx.coroutines.delay(PAUSE_BETWEEN_DROPS_MS)
            totalPosts += drop.entries.size
            cursor = slot.at
        }

        println()
        println("=".repeat(78))
        println("DAY TOTAL: $totalPosts posts (target ${SpotlightSpec.POSTS_PER_DAY})")
        println("Distinct across all drops: ${shown.map { it.externalId }.toSet().size}")
        println("=".repeat(78))
    }

    private const val PAUSE_BETWEEN_DROPS_MS = 8_000L

    private fun banner(credentials: Credentials): String = buildString {
        appendLine("EFunny live batch  ${DateTimeFormatter.ISO_INSTANT.format(Instant.now())}")
        appendLine("YouTube key: ${if (credentials.youtubeApiKey().isNullOrBlank()) "absent" else "present"}")
        appendLine(
            "Reddit client ID: ${
                if (credentials.redditClientId().isNullOrBlank()) {
                    "absent (keyless RSS, recency-ranked)"
                } else {
                    "present (engagement-ranked)"
                }
            }",
        )
    }
}
