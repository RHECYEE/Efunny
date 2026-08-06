package com.rhecyee.efunny.core.feelers

import com.rhecyee.efunny.core.model.SourceConfig
import com.rhecyee.efunny.core.model.SourceType
import com.rhecyee.efunny.core.model.TimeWindow
import com.rhecyee.efunny.core.net.FakeHttp
import com.rhecyee.efunny.core.net.HttpResponse
import kotlinx.coroutines.test.runTest
import java.time.Instant
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

class RedditFeelerTest {

    private val config = SourceConfig(
        id = 2,
        type = SourceType.REDDIT,
        displayName = "r/funny",
        params = mapOf("subreddit" to "funny"),
    )

    private val credentials = object : Credentials {
        override fun youtubeApiKey() = null
        override fun redditClientId() = "test-client-id"
    }

    private val listing = """
    {"kind":"Listing","data":{"children":[
      {"kind":"t3","data":{"id":"aaa","title":"My cat has learned to open the fridge",
        "permalink":"/r/funny/comments/aaa/cat/","ups":5000,"num_comments":300,
        "created_utc":1785931200.0,"thumbnail":"https://b.thumbs.redditmedia.com/aaa.jpg",
        "author":"someone","stickied":false,"over_18":false}},
      {"kind":"t3","data":{"id":"bbb","title":"Monthly moderator announcement thread",
        "permalink":"/r/funny/comments/bbb/mod/","ups":90000,"num_comments":10,
        "created_utc":1785931200.0,"author":"mod","stickied":true,"over_18":false}},
      {"kind":"t3","data":{"id":"ccc","title":"Something rather more adult in nature",
        "permalink":"/r/funny/comments/ccc/nsfw/","ups":8000,"num_comments":100,
        "created_utc":1785931200.0,"author":"other","stickied":false,"over_18":true}},
      {"kind":"t3","data":{"id":"ddd","title":"The dog reviewed my cooking and left one star",
        "permalink":"/r/funny/comments/ddd/dog/","ups":1000,"num_comments":50,
        "created_utc":1785931200.0,"author":"third","stickied":false,"over_18":false}}
    ]}}
    """.trimIndent()

    private fun feeler(http: FakeHttp) = RedditFeeler(http, credentials)

    private fun okHttp() = FakeHttp(
        routes = listOf(
            "access_token" to HttpResponse(200, """{"access_token":"tok","token_type":"bearer","expires_in":86400}"""),
            "oauth.reddit.com" to HttpResponse(200, listing),
        ),
    )

    private fun window() = TimeWindow(
        from = Instant.parse("2026-08-05T00:00:00Z"),
        to = Instant.parse("2026-08-07T00:00:00Z"),
    )

    @Test
    fun `weights comments above upvotes when scoring engagement`() {
        val posts = feeler(okHttp()).parse(listing, config, allowNsfw = false)
        val cat = posts.single { it.externalId == "aaa" }

        assertEquals(5000 + 2.0 * 300, cat.engagement, "ups + 2 x comments")
        assertEquals("https://www.reddit.com/r/funny/comments/aaa/cat/", cat.permalink)
        assertEquals("someone", cat.author)
    }

    @Test
    fun `drops stickied moderator posts despite their huge scores`() {
        // A pinned announcement outranks everything on raw upvotes but is not
        // trending -- it is just permanently first.
        val posts = feeler(okHttp()).parse(listing, config, allowNsfw = false)

        assertFalse(posts.any { it.externalId == "bbb" }, "stickied posts are not trends")
    }

    @Test
    fun `filters NSFW by default and admits it when asked`() {
        val clean = feeler(okHttp()).parse(listing, config, allowNsfw = false)
        assertFalse(clean.any { it.externalId == "ccc" })

        val permissive = feeler(okHttp()).parse(listing, config, allowNsfw = true)
        assertTrue(permissive.any { it.externalId == "ccc" })
    }

    @Test
    fun `authenticates with installed_client and never sends a secret`() = runTest {
        val http = okHttp()
        feeler(http).fetch(config, window())

        val form = http.sentForms.single()
        assertEquals("https://oauth.reddit.com/grants/installed_client", form["grant_type"])
        assertEquals("DO_NOT_TRACK_THIS_DEVICE", form["device_id"])
        assertFalse(form.keys.any { it.contains("secret") }, "installed apps have no client secret to send")

        // Basic auth is "<clientId>:" -- an empty password, which is what makes
        // this flow safe to ship inside an APK.
        val auth = http.sentHeaders.first { it.containsKey("Authorization") }["Authorization"]!!
        val decoded = String(Base64.getDecoder().decode(auth.removePrefix("Basic ")))
        assertEquals("test-client-id:", decoded)
    }

    @Test
    fun `asks Reddit for the last day directly`() = runTest {
        val http = okHttp()
        feeler(http).fetch(config, window())

        val listingUrl = http.requestedUrls.single { it.contains("oauth.reddit.com") }
        assertTrue(listingUrl.contains("/r/funny/top"), "should hit the subreddit's top listing")
        assertTrue(listingUrl.contains("t=day"), "Reddit does the 24h window server-side")
    }

    @Test
    fun `reuses its token across calls`() = runTest {
        val http = okHttp()
        val feeler = feeler(http)
        feeler.fetch(config, window())
        feeler.fetch(config, window())

        assertEquals(1, http.requestedUrls.count { it.contains("access_token") }, "token should be cached")
    }

    @Test
    fun `reports rate limiting rather than failing silently`() = runTest {
        val http = FakeHttp(
            routes = listOf(
                "access_token" to HttpResponse(200, """{"access_token":"tok","expires_in":86400}"""),
                "oauth.reddit.com" to HttpResponse(429, ""),
            ),
        )
        val result = feeler(http).fetch(config, window())
        val unavailable = assertIs<FeelerResult.Unavailable>(result)
        assertTrue(unavailable.reason.contains("Rate limited"))
    }

    @Test
    fun `reports unavailable without a client ID`() = runTest {
        val anonymous = object : Credentials {
            override fun youtubeApiKey() = null
            override fun redditClientId() = null
        }
        val result = RedditFeeler(okHttp(), anonymous).fetch(config, window())
        assertIs<FeelerResult.Unavailable>(result)
    }

    @Test
    fun `reports unavailable when no subreddit is configured`() = runTest {
        val result = feeler(okHttp()).fetch(config.copy(params = emptyMap()), window())
        assertIs<FeelerResult.Unavailable>(result)
    }

    @Test
    fun `accepts a subreddit written with the r slash prefix`() = runTest {
        val http = okHttp()
        feeler(http).fetch(config.copy(params = mapOf("subreddit" to "r/memes")), window())

        assertTrue(http.requestedUrls.any { it.contains("/r/memes/top") }, "the prefix should be tolerated")
    }
}
