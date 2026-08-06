package com.rhecyee.efunny.core.feelers

import com.rhecyee.efunny.core.model.RawPost
import com.rhecyee.efunny.core.model.SourceConfig
import com.rhecyee.efunny.core.model.SourceType
import com.rhecyee.efunny.core.model.TimeWindow
import com.rhecyee.efunny.core.net.Http
import com.rhecyee.efunny.core.net.HttpFailure
import org.w3c.dom.Element
import org.w3c.dom.Node
import java.io.ByteArrayInputStream
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import javax.xml.parsers.DocumentBuilderFactory

/**
 * The generic configurable-website feeler: give it any RSS 2.0 or Atom URL and it
 * becomes a source. This is what makes "configurable websites like FML" a
 * settings row rather than a code change.
 *
 * Feeds carry no engagement data, so [RawPost.engagement] is left null and these
 * posts rank on recency alone. The UI labels them "Latest" rather than
 * "Trending", because claiming a trend signal that the format cannot provide
 * would be a lie about the data.
 *
 * Recognised [SourceConfig.params]:
 *  - `url` (required) -- the feed
 *  - `text` -- `title` (default) or `description`; see [pickText]
 */
class RssFeeler(private val http: Http) : Feeler {

    override val type = SourceType.RSS

    override suspend fun fetch(config: SourceConfig, window: TimeWindow): FeelerResult {
        val url = config.params["url"]?.trim().orEmpty()
        if (url.isEmpty()) return FeelerResult.Unavailable("No feed URL configured")

        val response = try {
            http.get(url, mapOf("Accept" to "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8"))
        } catch (e: HttpFailure) {
            return FeelerResult.Unavailable("Network error: ${e.message}")
        }
        if (!response.isSuccess) return FeelerResult.Unavailable("Feed returned HTTP ${response.code}")

        val items = try {
            parse(response.body, config)
        } catch (e: Exception) {
            return FeelerResult.Unavailable("Could not parse feed: ${e.message}")
        }

        if (items.isEmpty()) return FeelerResult.Unavailable("Feed had no readable items")
        return FeelerResult.Success(items.filter { it.publishedAt in window })
    }

    internal fun parse(xml: String, config: SourceConfig): List<RawPost> {
        val document = documentBuilder().parse(ByteArrayInputStream(xml.toByteArray(Charsets.UTF_8)))
        document.documentElement.normalize()

        // RSS 2.0 uses <item>, Atom uses <entry>. Reading both means one adapter
        // covers effectively every feed a user is likely to paste in.
        val nodes = document.getElementsByTagName("item").asList()
            .ifEmpty { document.getElementsByTagName("entry").asList() }

        return nodes.mapNotNull { node -> toPost(node as? Element ?: return@mapNotNull null, config) }
    }

    private fun toPost(element: Element, config: SourceConfig): RawPost? {
        // A single item with a date this parser cannot read must not take the
        // whole feed down with it -- skip the item, keep the rest.
        val published = parseDate(
            firstText(element, "pubDate")
                ?: firstText(element, "published")
                ?: firstText(element, "updated")
                ?: firstText(element, "date")
                ?: firstText(element, "dc:date")
                ?: return null
        ) ?: return null

        val link = firstText(element, "link")
            ?: attributeOfChild(element, "link", "href")
            ?: firstText(element, "guid")
            ?: return null

        val title = pickText(
            title = firstText(element, "title").orEmpty(),
            description = firstText(element, "description")
                ?: firstText(element, "summary")
                ?: firstText(element, "content")
                ?: "",
            mode = config.params["text"] ?: "title",
        )
        if (title.isBlank()) return null

        return RawPost(
            sourceConfigId = config.id,
            externalId = firstText(element, "guid") ?: firstText(element, "id") ?: link,
            title = title,
            permalink = link,
            publishedAt = published,
            engagement = null, // feeds carry no engagement signal
            author = firstText(element, "author") ?: firstText(element, "dc:creator"),
        )
    }

    /**
     * Some feeds put the content in `<title>`; others use the title as a byline
     * and put the actual content in `<description>`. FML is the second kind, so
     * its seeded config sets `text=description`.
     *
     * This is a config switch rather than a guess on purpose. An earlier version
     * inferred it from title length, which the real FML feed promptly broke:
     * most of its titles are a bare "By Anonymous", but some read
     * "[spicy] | By Anonymous" or "By that's a low blow bro" -- long enough to
     * look like content while still being a byline. Nothing in the markup
     * separates the two cases, so the user's config decides and the parser does
     * as it is told.
     */
    private fun pickText(title: String, description: String, mode: String): String = when (mode) {
        "description" -> description.ifBlank { title }
        else -> title.ifBlank { description }
    }

    private fun parseDate(raw: String): Instant? {
        val text = raw.trim()
        if (text.isEmpty()) return null

        for (formatter in DATE_FORMATS) {
            try {
                return Instant.from(formatter.parse(text))
            } catch (_: Exception) {
                // Try the next format.
            }
        }
        // Last resort: a local date-time with no zone. Assume UTC rather than
        // dropping an otherwise-good item.
        return try {
            LocalDateTime.parse(text, DateTimeFormatter.ISO_LOCAL_DATE_TIME).toInstant(ZoneOffset.UTC)
        } catch (_: Exception) {
            null
        }
    }

    private fun firstText(element: Element, tag: String): String? {
        val nodes = element.getElementsByTagName(tag)
        for (i in 0 until nodes.length) {
            val node = nodes.item(i)
            // getElementsByTagName is recursive, so an <author><name> inside a
            // nested element could match; only direct-ish children are wanted.
            if (node.parentNode != element) continue
            val text = node.textContent?.trim().orEmpty()
            if (text.isNotEmpty()) return text
        }
        return null
    }

    private fun attributeOfChild(element: Element, tag: String, attribute: String): String? {
        val nodes = element.getElementsByTagName(tag)
        for (i in 0 until nodes.length) {
            val node = nodes.item(i) as? Element ?: continue
            if (node.parentNode != element) continue
            val value = node.getAttribute(attribute)
            if (value.isNotBlank()) return value
        }
        return null
    }

    private fun org.w3c.dom.NodeList.asList(): List<Node> = (0 until length).map { item(it) }

    private companion object {
        val DATE_FORMATS = listOf(
            DateTimeFormatter.RFC_1123_DATE_TIME,      // the RSS 2.0 spec format
            DateTimeFormatter.ISO_OFFSET_DATE_TIME,    // what FML actually emits
            DateTimeFormatter.ISO_INSTANT,
            DateTimeFormatter.ISO_ZONED_DATE_TIME,
            DateTimeFormatter.ofPattern("EEE, dd MMM yyyy HH:mm:ss zzz"),
            DateTimeFormatter.ofPattern("EEE, dd MMM yyyy HH:mm zzz"),
        )

        fun documentBuilder() = DocumentBuilderFactory.newInstance().apply {
            // Feed URLs are user-configurable, so the parser must not be talked
            // into fetching entities off the network or the local filesystem.
            setFeatureQuietly("http://xml.org/sax/features/external-general-entities", false)
            setFeatureQuietly("http://xml.org/sax/features/external-parameter-entities", false)
            setFeatureQuietly("http://apache.org/xml/features/nonvalidating/load-external-dtd", false)
            isXIncludeAware = false
            isExpandEntityReferences = false
            isNamespaceAware = false
        }.newDocumentBuilder()

        fun DocumentBuilderFactory.setFeatureQuietly(name: String, value: Boolean) {
            try {
                setFeature(name, value)
            } catch (_: Exception) {
                // Not every parser implementation knows every feature name.
            }
        }
    }
}
