package com.rhecyee.efunny.core.feelers

import com.rhecyee.efunny.core.model.SourceConfig
import com.rhecyee.efunny.core.model.SourceType
import com.rhecyee.efunny.core.model.TimeWindow
import com.rhecyee.efunny.core.net.FakeHttp
import kotlinx.coroutines.test.runTest
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.test.assertIs

class RssFeelerTest {

    private val fmlConfig = SourceConfig(
        id = 4,
        type = SourceType.RSS,
        displayName = "FML",
        // FML's <title> is a byline; the joke lives in <description>.
        params = mapOf("url" to "https://www.fmylife.com/rss", "text" to "description"),
    )

    private fun fixture(name: String): String =
        checkNotNull(javaClass.getResourceAsStream("/feeds/$name")) { "missing fixture $name" }
            .readBytes().toString(Charsets.UTF_8)

    @Test
    fun `parses the live FML feed captured from fmylife dot com`() {
        val posts = RssFeeler(FakeHttp()).parse(fixture("fml.xml"), fmlConfig)

        assertEquals(20, posts.size, "the real feed carries 20 items")
        posts.forEach { post ->
            assertTrue(post.title.isNotBlank(), "every post needs text")
            assertTrue(post.permalink.startsWith("http"), "permalink should be absolute: ${post.permalink}")
            assertEquals(null, post.engagement, "RSS carries no engagement signal")
        }
    }

    @Test
    fun `text mode description pulls the joke out of a byline feed`() {
        // Every FML <title> is a byline of some shape -- "By Anonymous",
        // "[spicy] | By Anonymous", "By that's a low blow bro". Taking titles
        // verbatim would make every FML card read the same, so the seeded
        // config asks for descriptions instead.
        val posts = RssFeeler(FakeHttp()).parse(fixture("fml.xml"), fmlConfig)

        assertTrue(
            posts.none { it.title.contains("By Anonymous") },
            "descriptions should have replaced the bylines entirely",
        )
        assertTrue(
            posts.all { it.title.startsWith("Today") },
            "every FML entry opens with 'Today,'",
        )
    }

    @Test
    fun `reads ISO-8601 pubDate even though RSS specifies RFC-822`() {
        // FML emits 2026-08-06T03:00:00+02:00 where the spec calls for
        // "Thu, 06 Aug 2026 03:00:00 +0200". A strict RFC-822 parser drops
        // every item in the feed.
        val posts = RssFeeler(FakeHttp()).parse(fixture("fml.xml"), fmlConfig)
        assertEquals(20, posts.size)
        assertTrue(posts.all { it.publishedAt.isAfter(Instant.parse("2020-01-01T00:00:00Z")) })
    }

    @Test
    fun `reads RFC-822 dates and Atom entries`() {
        val rss = """
            <rss version="2.0"><channel>
              <item>
                <title>A perfectly good joke about databases</title>
                <link>https://example.com/1</link>
                <pubDate>Thu, 06 Aug 2026 03:00:00 +0200</pubDate>
              </item>
            </channel></rss>
        """.trimIndent()
        val atom = """
            <feed xmlns="http://www.w3.org/2005/Atom">
              <entry>
                <title>An equally good joke about compilers</title>
                <link href="https://example.com/2"/>
                <updated>2026-08-06T01:00:00Z</updated>
                <id>tag:example.com,2026:2</id>
              </entry>
            </feed>
        """.trimIndent()

        val feeler = RssFeeler(FakeHttp())
        assertEquals(1, feeler.parse(rss, fmlConfig).size)

        val atomPosts = feeler.parse(atom, fmlConfig)
        assertEquals(1, atomPosts.size)
        assertEquals("https://example.com/2", atomPosts.single().permalink, "Atom links live in @href")
    }

    @Test
    fun `skips only the unparseable item rather than failing the feed`() {
        val mixed = """
            <rss version="2.0"><channel>
              <item>
                <title>This one has a date we can actually read</title>
                <link>https://example.com/good</link>
                <pubDate>2026-08-06T03:00:00Z</pubDate>
              </item>
              <item>
                <title>This one's date is complete nonsense</title>
                <link>https://example.com/bad</link>
                <pubDate>last Tuesday-ish</pubDate>
              </item>
            </channel></rss>
        """.trimIndent()

        val posts = RssFeeler(FakeHttp()).parse(mixed, fmlConfig)
        assertEquals(1, posts.size, "one bad date must not discard the good item")
        assertEquals("https://example.com/good", posts.single().permalink)
    }

    @Test
    fun `reports unavailable instead of throwing when the feed is unreachable`() = runTest {
        val result = RssFeeler(FakeHttp(code = 503)).fetch(fmlConfig, window())
        val unavailable = assertIs<FeelerResult.Unavailable>(result)
        assertTrue(unavailable.reason.contains("503"), "reason should name the failure: ${unavailable.reason}")
    }

    @Test
    fun `reports unavailable when no URL is configured`() = runTest {
        val result = RssFeeler(FakeHttp()).fetch(fmlConfig.copy(params = emptyMap()), window())
        assertIs<FeelerResult.Unavailable>(result)
    }

    @Test
    fun `reports unavailable for an empty feed`() = runTest {
        val empty = """<rss version="2.0"><channel><title>Nothing here</title></channel></rss>"""
        val result = RssFeeler(FakeHttp(body = empty)).fetch(fmlConfig, window())
        assertIs<FeelerResult.Unavailable>(result)
    }

    @Test
    fun `drops items published outside the lookback window`() = runTest {
        val feed = """
            <rss version="2.0"><channel>
              <item>
                <title>Recent enough to count for this drop</title>
                <link>https://example.com/new</link>
                <pubDate>2026-08-06T00:00:00Z</pubDate>
              </item>
              <item>
                <title>Far too old to be trending right now</title>
                <link>https://example.com/old</link>
                <pubDate>2026-07-01T00:00:00Z</pubDate>
              </item>
            </channel></rss>
        """.trimIndent()

        val result = RssFeeler(FakeHttp(body = feed)).fetch(fmlConfig, window())
        val success = assertIs<FeelerResult.Success>(result)
        assertEquals(1, success.posts.size)
        assertEquals("https://example.com/new", success.posts.single().permalink)
    }

    @Test
    fun `honours an explicit text mode override`() {
        val feed = """
            <rss version="2.0"><channel>
              <item>
                <title>Short</title>
                <description>A much longer description that auto mode would prefer</description>
                <link>https://example.com/1</link>
                <pubDate>2026-08-06T03:00:00Z</pubDate>
              </item>
            </channel></rss>
        """.trimIndent()

        val forced = fmlConfig.copy(params = fmlConfig.params + ("text" to "title"))
        val post = RssFeeler(FakeHttp()).parse(feed, forced).single()
        assertEquals("Short", post.title)
        assertNotNull(post.externalId)
    }

    private fun window() = TimeWindow(
        from = Instant.parse("2026-08-05T12:00:00Z"),
        to = Instant.parse("2026-08-06T12:00:00Z"),
    )
}
