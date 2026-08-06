package com.rhecyee.efunny.core.model

import com.rhecyee.efunny.core.spotlight.SpotlightSpec
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DefaultSourcesTest {

    @Test
    fun `a fresh install has exactly enough enabled sources to fill a drop`() {
        // 7 enabled sources x 1 post each = the 7 in a drop; over 3 drops that is
        // the "3 each" from the brief and 21 for the day. If someone adds an
        // eighth enabled source, the arithmetic in the README stops being true.
        assertEquals(SpotlightSpec.POSTS_PER_DROP, DefaultSources.ENABLED.size)

        val perDrop = DefaultSources.ENABLED.sumOf { it.quotaPerDrop }
        assertEquals(SpotlightSpec.POSTS_PER_DROP, perDrop, "seeded quotas should sum to one drop")
    }

    @Test
    fun `the three closed platforms ship registered but disabled`() {
        val closed = DefaultSources.ALL.filter {
            it.type in setOf(SourceType.INSTAGRAM_REELS, SourceType.TIKTOK, SourceType.FACEBOOK_GROUP)
        }

        assertEquals(3, closed.size, "all three stay registered so the slot shape is documented")
        assertTrue(closed.none { it.enabled }, "none of them has an API to enable")
    }

    @Test
    fun `every enabled source carries the params its feeler needs`() {
        DefaultSources.ENABLED.forEach { source ->
            val required = when (source.type) {
                SourceType.RSS -> "url"
                SourceType.REDDIT -> "subreddit"
                SourceType.YOUTUBE_SHORTS -> "query"
                else -> null
            }
            if (required != null) {
                assertTrue(
                    source.params[required]?.isNotBlank() == true,
                    "${source.displayName} is missing its '$required' param",
                )
            }
        }
    }

    @Test
    fun `seeded feed URLs are absolute https`() {
        DefaultSources.ENABLED.filter { it.type == SourceType.RSS }.forEach { source ->
            val url = source.params.getValue("url")
            assertTrue(url.startsWith("https://"), "${source.displayName} should use https: $url")
        }
    }

    @Test
    fun `FML reads its content from the description`() {
        // Its <title> is a byline of some shape -- "By Anonymous",
        // "[spicy] | By Anonymous" -- so titles would make every card identical.
        val fml = DefaultSources.ALL.single { it.displayName == "FML" }
        assertEquals("description", fml.params["text"])
    }

    @Test
    fun `ids and positions are unique`() {
        assertEquals(DefaultSources.ALL.size, DefaultSources.ALL.map { it.id }.toSet().size)
        assertEquals(DefaultSources.ALL.size, DefaultSources.ALL.map { it.position }.toSet().size)
    }
}
