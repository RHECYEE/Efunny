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
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The no-credentials tier. This is what a fresh install actually runs, so it
 * matters that it works before anyone has pasted a key.
 */
class RedditKeylessTest {

    private val config = SourceConfig(
        id = 2,
        type = SourceType.REDDIT,
        displayName = "r/funny",
        params = mapOf("subreddit" to "funny"),
    )

    private val noCredentials = object : Credentials {
        override fun youtubeApiKey() = null
        override fun redditClientId() = null
    }

    private val withClientId = object : Credentials {
        override fun youtubeApiKey() = null
        override fun redditClientId() = "abc123"
    }

    private fun fixture(): String =
        checkNotNull(javaClass.getResourceAsStream("/feeds/reddit-funny.xml")).readBytes()
            .toString(Charsets.UTF_8)

    /** The captured feed is from 2026-08-05, so the window has to reach it. */
    private fun window() = TimeWindow(
        from = Instant.parse("2026-08-04T00:00:00Z"),
        to = Instant.parse("2026-08-07T00:00:00Z"),
    )

    @Test
    fun `parses a real captured Reddit feed`() {
        val posts = RedditFeeler(FakeHttp(), noCredentials).parseRss(fixture(), config)

        assertTrue(posts.isNotEmpty(), "the captured feed has entries")
        posts.forEach { post ->
            assertTrue(post.title.isNotBlank())
            assertTrue(post.permalink.startsWith("https://www.reddit.com/r/"), post.permalink)
            assertNull(post.engagement, "Reddit's RSS carries no score or comment count")
        }
    }

    @Test
    fun `strips the t3 prefix so ids match the JSON API`() {
        // The Atom feed says "t3_1vg19z7"; the JSON API says "1vg19z7". If these
        // disagree, cross-drop dedup breaks the moment a user adds a client ID
        // and the same post comes back under a different identity.
        val posts = RedditFeeler(FakeHttp(), noCredentials).parseRss(fixture(), config)

        assertTrue(posts.none { it.externalId.startsWith("t3_") }, "ids should be bare")
        assertTrue(posts.all { it.externalId.isNotBlank() })
    }

    @Test
    fun `picks up thumbnails and authors`() {
        val posts = RedditFeeler(FakeHttp(), noCredentials).parseRss(fixture(), config)

        assertTrue(posts.any { it.thumbnailUrl != null }, "media:thumbnail should be read")
        assertTrue(posts.any { it.author?.contains("/u/") == true }, "author should be read")
    }

    @Test
    fun `uses the public feed when no client ID is set`() = runTest {
        val http = FakeHttp(routes = listOf("reddit.com" to HttpResponse(200, fixture())))

        val result = RedditFeeler(http, noCredentials).fetch(config, window())

        assertIs<FeelerResult.Success>(result)
        assertTrue(http.requestedUrls.single().contains("/r/funny/top/.rss"))
        assertTrue(http.requestedUrls.single().contains("t=day"), "Reddit does the 24h window")
        assertFalse(
            http.requestedUrls.any { it.contains("access_token") },
            "the keyless path must not try to authenticate",
        )
    }

    @Test
    fun `switches to the authenticated API once a client ID exists`() = runTest {
        val http = FakeHttp(
            routes = listOf(
                "access_token" to HttpResponse(200, """{"access_token":"t","expires_in":3600}"""),
                "oauth.reddit.com" to HttpResponse(200, """{"data":{"children":[]}}"""),
            ),
        )

        RedditFeeler(http, withClientId).fetch(config, window())

        assertTrue(http.requestedUrls.any { it.contains("oauth.reddit.com") }, "should use the JSON API")
        assertFalse(http.requestedUrls.any { it.contains(".rss") }, "should not fall back to RSS")
    }

    @Test
    fun `waits out the advertised rate limit and retries once`() = runTest {
        // Live Reddit answers a single unauthenticated call with
        // x-ratelimit-remaining 0.0 and a ~60s reset, so the retry has to read
        // the budget rather than guess a short backoff.
        var call = 0
        val http = object : com.rhecyee.efunny.core.net.Http {
            val urls = mutableListOf<String>()
            override suspend fun get(url: String, headers: Map<String, String>): HttpResponse {
                urls += url
                return if (call++ == 0) {
                    HttpResponse(429, "", mapOf("x-ratelimit-reset" to "53"))
                } else {
                    HttpResponse(200, fixture())
                }
            }

            override suspend fun postForm(
                url: String,
                form: Map<String, String>,
                headers: Map<String, String>,
            ) = HttpResponse(200, "")
        }

        val result = RedditFeeler(http, noCredentials).fetch(config, window())

        assertIs<FeelerResult.Success>(result)
        assertEquals(2, http.urls.size, "one retry after waiting out the limit")
    }

    @Test
    fun `names a 403 rather than calling it a rate limit`() = runTest {
        // Reddit hard-blocks generic user agents with a 403, which looks nothing
        // like throttling from the outside.
        val http = FakeHttp(routes = listOf("reddit.com" to HttpResponse(403, "")))

        val result = RedditFeeler(http, noCredentials).fetch(config, window())

        val unavailable = assertIs<FeelerResult.Unavailable>(result)
        assertTrue(unavailable.reason.contains("403"), unavailable.reason)
    }

    @Test
    fun `points at the client ID when still limited after the retry`() = runTest {
        val http = FakeHttp(routes = listOf("reddit.com" to HttpResponse(429, "")))

        val result = RedditFeeler(http, noCredentials).fetch(config, window())

        val unavailable = assertIs<FeelerResult.Unavailable>(result)
        assertTrue(unavailable.reason.contains("client ID"), unavailable.reason)
    }
}
