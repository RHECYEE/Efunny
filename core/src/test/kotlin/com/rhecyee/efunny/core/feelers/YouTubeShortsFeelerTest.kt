package com.rhecyee.efunny.core.feelers

import com.rhecyee.efunny.core.model.SourceConfig
import com.rhecyee.efunny.core.model.SourceType
import com.rhecyee.efunny.core.model.TimeWindow
import com.rhecyee.efunny.core.net.FakeHttp
import com.rhecyee.efunny.core.net.HttpResponse
import kotlinx.coroutines.test.runTest
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

class YouTubeShortsFeelerTest {

    private val config = SourceConfig(
        id = 1,
        type = SourceType.YOUTUBE_SHORTS,
        displayName = "YouTube Shorts",
        params = mapOf("query" to "#shorts funny"),
    )

    private val credentials = object : Credentials {
        override fun youtubeApiKey() = "test-key"
        override fun redditClientId() = null
    }

    private val searchJson = """
    {"items":[
      {"id":{"videoId":"short1"}},
      {"id":{"videoId":"short2"}},
      {"id":{"videoId":"notashort"}}
    ]}
    """.trimIndent()

    private val videosJson = """
    {"items":[
      {"id":"short1","snippet":{"title":"The cat found the laser pointer at last",
        "publishedAt":"2026-08-06T06:00:00Z","channelTitle":"Cat Channel",
        "thumbnails":{"medium":{"url":"https://i.ytimg.com/m1.jpg"},"high":{"url":"https://i.ytimg.com/h1.jpg"}}},
        "contentDetails":{"duration":"PT45S"},"statistics":{"viewCount":"100000","likeCount":"5000"}},
      {"id":"short2","snippet":{"title":"A dog reviews the new sofa honestly",
        "publishedAt":"2026-08-06T09:00:00Z","channelTitle":"Dog Channel"},
        "contentDetails":{"duration":"PT2M59S"},"statistics":{"viewCount":"5000","likeCount":"100"}},
      {"id":"notashort","snippet":{"title":"A three and a half minute sketch about queueing",
        "publishedAt":"2026-08-06T08:00:00Z","channelTitle":"Sketch Channel"},
        "contentDetails":{"duration":"PT3M30S"},"statistics":{"viewCount":"900000","likeCount":"80000"}}
    ]}
    """.trimIndent()

    private fun okHttp() = FakeHttp(
        routes = listOf(
            "/youtube/v3/search" to HttpResponse(200, searchJson),
            "/youtube/v3/videos" to HttpResponse(200, videosJson),
        ),
    )

    private fun window() = TimeWindow(
        from = Instant.parse("2026-08-05T12:00:00Z"),
        to = Instant.parse("2026-08-06T12:00:00Z"),
    )

    @Test
    fun `excludes results longer than three minutes`() = runTest {
        // videoDuration=short only narrows to under four minutes, so a 3m30s
        // video comes back from search despite not being a Short. Without the
        // duration filter it would win outright on its 900k views.
        val result = YouTubeShortsFeeler(okHttp(), credentials).fetch(config, window())

        val success = assertIs<FeelerResult.Success>(result)
        assertEquals(setOf("short1", "short2"), success.posts.map { it.externalId }.toSet())
        assertFalse(success.posts.any { it.externalId == "notashort" }, "3m30s is not a Short")
    }

    @Test
    fun `weights likes far above views`() = runTest {
        val result = YouTubeShortsFeeler(okHttp(), credentials).fetch(config, window())
        val posts = assertIs<FeelerResult.Success>(result).posts

        val short1 = posts.single { it.externalId == "short1" }
        assertEquals(100_000 + 10.0 * 5_000, short1.engagement, "views + 10 x likes")
        assertEquals("https://www.youtube.com/shorts/short1", short1.permalink)
        assertEquals("https://i.ytimg.com/h1.jpg", short1.thumbnailUrl, "prefers the high-res thumbnail")
        assertEquals("Cat Channel", short1.author)
    }

    @Test
    fun `searches rather than reading the mostPopular chart`() = runTest {
        // chart=mostPopular has returned Trending Music/Movies/Gaming since
        // 21 Jul 2025 -- the wrong content entirely for short-form comedy.
        val http = okHttp()
        YouTubeShortsFeeler(http, credentials).fetch(config, window())

        val searchUrl = http.requestedUrls.single { it.contains("/search") }
        assertFalse(searchUrl.contains("chart="), "must not use the mostPopular chart")
        assertTrue(searchUrl.contains("videoDuration=short"))
        assertTrue(searchUrl.contains("order=viewCount"))
        assertTrue(searchUrl.contains("publishedAfter=2026-08-05T12%3A00%3A00Z") ||
            searchUrl.contains("publishedAfter=2026-08-05T12:00:00Z"), "24h window must be sent: $searchUrl")
    }

    @Test
    fun `spends exactly one metered search call per fetch`() = runTest {
        // search.list draws on a separate bucket capped at 100 calls/day, so the
        // second call must be the unmetered videos.list, not another search.
        val http = okHttp()
        YouTubeShortsFeeler(http, credentials).fetch(config, window())

        assertEquals(1, http.requestedUrls.count { it.contains("/search") })
        assertEquals(1, http.requestedUrls.count { it.contains("/videos") })
    }

    @Test
    fun `stands down cleanly when the daily search budget is spent`() = runTest {
        val http = okHttp()
        val exhausted = object : SearchBudget {
            override suspend fun trySpend() = false
        }

        val result = YouTubeShortsFeeler(http, credentials, exhausted).fetch(config, window())

        val unavailable = assertIs<FeelerResult.Unavailable>(result)
        assertTrue(unavailable.reason.contains("quota", ignoreCase = true))
        assertTrue(http.requestedUrls.isEmpty(), "must not spend a call it has no budget for")
    }

    @Test
    fun `reports unavailable without an API key`() = runTest {
        val keyless = object : Credentials {
            override fun youtubeApiKey() = null
            override fun redditClientId() = null
        }
        val result = YouTubeShortsFeeler(okHttp(), keyless).fetch(config, window())
        assertIs<FeelerResult.Unavailable>(result)
    }

    @Test
    fun `reports unavailable when YouTube rejects the key`() = runTest {
        val http = FakeHttp(routes = listOf("/youtube/v3/search" to HttpResponse(403, "quotaExceeded")))
        val result = YouTubeShortsFeeler(http, credentials).fetch(config, window())
        assertIs<FeelerResult.Unavailable>(result)
    }

    @Test
    fun `reports unavailable when nothing in the results was actually a Short`() = runTest {
        val onlyLongVideos = """
        {"items":[{"id":"notashort","snippet":{"title":"A long sketch about queueing",
          "publishedAt":"2026-08-06T08:00:00Z"},"contentDetails":{"duration":"PT3M30S"},
          "statistics":{"viewCount":"900000"}}]}
        """.trimIndent()
        val http = FakeHttp(
            routes = listOf(
                "/youtube/v3/search" to HttpResponse(200, """{"items":[{"id":{"videoId":"notashort"}}]}"""),
                "/youtube/v3/videos" to HttpResponse(200, onlyLongVideos),
            ),
        )
        val result = YouTubeShortsFeeler(http, credentials).fetch(config, window())
        assertIs<FeelerResult.Unavailable>(result)
    }
}
