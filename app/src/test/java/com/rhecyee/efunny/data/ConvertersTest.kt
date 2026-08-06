package com.rhecyee.efunny.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ConvertersTest {

    private val converters = Converters()

    @Test
    fun `round-trips source params`() {
        val params = mapOf("url" to "https://www.fmylife.com/rss", "text" to "description")

        val restored = converters.jsonToParams(converters.paramsToJson(params))

        assertEquals(params, restored)
    }

    @Test
    fun `round-trips a URL containing characters that need escaping`() {
        val params = mapOf("query" to "#shorts funny & \"quoted\"", "url" to "https://x.test/a?b=1&c=2")

        val restored = converters.jsonToParams(converters.paramsToJson(params))

        assertEquals(params, restored)
    }

    @Test
    fun `empty params survive the trip`() {
        assertEquals(emptyMap<String, String>(), converters.jsonToParams(converters.paramsToJson(emptyMap())))
    }

    @Test
    fun `a corrupt row costs that source its settings rather than crashing the app`() {
        // Room hands back whatever is in the column. Throwing here would take the
        // whole database read down on launch.
        assertEquals(emptyMap<String, String>(), converters.jsonToParams("{not json at all"))
        assertEquals(emptyMap<String, String>(), converters.jsonToParams(null))
        assertEquals(emptyMap<String, String>(), converters.jsonToParams(""))
    }

    @Test
    fun `null params serialise to an empty object rather than the string null`() {
        val json = converters.paramsToJson(null)
        assertTrue("expected an empty JSON object but got: $json", json == "{}")
    }
}
