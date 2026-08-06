package com.rhecyee.efunny.core.feelers

import org.w3c.dom.Element
import java.io.ByteArrayInputStream
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import javax.xml.parsers.DocumentBuilderFactory

/**
 * Shared RSS 2.0 / Atom plumbing.
 *
 * Both the configurable-website feeler and Reddit's keyless path read feeds, and
 * neither should carry its own copy of the XXE hardening or the pile of date
 * formats real feeds emit.
 */
internal object XmlFeed {

    /** One `<item>` or `<entry>`, with helpers that only look at its own children. */
    class Entry(private val element: Element) {

        /**
         * `getElementsByTagName` searches descendants, so an `<author><name>`
         * could satisfy a lookup for a top-level tag. Restricting to direct
         * children keeps a nested element from impersonating one.
         */
        fun text(vararg tags: String): String? {
            for (tag in tags) {
                val nodes = element.getElementsByTagName(tag)
                for (i in 0 until nodes.length) {
                    val node = nodes.item(i)
                    if (node.parentNode != element) continue
                    val text = node.textContent?.trim().orEmpty()
                    if (text.isNotEmpty()) return text
                }
            }
            return null
        }

        fun attr(tag: String, attribute: String): String? {
            val nodes = element.getElementsByTagName(tag)
            for (i in 0 until nodes.length) {
                val node = nodes.item(i) as? Element ?: continue
                if (node.parentNode != element) continue
                val value = node.getAttribute(attribute)
                if (value.isNotBlank()) return value
            }
            return null
        }

        /** Atom puts the URL in `<link href>`; RSS puts it in the element text. */
        fun link(): String? = text("link") ?: attr("link", "href")
    }

    fun entries(xml: String): List<Entry> {
        val document = documentBuilder().parse(ByteArrayInputStream(xml.toByteArray(Charsets.UTF_8)))
        document.documentElement.normalize()

        val items = document.getElementsByTagName("item")
        val nodes = if (items.length > 0) items else document.getElementsByTagName("entry")

        return (0 until nodes.length).mapNotNull { (nodes.item(it) as? Element)?.let(::Entry) }
    }

    /**
     * Feeds are casual about dates. FML emits ISO-8601 where RSS 2.0 specifies
     * RFC-822, and plenty of feeds omit the zone entirely. Returns null rather
     * than throwing so a caller can skip one bad item instead of losing the feed.
     */
    fun parseDate(raw: String?): Instant? {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return null

        for (formatter in DATE_FORMATS) {
            try {
                return Instant.from(formatter.parse(text))
            } catch (_: Exception) {
                // Try the next format.
            }
        }
        // Zone-less local time: assume UTC rather than drop an otherwise-good item.
        return try {
            LocalDateTime.parse(text, DateTimeFormatter.ISO_LOCAL_DATE_TIME).toInstant(ZoneOffset.UTC)
        } catch (_: Exception) {
            null
        }
    }

    private val DATE_FORMATS = listOf(
        DateTimeFormatter.RFC_1123_DATE_TIME,   // what the RSS 2.0 spec asks for
        DateTimeFormatter.ISO_OFFSET_DATE_TIME, // what FML and Reddit actually emit
        DateTimeFormatter.ISO_INSTANT,
        DateTimeFormatter.ISO_ZONED_DATE_TIME,
        DateTimeFormatter.ofPattern("EEE, dd MMM yyyy HH:mm:ss zzz"),
        DateTimeFormatter.ofPattern("EEE, dd MMM yyyy HH:mm zzz"),
    )

    private fun documentBuilder() = DocumentBuilderFactory.newInstance().apply {
        // Feed URLs are user-configurable, so the parser must not be talked into
        // fetching entities off the network or the local filesystem.
        setFeatureQuietly("http://xml.org/sax/features/external-general-entities", false)
        setFeatureQuietly("http://xml.org/sax/features/external-parameter-entities", false)
        setFeatureQuietly("http://apache.org/xml/features/nonvalidating/load-external-dtd", false)
        isXIncludeAware = false
        isExpandEntityReferences = false
        isNamespaceAware = false
    }.newDocumentBuilder()

    private fun DocumentBuilderFactory.setFeatureQuietly(name: String, value: Boolean) {
        try {
            setFeature(name, value)
        } catch (_: Exception) {
            // Not every parser implementation knows every feature name.
        }
    }
}
